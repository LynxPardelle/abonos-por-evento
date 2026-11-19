import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const template = parse(await readFile(new URL('./template.yaml', import.meta.url), 'utf8'));
const resources = template.Resources;

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
  assert.equal(template.Mappings.Environments.prod.DomainName, 'saldoevento.lynxpardelle.com');
  assert.equal(resources.FrontendDnsA.Condition, 'CustomDomainEnabled');
  assert.equal(template.Parameters.HostedZoneId.Default, '');
  assert.equal(template.Parameters.CertificateArn.Default, '');
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
