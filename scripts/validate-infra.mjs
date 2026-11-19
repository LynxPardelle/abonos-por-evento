import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

// Public managed policy identities confirmed against the CloudFront API on 2026-11-19:
// aws cloudfront list-cache-policies --type managed
// aws cloudfront list-origin-request-policies --type managed
const noCache = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const forwardAuthorization = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const knownCachePolicyIds = new Set([noCache, '658327ea-f89d-4fab-a63d-7e88639e58f6']);

// Offline checks for architectural and security contracts; cfn-lint validates the AWS schemas separately.
export function validateInfrastructure(template) {
  const errors = [];
  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const resources = template?.Resources ?? {};
  const properties = (name) => resources[name]?.Properties ?? {};
  const api = properties('BusinessApi');
  const client = properties('UserPoolClient');
  const distribution = properties('FrontendDistribution').DistributionConfig ?? {};
  const functions = [
    'EventsFunction',
    'ReconciliationFunction',
    'ImportWorkerFunction',
    'FrontendFunction',
    'IdentityConfirmationFunction',
    'IdentityTokenFunction',
    'IdentityResolverFunction',
    'IdentityHttpFunction',
    'IdentityAdminFunction',
  ];
  for (const name of functions)
    require(resources[name]?.Type ===
      'AWS::Serverless::Function', `${name} must be a separate Lambda.`);
  require(template?.Globals?.Function?.Runtime ===
    'nodejs24.x', 'Lambdas must use the supported Node.js 24 runtime.');
  require(api.Auth?.DefaultAuthorizer ===
    'CognitoJwt', 'Business API must require JWT by default.');
  const manualPayment = Object.values(properties('ReconciliationFunction').Events ?? {}).find(
    (event) =>
      event.Properties?.Path === '/api/v1/events/{eventId}/payments' &&
      event.Properties.Method === 'POST',
  );
  require(manualPayment &&
    manualPayment.Properties.ApiId?.Ref === 'BusinessApi' &&
    !['NONE', 'AWS_IAM'].includes(
      manualPayment.Properties.Auth?.Authorizer,
    ), 'Manual payments must use the JWT-authenticated business API.');
  require(properties('HealthFunction').Events?.HealthRoute?.Properties?.Auth?.Authorizer ===
    'NONE', 'Health endpoint must explicitly remain public.');
  require(template?.Parameters?.SelfRegistrationEnabled?.Default ===
    'false', 'Self-registration must stay disabled until its environment explicitly enables it.');
  require(JSON.stringify(properties('UserPool').AdminCreateUserConfig?.AllowAdminCreateUserOnly) ===
    JSON.stringify({
      'Fn::If': ['SelfRegistrationAllowed', false, true],
    }), 'Self-registration must follow its explicit environment condition.');
  const identityConfiguration = properties('UserPool').LambdaConfig ?? {};
  require(identityConfiguration.PostConfirmation?.['Fn::GetAtt']?.[0] ===
    'IdentityConfirmationFunction', 'Registration must provision membership after Cognito confirmation.');
  require(identityConfiguration.PreTokenGenerationConfig?.LambdaVersion === 'V1_0' &&
    identityConfiguration.PreTokenGenerationConfig?.LambdaArn?.['Fn::GetAtt']?.[0] ===
      'IdentityTokenFunction', 'The pre-token trigger must issue server-owned ID claims through V1_0.');
  for (const name of ['IdentityConfirmationFunction', 'IdentityTokenFunction']) {
    require(properties(name).Environment?.Variables?.IDENTITY_TABLE?.Ref ===
      'IdentityTable', `${name} must own membership in the Identity table.`);
    const permission = properties(`${name}Permission`);
    require(permission.Principal === 'cognito-idp.amazonaws.com' &&
      permission.SourceArn?.['Fn::GetAtt']?.[0] === 'UserPool' &&
      permission.SourceAccount?.Ref ===
        'AWS::AccountId', `${name} must have source-scoped Cognito invocation permission.`);
    const policy = JSON.stringify(properties(name).Policies);
    require(!policy.includes('EventsTable') &&
      !policy.includes('ReconciliationTable') &&
      !policy.includes(
        'cognito-idp:AdminUpdateUserAttributes',
      ), `${name} must not gain business storage or user-attribute administration rights.`);
  }
  require(Array.isArray(client.WriteAttributes) &&
    !client.WriteAttributes.some((attribute) =>
      attribute.startsWith('custom:'),
    ), 'Authorization custom claims must never be user-writable.');
  require(client.ReadAttributes?.includes('custom:organizationId') &&
    client.ReadAttributes?.includes(
      'custom:roles',
    ), 'Identity token must expose the organization and role claims.');

  const statements = (name) =>
    (properties(name).Policies ?? []).flatMap((policy) => policy.Statement ?? []);
  const actions = (statement) => [].concat(statement.Action ?? []);
  const tableArn = (name) => ({ 'Fn::GetAtt': [name, 'Arn'] });
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const targets = (statement, name) => equal(statement.Resource, tableArn(name));
  const grants = (name, action, resource) =>
    statements(name).some(
      (statement) =>
        statement.Effect === 'Allow' &&
        actions(statement).includes(action) &&
        targets(statement, resource),
    );
  const ownDataActions = new Set([
    'dynamodb:GetItem',
    'dynamodb:Query',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:ConditionCheckItem',
  ]);
  const identityServices = [
    [
      'IdentityResolverFunction',
      'identity-resolver',
      'identity/resolver.handler',
      'IdentityResolverLogGroup',
    ],
    ['IdentityHttpFunction', 'identity-http', 'identity/http.handler', 'IdentityHttpLogGroup'],
    ['IdentityAdminFunction', 'identity-admin', 'identity/admin.handler', 'IdentityAdminLogGroup'],
  ];
  for (const [name, suffix, handler, log] of identityServices) {
    const service = properties(name);
    require(service.Handler === handler &&
      service.CodeUri === '../services/' &&
      equal(service.FunctionName, {
        'Fn::Sub': `saldoevento-\${Stage}-${suffix}`,
      }), `${name} must have a stable isolated identity handler and function name.`);
    require(service.Environment?.Variables?.IDENTITY_TABLE?.Ref === 'IdentityTable' &&
      service.Environment?.Variables?.USER_POOL_ID?.Ref ===
        'UserPool', `${name} must bind its own table and pool.`);
    require(service.LoggingConfig?.LogFormat === 'JSON' &&
      service.LoggingConfig?.LogGroup?.Ref === log &&
      resources[log]?.Type === 'AWS::Logs::LogGroup' &&
      properties(log).RetentionInDays === 14, `${name} must have its dedicated 14-day log group.`);
    require(!service.Role &&
      Array.isArray(service.Policies) &&
      service.Policies.every(
        (policy) => policy && Array.isArray(policy.Statement),
      ), `${name} must use its explicit bounded SAM policies.`);
  }
  const resolver = properties('IdentityResolverFunction');
  const resolverStatements = statements('IdentityResolverFunction');
  require(resolverStatements.length > 0 &&
    resolverStatements.every(
      (statement) =>
        statement.Effect === 'Allow' &&
        targets(statement, 'IdentityTable') &&
        actions(statement).length > 0 &&
        actions(statement).every((action) =>
          ['dynamodb:GetItem', 'dynamodb:Query'].includes(action),
        ),
    ), 'Identity resolver must remain read-only on its own table.');
  require(grants('IdentityResolverFunction', 'dynamodb:GetItem', 'IdentityTable') &&
    grants(
      'IdentityResolverFunction',
      'dynamodb:Query',
      'IdentityTable',
    ), 'Identity resolver must read current membership and plans consistently through its table.');
  require(!resolver.Events &&
    !resolver.FunctionUrlConfig &&
    !JSON.stringify(resolver.Environment ?? {}).includes(
      'Events',
    ), 'Identity resolver must have no public exposure or dependency back to Events.');

  const administrator = properties('IdentityAdminFunction');
  require(!administrator.Events &&
    !administrator.FunctionUrlConfig, 'Identity administrator must have no public HTTP route or Function URL.');
  for (const resource of Object.values(resources)) {
    if (resource.Type === 'AWS::Lambda::Permission') {
      const target = JSON.stringify(resource.Properties?.FunctionName ?? '');
      require(!/IdentityAdminFunction|identity-admin/.test(
        target,
      ), 'Identity administrator must not gain a public or resource-based invocation permission.');
      require(!/IdentityResolverFunction|identity-resolver/.test(
        target,
      ), 'Identity resolver must remain IAM-only without resource-based invocation permissions.');
    }
  }
  for (const name of ['IdentityHttpFunction', 'IdentityAdminFunction']) {
    const service = properties(name);
    if (name === 'IdentityAdminFunction') {
      require(service.Environment?.Variables?.EVENTS_TABLE?.Ref === 'EventsTable' &&
        service.Environment?.Variables?.EVENTS_FUNCTION_NAME?.Ref === 'EventsFunction' &&
        grants(name, 'lambda:InvokeFunction', 'EventsFunction'), 'Identity administrator must read event usage through the service boundary.');
    } else {
      require(!service.Environment?.Variables?.EVENTS_TABLE &&
        !service.Environment?.Variables?.EVENTS_FUNCTION_NAME, 'Public Identity service must have no unused Events dependency.');
    }
    require(grants(name, 'dynamodb:PutItem', 'IdentityTable'), `${name} must retain its own Identity writes.`);
    require(statements(name).every(
      (statement) =>
        statement.Effect === 'Allow' &&
        ((targets(statement, 'IdentityTable') &&
          actions(statement).every((action) => ownDataActions.has(action))) ||
          (name === 'IdentityAdminFunction' && targets(statement, 'EventsFunction') &&
            equal(actions(statement), ['lambda:InvokeFunction'])) ||
          (name === 'IdentityAdminFunction' &&
            targets(statement, 'EventsTable') &&
            equal(actions(statement), ['dynamodb:ConditionCheckItem']))),
    ), `${name} must not gain cross-domain writes or unbounded permissions.`);
  }
  require(grants(
    'IdentityAdminFunction',
    'dynamodb:ConditionCheckItem',
    'EventsTable',
  ), 'Identity administrator must condition-check Events quota when granting a plan.');
  require(template?.Outputs?.IdentityAdminFunctionName?.Value?.Ref ===
    'IdentityAdminFunction', 'The guarded IAM grant CLI must receive IdentityAdminFunctionName.');
  for (const name of ['EventsFunction', 'ReconciliationFunction']) {
    const service = properties(name);
    require(service.Environment?.Variables?.IDENTITY_TABLE?.Ref === 'IdentityTable' &&
      service.Environment?.Variables?.USER_POOL_ID?.Ref === 'UserPool' &&
      service.Environment?.Variables?.IDENTITY_RESOLVER_FUNCTION_NAME?.Ref ===
        'IdentityResolverFunction', `${name} must bind the current identity resolver environment.`);
    const identityStatements = statements(name).filter((statement) =>
      JSON.stringify(statement.Resource).includes('IdentityTable'),
    );
    require(identityStatements.length > 0 &&
      identityStatements.every(
        (statement) =>
          statement.Effect === 'Allow' &&
          targets(statement, 'IdentityTable') &&
          equal(actions(statement), ['dynamodb:ConditionCheckItem']),
      ), `${name} may only condition-check Identity metadata, never write it.`);
    require(grants(
      name,
      'lambda:InvokeFunction',
      'IdentityResolverFunction',
    ), `${name} must resolve current access through the read-only resolver.`);
    const owned = name === 'EventsFunction' ? 'EventsTable' : 'ReconciliationTable';
    require(statements(name)
      .filter((statement) => actions(statement).some((action) => action.startsWith('dynamodb:')))
      .every(
        (statement) =>
          targets(statement, owned) ||
          (targets(statement, 'IdentityTable') &&
            equal(actions(statement), ['dynamodb:ConditionCheckItem'])),
      ), `${name} must not gain cross-domain DynamoDB writes.`);
  }
  const workerIdentity = JSON.stringify({
    environment: properties('ImportWorkerFunction').Environment,
    policies: properties('ImportWorkerFunction').Policies,
  });
  require(!/IdentityTable|IdentityResolverFunction|IDENTITY_TABLE|IDENTITY_RESOLVER_FUNCTION_NAME|USER_POOL_ID/.test(
    workerIdentity,
  ), 'Import worker must not resolve user identity or acquire Identity table rights.');

  const tierRoutes = {
    IdentityHttpFunction: [
      'GET /api/v1/me',
      'GET /api/v1/organizations/current/members',
      'POST /api/v1/organizations/current/members/{memberId}/role',
      'POST /api/v1/organizations/current/members/{memberId}/revoke',
    ],
    EventsFunction: [
      'GET /api/v1/templates',
      'GET /api/v1/templates/{templateId}',
      'POST /api/v1/templates',
      'POST /api/v1/templates/{templateId}/events',
    ],
    ReconciliationFunction: [
      'GET /api/v1/overview',
      'GET /api/v1/events/{eventId}/closing',
      'POST /api/v1/events/{eventId}/closing',
      'POST /api/v1/events/{eventId}/reopen',
      'POST /api/v1/events/{eventId}/archive',
      'GET /api/v1/events/{eventId}/report',
      'GET /api/v1/events/{eventId}/report/{closureId}',
    ],
  };
  for (const [name, expected] of Object.entries(tierRoutes)) {
    const events = Object.values(properties(name).Events ?? {});
    const routeKeys = events.map(
      (event) => `${event.Properties?.Method} ${event.Properties?.Path}`,
    );
    require(expected.every((route) =>
      routeKeys.includes(route),
    ), `${name} must expose every approved tier route.`);
    require(events.every(
      (event) =>
        event.Type === 'HttpApi' &&
        event.Properties?.ApiId?.Ref === 'BusinessApi' &&
        [undefined, 'CognitoJwt'].includes(event.Properties?.Auth?.Authorizer),
    ), `${name} tier routes must retain the JWT-authenticated business API.`);
  }
  require(api.CorsConfiguration?.AllowHeaders?.includes('x-saldoevento-organization') &&
    !api.CorsConfiguration?.AllowOrigins?.includes(
      '*',
    ), 'The organization selection header must be allowed by CORS without a wildcard origin.');
  const adminPasswordCondition = {
    'Fn::If': ['IsNonProduction', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', { Ref: 'AWS::NoValue' }],
  };
  require(equal(template?.Conditions?.IsNonProduction, {
    'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] }],
  }) &&
    Array.isArray(client.ExplicitAuthFlows) &&
    client.ExplicitAuthFlows.some((flow) => equal(flow, adminPasswordCondition)) &&
    client.ExplicitAuthFlows.every(
      (flow) =>
        ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'].includes(flow) ||
        equal(flow, adminPasswordCondition),
    ), 'The administrative password flow must remain conditioned to non-production only.');

  require(properties('EventsFunction').Environment?.Variables?.EVENTS_TABLE?.Ref ===
    'EventsTable', 'Events must own its own table.');
  for (const name of ['ReconciliationFunction', 'ImportWorkerFunction']) {
    const service = properties(name);
    require(service.Environment?.Variables?.RECONCILIATION_TABLE?.Ref ===
      'ReconciliationTable', `${name} must own its own table within Reconciliation.`);
    require(!JSON.stringify(service.Policies).includes(
      'EventsTable',
    ), `${name} must read Events through the service boundary.`);
  }
  for (const name of ['EventsTable', 'ReconciliationTable', 'IdentityTable']) {
    require(properties(name).BillingMode ===
      'PAY_PER_REQUEST', `${name} must use on-demand capacity.`);
    require(properties(name).SSESpecification?.SSEEnabled ===
      true, `${name} must use encryption at rest.`);
    require(resources[name]?.DeletionPolicy ===
      'Retain', `${name} must preserve data on stack deletion.`);
  }
  for (const name of ['ImportsBucket', 'FrontendAssetsBucket']) {
    const bucket = properties(name);
    require(bucket.PublicAccessBlockConfiguration?.BlockPublicPolicy === true &&
      bucket.PublicAccessBlockConfiguration?.BlockPublicAcls ===
        true, `${name} must block public access.`);
    require(bucket.BucketEncryption?.ServerSideEncryptionConfiguration?.length >
      0, `${name} must encrypt stored objects.`);
  }
  const worker = properties('ImportWorkerFunction');
  const queue = properties('ImportsQueue');
  require(worker.Events?.ImportQueue?.Properties?.FunctionResponseTypes?.includes(
    'ReportBatchItemFailures',
  ), 'Import worker must report partial SQS failures.');
  require(queue.VisibilityTimeout >=
    worker.Timeout *
      6, 'SQS visibility must allow Lambda retries without overlapping invocations.');
  require(queue.SqsManagedSseEnabled === true &&
    queue.RedrivePolicy?.deadLetterTargetArn, 'Import queue must be encrypted and have a DLQ.');
  require(properties('ImportsBucket').NotificationConfiguration?.QueueConfigurations?.[0]?.Queue?.[
    'Fn::GetAtt'
  ]?.[0] === 'ImportsQueue', 'S3 must notify the import queue.');

  require(properties('FrontendFunction').FunctionUrlConfig?.AuthType ===
    'AWS_IAM', 'SSR Function URL must require AWS_IAM.');
  require(properties('FrontendOac').OriginAccessControlConfig?.OriginAccessControlOriginType ===
    'lambda', 'SSR origin must use Lambda OAC.');
  require(properties('FrontendOac').OriginAccessControlConfig?.SigningBehavior ===
    'always', 'CloudFront must sign every SSR origin request.');
  require(properties('FrontendUrlPermission').Action === 'lambda:InvokeFunctionUrl' &&
    properties('FrontendInvokePermission').Action ===
      'lambda:InvokeFunction', 'CloudFront must have both Lambda URL invocation permissions.');
  require(properties('FrontendInvokePermission').InvokedViaFunctionUrl ===
    true, 'CloudFront invocation permission must be constrained to the Function URL.');
  require(distribution.DefaultCacheBehavior?.CachePolicyId ===
    noCache, 'Authenticated SSR responses must not be cached.');
  const business = distribution.CacheBehaviors?.find(
    (behavior) => behavior.PathPattern === '/api/*',
  );
  require(business?.CachePolicyId === noCache, 'API caching must be disabled.');
  require(business?.OriginRequestPolicyId ===
    forwardAuthorization, 'API requests must forward authorization without forwarding the viewer Host.');
  for (const behavior of [
    distribution.DefaultCacheBehavior,
    ...(distribution.CacheBehaviors ?? []),
  ]) {
    const id = behavior?.CachePolicyId;
    const known =
      typeof id === 'string'
        ? knownCachePolicyIds.has(id)
        : id?.Ref && resources[id.Ref]?.Type === 'AWS::CloudFront::CachePolicy';
    require(known, `CachePolicyKnown: ${behavior?.PathPattern ?? 'default'} must reference a verified managed policy or a cache policy defined by this template.`);
  }
  for (const [name, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::Logs::LogGroup')
      require(resource.Properties.RetentionInDays > 0 &&
        resource.Properties.RetentionInDays <= 30, `${name} must have bounded log retention.`);
    for (const policy of (resource.Type === 'AWS::Serverless::Function'
      ? resource.Properties?.Policies
      : []) ?? []) {
      for (const statement of policy.Statement ?? []) {
        if (statement.Effect === 'Allow')
          require(statement.Resource !== '*', `${name} must not grant access to all resources.`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = fileURLToPath(new URL('../infra/template.yaml', import.meta.url));
  const document = parseDocument(await readFile(filename, 'utf8'));
  const errors = [
    ...document.errors.map((error) => error.message),
    ...document.warnings.map((warning) => warning.message),
  ];
  if (errors.length === 0) errors.push(...validateInfrastructure(document.toJS()));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      'SaldoEvento: serverless architecture, identity, storage and edge contracts validated locally.',
    );
  }
}
