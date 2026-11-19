import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const validatorUrl = new URL('./validate-infra.mjs', import.meta.url);
const template = parse(await readFile(new URL('../infra/template.yaml', import.meta.url), 'utf8'));

async function validator() {
  await assert.doesNotReject(access(validatorUrl), 'Infrastructure validation must be available');
  return (await import(validatorUrl.href)).validateInfrastructure;
}

test('valid serverless deployment passes the local contract', async () => {
  assert.deepEqual((await validator())(template), []);
});

test('CLI validates the actual YAML including Cognito policies', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(validatorUrl)], {
    encoding: 'utf8',
  });
  assert.match(output, /contracts validated locally/);
});

test('identity escalation and shared storage regressions are rejected', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.UserPoolClient.Properties.WriteAttributes.push('custom:roles');
  invalid.Resources.ReconciliationFunction.Properties.Environment.Variables.RECONCILIATION_TABLE = {
    Ref: 'EventsTable',
  };
  const errors = validate(invalid);
  assert.ok(errors.some((error) => /custom claims/i.test(error)));
  assert.ok(errors.some((error) => /own table/i.test(error)));
});

test('manual payment endpoint must retain JWT authorization', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  const manual = Object.values(invalid.Resources.ReconciliationFunction.Properties.Events).find(
    (event) => event.Properties.Path.endsWith('/payments'),
  );
  assert.ok(manual, 'Manual payment route must exist');
  manual.Properties.Auth = { Authorizer: 'NONE' };
  assert.ok(validate(invalid).some((error) => /manual payments.*JWT/i.test(error)));
});

test('a public SSR origin or API cache is rejected before deployment', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.FrontendFunction.Properties.FunctionUrlConfig.AuthType = 'NONE';
  invalid.Resources.FrontendDistribution.Properties.DistributionConfig.CacheBehaviors[0].CachePolicyId =
    '658327ea-f89d-4fab-a63d-7e88639e58f6';
  const errors = validate(invalid);
  assert.ok(errors.some((error) => /AWS_IAM/.test(error)));
  assert.ok(errors.some((error) => /API caching/.test(error)));
});

test('unknown cache policy IDs are rejected in every CloudFront behavior', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  const distribution = invalid.Resources.FrontendDistribution.Properties.DistributionConfig;
  distribution.CacheBehaviors.find(
    (behavior) => behavior.TargetOriginId === 'assets',
  ).CachePolicyId = '00000000-0000-0000-0000-000000000000';
  assert.ok(
    validate(invalid).some((error) => /CachePolicyKnown/.test(error)),
    'A syntactically valid UUID must not bypass managed-policy validation',
  );
});

test('registration cannot bypass protected membership provisioning or its Cognito source boundary', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.IdentityTokenFunctionPermission.Properties.SourceArn = '*';
  invalid.Resources.UserPool.Properties.LambdaConfig.PreTokenGenerationConfig.LambdaVersion =
    'V2_0';
  const errors = validate(invalid);
  assert.ok(errors.some((error) => /source-scoped.*Cognito/i.test(error)));
  assert.ok(errors.some((error) => /pre-token.*V1_0/i.test(error)));
});

test('identity resolver cannot gain write rights or a dependency back to business functions', async () => {
  const invalid = structuredClone(template);
  invalid.Resources.IdentityResolverFunction.Properties.Policies[0].Statement[0].Action.push(
    'dynamodb:PutItem',
  );
  invalid.Resources.IdentityResolverFunction.Properties.Environment.Variables.EVENTS_FUNCTION_NAME =
    { Ref: 'EventsFunction' };
  const errors = (await validator())(invalid);
  assert.ok(errors.some((error) => /resolver.*read.only/i.test(error)));
  assert.ok(errors.some((error) => /resolver.*depend/i.test(error)));
});

test('IAM administrator cannot acquire an HTTP route, Function URL or invocation permission', async () => {
  const changes = [
    (invalid) => {
      invalid.Resources.IdentityAdminFunction.Properties.Events = {
        PublicAdmin: {
          Type: 'HttpApi',
          Properties: { ApiId: { Ref: 'BusinessApi' }, Path: '/api/v1/admin', Method: 'POST' },
        },
      };
    },
    (invalid) => {
      invalid.Resources.IdentityAdminFunction.Properties.FunctionUrlConfig = { AuthType: 'NONE' };
    },
    (invalid) => {
      invalid.Resources.PublicAdminPermission = {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          Action: 'lambda:InvokeFunction',
          FunctionName: { Ref: 'IdentityAdminFunction' },
          Principal: '*',
        },
      };
    },
  ];
  for (const change of changes) {
    const invalid = structuredClone(template);
    change(invalid);
    assert.ok(
      (await validator())(invalid).some((error) =>
        /administrator.*public|administrator.*http|administrator.*url/i.test(error),
      ),
    );
  }
});

test('Identity guards are read-only and CSV worker has no identity resolver or Identity access', async () => {
  const invalid = structuredClone(template);
  invalid.Resources.EventsFunction.Properties.Policies[0].Statement.find((statement) =>
    JSON.stringify(statement.Resource).includes('IdentityTable'),
  ).Action = ['dynamodb:PutItem'];
  invalid.Resources.ImportWorkerFunction.Properties.Environment.Variables.IDENTITY_RESOLVER_FUNCTION_NAME =
    { Ref: 'IdentityResolverFunction' };
  const errors = (await validator())(invalid);
  assert.ok(errors.some((error) => /EventsFunction.*condition.check/i.test(error)));
  assert.ok(errors.some((error) => /worker.*identity/i.test(error)));
});

test('new account routes cannot bypass JWT and organization selection must be allowed by CORS', async () => {
  const invalid = structuredClone(template);
  invalid.Resources.IdentityHttpFunction.Properties.Events.ChangeMemberRole.Properties.Auth = {
    Authorizer: 'NONE',
  };
  invalid.Resources.BusinessApi.Properties.CorsConfiguration.AllowHeaders = [
    'authorization',
    'content-type',
  ];
  const errors = (await validator())(invalid);
  assert.ok(errors.some((error) => /tier routes.*JWT/i.test(error)));
  assert.ok(errors.some((error) => /organization.*CORS/i.test(error)));
});

test('production cannot gain the administrative password grant and business access configuration is mandatory', async () => {
  const invalid = structuredClone(template);
  invalid.Resources.UserPoolClient.Properties.ExplicitAuthFlows = [
    'ALLOW_USER_SRP_AUTH',
    'ALLOW_REFRESH_TOKEN_AUTH',
    'ALLOW_ADMIN_USER_PASSWORD_AUTH',
  ];
  delete invalid.Resources.ReconciliationFunction.Properties.Environment.Variables.USER_POOL_ID;
  const errors = (await validator())(invalid);
  assert.ok(errors.some((error) => /password.*non.production/i.test(error)));
  assert.ok(errors.some((error) => /ReconciliationFunction.*identity.*environment/i.test(error)));
});

test('IAM quota checks cannot become Events writes and required routes cannot disappear', async () => {
  const invalid = structuredClone(template);
  const policy = invalid.Resources.IdentityAdminFunction.Properties.Policies[0].Statement.find(
    (statement) => JSON.stringify(statement.Resource).includes('EventsTable'),
  );
  policy.Action = ['dynamodb:PutItem'];
  delete invalid.Resources.ReconciliationFunction.Properties.Events.ExportClosingSnapshot;
  const errors = (await validator())(invalid);
  assert.ok(
    errors.some((error) =>
      /administrator.*condition.check|IdentityAdminFunction.*cross.domain/i.test(error),
    ),
  );
  assert.ok(errors.some((error) => /ReconciliationFunction.*every.*route/i.test(error)));
});
