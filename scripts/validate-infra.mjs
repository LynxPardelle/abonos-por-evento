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
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const resources = template?.Resources ?? {};
  const properties = (name) => resources[name]?.Properties ?? {};
  const api = properties('BusinessApi');
  const client = properties('UserPoolClient');
  const distribution = properties('FrontendDistribution').DistributionConfig ?? {};
  const functions = ['EventsFunction', 'ReconciliationFunction', 'ImportWorkerFunction', 'FrontendFunction'];
  for (const name of functions) require(resources[name]?.Type === 'AWS::Serverless::Function', `${name} must be a separate Lambda.`);
  require(template?.Globals?.Function?.Runtime === 'nodejs24.x', 'Lambdas must use the supported Node.js 24 runtime.');
  require(api.Auth?.DefaultAuthorizer === 'CognitoJwt', 'Business API must require JWT by default.');
  const manualPayment = Object.values(properties('ReconciliationFunction').Events ?? {}).find((event) => event.Properties?.Path === '/api/v1/events/{eventId}/payments' && event.Properties.Method === 'POST');
  require(manualPayment && manualPayment.Properties.ApiId?.Ref === 'BusinessApi' && !['NONE', 'AWS_IAM'].includes(manualPayment.Properties.Auth?.Authorizer), 'Manual payments must use the JWT-authenticated business API.');
  require(properties('HealthFunction').Events?.HealthRoute?.Properties?.Auth?.Authorizer === 'NONE', 'Health endpoint must explicitly remain public.');
  require(properties('UserPool').AdminCreateUserConfig?.AllowAdminCreateUserOnly === true, 'Pilot users must be provisioned by an administrator.');
  require(Array.isArray(client.WriteAttributes) && !client.WriteAttributes.some((attribute) => attribute.startsWith('custom:')), 'Authorization custom claims must never be user-writable.');
  require(client.ReadAttributes?.includes('custom:organizationId') && client.ReadAttributes?.includes('custom:roles'), 'Identity token must expose the organization and role claims.');

  require(properties('EventsFunction').Environment?.Variables?.EVENTS_TABLE?.Ref === 'EventsTable', 'Events must own its own table.');
  for (const name of ['ReconciliationFunction', 'ImportWorkerFunction']) {
    const service = properties(name);
    require(service.Environment?.Variables?.RECONCILIATION_TABLE?.Ref === 'ReconciliationTable', `${name} must own its own table within Reconciliation.`);
    require(!JSON.stringify(service.Policies).includes('EventsTable'), `${name} must read Events through the service boundary.`);
  }
  for (const name of ['EventsTable', 'ReconciliationTable']) {
    require(properties(name).BillingMode === 'PAY_PER_REQUEST', `${name} must use on-demand capacity.`);
    require(properties(name).SSESpecification?.SSEEnabled === true, `${name} must use encryption at rest.`);
    require(resources[name]?.DeletionPolicy === 'Retain', `${name} must preserve data on stack deletion.`);
  }
  for (const name of ['ImportsBucket', 'FrontendAssetsBucket']) {
    const bucket = properties(name);
    require(bucket.PublicAccessBlockConfiguration?.BlockPublicPolicy === true && bucket.PublicAccessBlockConfiguration?.BlockPublicAcls === true, `${name} must block public access.`);
    require(bucket.BucketEncryption?.ServerSideEncryptionConfiguration?.length > 0, `${name} must encrypt stored objects.`);
  }
  const worker = properties('ImportWorkerFunction');
  const queue = properties('ImportsQueue');
  require(worker.Events?.ImportQueue?.Properties?.FunctionResponseTypes?.includes('ReportBatchItemFailures'), 'Import worker must report partial SQS failures.');
  require(queue.VisibilityTimeout >= worker.Timeout * 6, 'SQS visibility must allow Lambda retries without overlapping invocations.');
  require(queue.SqsManagedSseEnabled === true && queue.RedrivePolicy?.deadLetterTargetArn, 'Import queue must be encrypted and have a DLQ.');
  require(properties('ImportsBucket').NotificationConfiguration?.QueueConfigurations?.[0]?.Queue?.['Fn::GetAtt']?.[0] === 'ImportsQueue', 'S3 must notify the import queue.');

  require(properties('FrontendFunction').FunctionUrlConfig?.AuthType === 'AWS_IAM', 'SSR Function URL must require AWS_IAM.');
  require(properties('FrontendOac').OriginAccessControlConfig?.OriginAccessControlOriginType === 'lambda', 'SSR origin must use Lambda OAC.');
  require(properties('FrontendOac').OriginAccessControlConfig?.SigningBehavior === 'always', 'CloudFront must sign every SSR origin request.');
  require(properties('FrontendUrlPermission').Action === 'lambda:InvokeFunctionUrl' && properties('FrontendInvokePermission').Action === 'lambda:InvokeFunction', 'CloudFront must have both Lambda URL invocation permissions.');
  require(properties('FrontendInvokePermission').InvokedViaFunctionUrl === true, 'CloudFront invocation permission must be constrained to the Function URL.');
  require(distribution.DefaultCacheBehavior?.CachePolicyId === noCache, 'Authenticated SSR responses must not be cached.');
  const business = distribution.CacheBehaviors?.find((behavior) => behavior.PathPattern === '/api/*');
  require(business?.CachePolicyId === noCache, 'API caching must be disabled.');
  require(business?.OriginRequestPolicyId === forwardAuthorization, 'API requests must forward authorization without forwarding the viewer Host.');
  for (const behavior of [distribution.DefaultCacheBehavior, ...(distribution.CacheBehaviors ?? [])]) {
    const id = behavior?.CachePolicyId;
    const known = typeof id === 'string' ? knownCachePolicyIds.has(id) : id?.Ref && resources[id.Ref]?.Type === 'AWS::CloudFront::CachePolicy';
    require(known, `CachePolicyKnown: ${behavior?.PathPattern ?? 'default'} must reference a verified managed policy or a cache policy defined by this template.`);
  }
  for (const [name, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::Logs::LogGroup') require(resource.Properties.RetentionInDays > 0 && resource.Properties.RetentionInDays <= 30, `${name} must have bounded log retention.`);
    for (const policy of (resource.Type === 'AWS::Serverless::Function' ? resource.Properties?.Policies : []) ?? []) {
      for (const statement of policy.Statement ?? []) {
        if (statement.Effect === 'Allow') require(statement.Resource !== '*', `${name} must not grant access to all resources.`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = fileURLToPath(new URL('../infra/template.yaml', import.meta.url));
  const document = parseDocument(await readFile(filename, 'utf8'));
  const errors = [...document.errors.map((error) => error.message), ...document.warnings.map((warning) => warning.message)];
  if (errors.length === 0) errors.push(...validateInfrastructure(document.toJS()));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('SaldoEvento: serverless architecture, identity, storage and edge contracts validated locally.');
  }
}
