import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const template = parse(await readFile(new URL('./template.yaml', import.meta.url), 'utf8'));
const resources = template.Resources;
const absent = Symbol('AWS::NoValue');
// Resolve only the CloudFormation expressions used by the public-domain contract.
function domainValue(value, stage, custom = true) {
  const parameters = { Stage: stage, PublicOrigin: `https://${template.Mappings.Environments[stage].DomainName}`, HostedZoneId: stage === 'prod' ? 'Z00733952JM7567FL6HXC' : 'Z05088763QG63CC5SE7PN', CertificateArn: custom ? 'synthetic-certificate' : '', 'AWS::Region': 'us-east-1' };
  const resolve = input => {
    if (Array.isArray(input)) return input.map(resolve).filter(item => item !== absent);
    if (!input || typeof input !== 'object') return input;
    if (input.Ref) return input.Ref === 'AWS::NoValue' ? absent : parameters[input.Ref];
    if (input.Condition) return resolve(template.Conditions[input.Condition]);
    if (input['Fn::Not']) return !resolve(input['Fn::Not'][0]);
    if (input['Fn::And']) return input['Fn::And'].every(resolve);
    if (input['Fn::Equals']) { const [left, right] = input['Fn::Equals'].map(resolve); return left === right; }
    if (input['Fn::If']) { const [condition, yes, no] = input['Fn::If']; return resolve(resolve(template.Conditions[condition]) ? yes : no); }
    if (input['Fn::FindInMap']) { const [name, entry, key] = input['Fn::FindInMap'].map(resolve); return template.Mappings[name][entry][key]; }
    if (input['Fn::Join']) { const [separator, parts] = input['Fn::Join']; return resolve(parts).join(separator); }
    if (input['Fn::Sub']) return input['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (match, key) => parameters[key] ?? match);
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, resolve(child)]));
  };
  return resolve(value);
}

test('business domains own separate tables and least-privilege Lambda access', () => {
  assert.ok(resources.EventsFunction, 'Events microservice must be defined');
  assert.ok(resources.ReconciliationFunction);
  assert.ok(resources.EventsTable);
  assert.ok(resources.ReconciliationTable);
  assert.deepEqual(resources.EventsFunction.Properties.Environment.Variables.EVENTS_TABLE, { Ref: 'EventsTable' });
  assert.deepEqual(resources.ReconciliationFunction.Properties.Environment.Variables.RECONCILIATION_TABLE, { Ref: 'ReconciliationTable' });
  assert.equal(resources.EventsTable.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(resources.ReconciliationTable.Properties.BillingMode, 'PAY_PER_REQUEST');
  const reconciliationPolicies = JSON.stringify(resources.ReconciliationFunction.Properties.Policies);
  assert.ok(!reconciliationPolicies.includes('EventsTable'), 'Reconciliation reads Events through its service');
  assert.ok(reconciliationPolicies.includes('lambda:InvokeFunction'));
});

test('business routes use JWT while health remains public and claims are not user-writable', () => {
  assert.equal(resources.BusinessApi.Properties.Auth.DefaultAuthorizer, 'CognitoJwt');
  assert.equal(resources.HealthFunction.Properties.Events.HealthRoute.Properties.Auth.Authorizer, 'NONE');
  const client = resources.UserPoolClient.Properties;
  assert.ok(client.ReadAttributes.includes('custom:organizationId'));
  assert.ok(client.ReadAttributes.includes('custom:roles'));
  assert.ok(!client.WriteAttributes.some((attribute) => attribute.startsWith('custom:')));
  const paths = Object.values(resources.ReconciliationFunction.Properties.Events).map((event) => `${event.Properties.Method} ${event.Properties.Path}`);
  assert.ok(paths.includes('GET /api/v1/events/{eventId}/imports'));
  assert.ok(paths.includes('POST /api/v1/events/{eventId}/payments'), 'Manual external payments must be exposed through the authenticated business API');
});

test('private CSV ingestion is queued with bounded retention, replay protection and partial failures', () => {
  const bucket = resources.ImportsBucket.Properties;
  assert.equal(bucket.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(bucket.NotificationConfiguration.QueueConfigurations[0].Event, 's3:ObjectCreated:*');
  assert.deepEqual(bucket.NotificationConfiguration.QueueConfigurations[0].Queue, { 'Fn::GetAtt': ['ImportsQueue', 'Arn'] });
  assert.ok(bucket.LifecycleConfiguration.Rules[0].ExpirationInDays <= 7);
  assert.equal(resources.ImportsQueue.Properties.SqsManagedSseEnabled, true);
  assert.ok(resources.ImportsQueue.Properties.RedrivePolicy.maxReceiveCount >= 3);
  assert.deepEqual(resources.ImportWorkerFunction.Properties.Events.ImportQueue.Properties.FunctionResponseTypes, ['ReportBatchItemFailures']);
  assert.ok(resources.ImportsQueue.Properties.VisibilityTimeout >= resources.ImportWorkerFunction.Properties.Timeout * 6);
});

test('Angular SSR is private behind CloudFront OAC and business requests are never cached', () => {
  assert.equal(resources.FrontendFunction.Properties.FunctionUrlConfig.AuthType, 'AWS_IAM');
  assert.equal(resources.FrontendOac.Properties.OriginAccessControlConfig.OriginAccessControlOriginType, 'lambda');
  assert.equal(resources.FrontendOac.Properties.OriginAccessControlConfig.SigningBehavior, 'always');
  assert.equal(resources.FrontendInvokePermission.Properties.Action, 'lambda:InvokeFunction');
  assert.equal(resources.FrontendUrlPermission.Properties.Action, 'lambda:InvokeFunctionUrl');
  const distribution = resources.FrontendDistribution.Properties.DistributionConfig;
  const api = distribution.CacheBehaviors.find((behavior) => behavior.PathPattern === '/api/*');
  // Confirmed with AWS CloudFront list-cache-policies --type managed on 2026-11-19.
  assert.equal(api.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.equal(api.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac');
  assert.equal(api.AllowedMethods.length, 7);
  assert.equal(distribution.DefaultCacheBehavior.CachePolicyId, api.CachePolicyId);
});

test('domain configuration maps development, testing and production without fabricated AWS identifiers', () => {
  assert.deepEqual(template.Parameters.Stage.AllowedValues, ['dev', 'test', 'prod']);
  assert.equal(template.Mappings.Environments.dev.DomainName, 'saldoevento-dev.lynxpardelle.com');
  assert.equal(template.Mappings.Environments.test.DomainName, 'saldoevento-test.lynxpardelle.com');
  assert.equal(template.Mappings.Environments.prod.DomainName, 'saldoevento.zooberiahsystems.com');
  assert.equal(resources.FrontendDnsA.Condition, 'CustomDomainEnabled');
  assert.equal(template.Parameters.HostedZoneId.Default, '');
  assert.equal(template.Parameters.CertificateArn.Default, '');
});

test('production serves the new and existing hosts with compatible OAuth and CSV uploads', () => {
  const primary = 'saldoevento.zooberiahsystems.com';
  const legacy = 'saldoevento.lynxpardelle.com';
  assert.deepEqual(domainValue(resources.FrontendDistribution.Properties.DistributionConfig.Aliases, 'prod'), [primary, legacy]);
  const origins = [`https://${primary}`, `https://${legacy}`];
  assert.deepEqual(domainValue(resources.UserPoolClient.Properties.CallbackURLs, 'prod'), origins.map(origin => `${origin}/auth/callback`));
  assert.deepEqual(domainValue(resources.UserPoolClient.Properties.LogoutURLs, 'prod'), origins);
  assert.deepEqual(domainValue(resources.BusinessApi.Properties.CorsConfiguration.AllowOrigins, 'prod'), origins);
  assert.deepEqual(domainValue(resources.ImportsBucket.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins, 'prod'), origins);
  const hosts = domainValue(resources.FrontendFunction.Properties.Environment.Variables.NG_ALLOWED_HOSTS, 'prod').split(',');
  assert.ok(hosts.includes(primary) && hosts.includes(legacy));
  assert.deepEqual(resources.UserPool.Properties.UserPoolName, { 'Fn::Sub': 'saldoevento-${Stage}' });
  assert.deepEqual(resources.UserPoolDomain.Properties.Domain, { 'Fn::Sub': 'saldoevento-${Stage}-${AWS::AccountId}' });
  assert.deepEqual(resources.UserPoolClient.Properties.UserPoolId, { Ref: 'UserPool' });
});

test('existing DNS logical IDs retain their old production name and zone while new records use the new zone', async () => {
  for (const [oldName, newName, type] of [['FrontendDnsA', 'PrimaryFrontendDnsA', 'A'], ['FrontendDnsAAAA', 'PrimaryFrontendDnsAAAA', 'AAAA']]) {
    assert.equal(domainValue(resources[oldName].Properties.Name, 'prod'), 'saldoevento.lynxpardelle.com');
    assert.equal(domainValue(resources[oldName].Properties.HostedZoneId, 'prod'), 'Z05088763QG63CC5SE7PN');
    assert.ok(resources[newName], `The new ${type} record must have its own logical ID`);
    assert.equal(resources[newName].Condition, 'ProdCustomDomain');
    assert.equal(domainValue({ Condition: resources[newName].Condition }, 'prod'), true);
    assert.equal(domainValue({ Condition: resources[newName].Condition }, 'test'), false);
    assert.equal(domainValue({ Condition: resources[newName].Condition }, 'prod', false), false);
    assert.equal(resources[newName].Properties.Type, type);
    assert.equal(domainValue(resources[newName].Properties.Name, 'prod'), 'saldoevento.zooberiahsystems.com');
    assert.equal(domainValue(resources[newName].Properties.HostedZoneId, 'prod'), 'Z00733952JM7567FL6HXC');
    assert.deepEqual(resources[newName].Properties.AliasTarget, resources[oldName].Properties.AliasTarget);
  }
  const parameters = Object.fromEntries(JSON.parse(await readFile(new URL('./environments/prod.json', import.meta.url), 'utf8')).map(item => [item.ParameterKey, item.ParameterValue]));
  assert.equal(parameters.PublicOrigin, 'https://saldoevento.zooberiahsystems.com');
  assert.equal(parameters.HostedZoneId, 'Z00733952JM7567FL6HXC');
});

test('development and testing never inherit the production compatibility host', () => {
  for (const stage of ['dev', 'test']) {
    const host = `saldoevento-${stage}.lynxpardelle.com`, origin = `https://${host}`;
    assert.deepEqual(domainValue(resources.FrontendDistribution.Properties.DistributionConfig.Aliases, stage), [host]);
    assert.deepEqual(domainValue(resources.UserPoolClient.Properties.CallbackURLs, stage), [`${origin}/auth/callback`]);
    assert.deepEqual(domainValue(resources.UserPoolClient.Properties.LogoutURLs, stage), [origin]);
    assert.deepEqual(domainValue(resources.BusinessApi.Properties.CorsConfiguration.AllowOrigins, stage), [origin]);
    assert.deepEqual(domainValue(resources.ImportsBucket.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins, stage), [origin]);
    assert.equal(domainValue(resources.FrontendDnsA.Properties.Name, stage), host);
    assert.equal(domainValue(resources.FrontendDnsA.Properties.HostedZoneId, stage), 'Z05088763QG63CC5SE7PN');
  }
});

test('self-registration provisions server-owned membership with source-scoped Cognito triggers', () => {
  assert.equal(template.Parameters.SelfRegistrationEnabled.Default, 'false');
  assert.deepEqual(template.Parameters.SelfRegistrationEnabled.AllowedValues, ['true', 'false']);
  assert.deepEqual(resources.UserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, { 'Fn::If': ['SelfRegistrationAllowed', false, true] });
  assert.deepEqual(resources.UserPool.Properties.LambdaConfig.PostConfirmation, { 'Fn::GetAtt': ['IdentityConfirmationFunction', 'Arn'] });
  assert.equal(resources.UserPool.Properties.LambdaConfig.PreTokenGenerationConfig.LambdaVersion, 'V1_0');
  assert.equal(resources.IdentityTable.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(resources.IdentityTable.Properties.SSESpecification.SSEEnabled, true);
  assert.equal(resources.IdentityTable.DeletionPolicy, 'Retain');
  for (const name of ['IdentityConfirmationFunction', 'IdentityTokenFunction']) {
    const properties = resources[name].Properties;
    assert.deepEqual(properties.Environment.Variables.IDENTITY_TABLE, { Ref: 'IdentityTable' });
    const policy = JSON.stringify(properties.Policies);
    assert.ok(!policy.includes('EventsTable') && !policy.includes('ReconciliationTable'));
    assert.ok(!policy.includes('cognito-idp:AdminUpdateUserAttributes'));
    const permission = resources[`${name}Permission`].Properties;
    assert.equal(permission.Principal, 'cognito-idp.amazonaws.com');
    assert.deepEqual(permission.SourceArn, { 'Fn::GetAtt': ['UserPool', 'Arn'] });
    assert.deepEqual(permission.SourceAccount, { Ref: 'AWS::AccountId' });
  }
  const adminFlow = resources.UserPoolClient.Properties.ExplicitAuthFlows.find(flow => typeof flow === 'object');
  assert.equal(adminFlow['Fn::If'][0], 'IsNonProduction', 'Only dev/test may enable the IAM-only administrative smoke flow');
});
