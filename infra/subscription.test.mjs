import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const template = parse(await readFile(new URL('./template.yaml', import.meta.url), 'utf8'));
const resources = template.Resources;
const statements = (name) =>
  (resources[name]?.Properties.Policies ?? []).flatMap((policy) => policy.Statement ?? []);
const actions = (statement) => [].concat(statement.Action ?? []);
const routes = (name) =>
  Object.values(resources[name]?.Properties.Events ?? {}).map(
    (event) => `${event.Properties.Method} ${event.Properties.Path}`,
  );

test('identity resolver, public HTTP service and IAM administrator are separate named Lambdas', () => {
  for (const [name, suffix, handler] of [
    ['IdentityResolverFunction', 'identity-resolver', 'identity/resolver.handler'],
    ['IdentityHttpFunction', 'identity-http', 'identity/http.handler'],
    ['IdentityAdminFunction', 'identity-admin', 'identity/admin.handler'],
  ]) {
    const service = resources[name];
    assert.equal(service?.Type, 'AWS::Serverless::Function', name);
    assert.deepEqual(service.Properties.FunctionName, {
      'Fn::Sub': `saldoevento-\${Stage}-${suffix}`,
    });
    assert.equal(service.Properties.Handler, handler);
    assert.equal(service.Properties.CodeUri, '../services/');
    assert.deepEqual(service.Properties.Environment.Variables.IDENTITY_TABLE, {
      Ref: 'IdentityTable',
    });
    assert.deepEqual(service.Properties.Environment.Variables.USER_POOL_ID, { Ref: 'UserPool' });
    const log = resources[service.Properties.LoggingConfig.LogGroup.Ref];
    assert.equal(log.Properties.RetentionInDays, 14);
  }
  assert.deepEqual(template.Outputs.IdentityAdminFunctionName.Value, {
    Ref: 'IdentityAdminFunction',
  });
});

test('access resolver is read-only and has no dependency back to Events or the public API', () => {
  const policies = statements('IdentityResolverFunction');
  assert.ok(policies.length > 0);
  assert.deepEqual([...new Set(policies.flatMap(actions))].sort(), [
    'dynamodb:GetItem',
    'dynamodb:Query',
  ]);
  for (const policy of policies)
    assert.deepEqual(policy.Resource, { 'Fn::GetAtt': ['IdentityTable', 'Arn'] });
  assert.ok(!JSON.stringify(resources.IdentityResolverFunction).includes('EventsFunction'));
  assert.equal(resources.IdentityResolverFunction.Properties.Events, undefined);
  assert.equal(resources.IdentityResolverFunction.Properties.FunctionUrlConfig, undefined);
});

test('IAM plan administrator has no HTTP, Function URL or public invocation permission', () => {
  const administrator = resources.IdentityAdminFunction?.Properties;
  assert.ok(administrator);
  assert.equal(administrator.Events, undefined);
  assert.equal(administrator.FunctionUrlConfig, undefined);
  for (const resource of Object.values(resources))
    if (resource.Type === 'AWS::Lambda::Permission')
      assert.ok(
        !JSON.stringify(resource.Properties.FunctionName).includes('IdentityAdminFunction'),
      );
  assert.deepEqual(administrator.Environment.Variables.EVENTS_TABLE, { Ref: 'EventsTable' });
  assert.deepEqual(administrator.Environment.Variables.EVENTS_FUNCTION_NAME, {
    Ref: 'EventsFunction',
  });
  const eventPolicies = statements('IdentityAdminFunction').filter((statement) =>
    JSON.stringify(statement.Resource).includes('EventsTable'),
  );
  assert.deepEqual(eventPolicies.flatMap(actions), ['dynamodb:ConditionCheckItem']);
  assert.ok(
    statements('IdentityAdminFunction').some(
      (statement) =>
        actions(statement).includes('lambda:InvokeFunction') &&
        JSON.stringify(statement.Resource).includes('EventsFunction'),
    ),
  );
});

test('public account service has no unused Events invocation or table permissions', () => {
  const service = resources.IdentityHttpFunction.Properties;
  assert.equal(service.Environment.Variables.EVENTS_TABLE, undefined);
  assert.equal(service.Environment.Variables.EVENTS_FUNCTION_NAME, undefined);
  for (const statement of statements('IdentityHttpFunction'))
    assert.deepEqual(statement.Resource, { 'Fn::GetAtt': ['IdentityTable', 'Arn'] });
});

test('business writers resolve identity and condition-check its metadata without Identity writes', () => {
  for (const name of ['EventsFunction', 'ReconciliationFunction']) {
    const environment = resources[name].Properties.Environment.Variables;
    assert.deepEqual(environment.IDENTITY_TABLE, { Ref: 'IdentityTable' });
    assert.deepEqual(environment.USER_POOL_ID, { Ref: 'UserPool' });
    assert.deepEqual(environment.IDENTITY_RESOLVER_FUNCTION_NAME, {
      Ref: 'IdentityResolverFunction',
    });
    const identityPolicies = statements(name).filter((statement) =>
      JSON.stringify(statement.Resource).includes('IdentityTable'),
    );
    assert.deepEqual(identityPolicies.flatMap(actions), ['dynamodb:ConditionCheckItem']);
    assert.ok(
      statements(name).some(
        (statement) =>
          actions(statement).includes('lambda:InvokeFunction') &&
          JSON.stringify(statement.Resource).includes('IdentityResolverFunction'),
      ),
    );
  }
  const worker = JSON.stringify(resources.ImportWorkerFunction);
  assert.ok(
    !worker.includes('IdentityTable') &&
      !worker.includes('IdentityResolverFunction') &&
      !worker.includes('USER_POOL_ID'),
  );
});

test('new account, template, closing, report and overview routes inherit the JWT authorizer', () => {
  const expected = {
    IdentityHttpFunction: [
      'GET /api/v1/me',
      'GET /api/v1/organizations/current/members',
      'POST /api/v1/organizations/current/members/{memberId}/role',
      'POST /api/v1/organizations/current/members/{memberId}/revoke',
    ],
    EventsFunction: [
      'GET /api/v1/events/{eventId}',
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
  for (const [name, required] of Object.entries(expected)) {
    for (const route of required) assert.ok(routes(name).includes(route), `${name}: ${route}`);
    for (const event of Object.values(resources[name].Properties.Events ?? {})) {
      assert.deepEqual(event.Properties.ApiId, { Ref: 'BusinessApi' });
      assert.ok(!['NONE', 'AWS_IAM'].includes(event.Properties.Auth?.Authorizer));
    }
  }
  assert.equal(resources.BusinessApi.Properties.Auth.DefaultAuthorizer, 'CognitoJwt');
  assert.ok(
    resources.BusinessApi.Properties.CorsConfiguration.AllowHeaders.includes(
      'x-saldoevento-organization',
    ),
  );
});

test('production pilot registration follows explicit approval while template defaults and prod password flow remain closed', async () => {
  const prod = JSON.parse(
    await readFile(new URL('./environments/prod.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    prod.find((parameter) => parameter.ParameterKey === 'SelfRegistrationEnabled').ParameterValue,
    'true',
  );
  assert.equal(template.Parameters.SelfRegistrationEnabled.Default, 'false');
  assert.deepEqual(template.Conditions.IsNonProduction, {
    'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] }],
  });
  assert.deepEqual(
    resources.UserPoolClient.Properties.ExplicitAuthFlows.find((flow) => typeof flow === 'object'),
    { 'Fn::If': ['IsNonProduction', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', { Ref: 'AWS::NoValue' }] },
  );
});
