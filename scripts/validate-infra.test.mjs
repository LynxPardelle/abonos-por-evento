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
  const output = execFileSync(process.execPath, [fileURLToPath(validatorUrl)], { encoding: 'utf8' });
  assert.match(output, /contracts validated locally/);
});

test('identity escalation and shared storage regressions are rejected', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.UserPoolClient.Properties.WriteAttributes.push('custom:roles');
  invalid.Resources.ReconciliationFunction.Properties.Environment.Variables.RECONCILIATION_TABLE = { Ref: 'EventsTable' };
  const errors = validate(invalid);
  assert.ok(errors.some((error) => /custom claims/i.test(error)));
  assert.ok(errors.some((error) => /own table/i.test(error)));
});

test('manual payment endpoint must retain JWT authorization', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  const manual = Object.values(invalid.Resources.ReconciliationFunction.Properties.Events).find((event) => event.Properties.Path.endsWith('/payments'));
  assert.ok(manual, 'Manual payment route must exist');
  manual.Properties.Auth = { Authorizer: 'NONE' };
  assert.ok(validate(invalid).some((error) => /manual payments.*JWT/i.test(error)));
});

test('a public SSR origin or API cache is rejected before deployment', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.FrontendFunction.Properties.FunctionUrlConfig.AuthType = 'NONE';
  invalid.Resources.FrontendDistribution.Properties.DistributionConfig.CacheBehaviors[0].CachePolicyId = '658327ea-f89d-4fab-a63d-7e88639e58f6';
  const errors = validate(invalid);
  assert.ok(errors.some((error) => /AWS_IAM/.test(error)));
  assert.ok(errors.some((error) => /API caching/.test(error)));
});

test('unknown cache policy IDs are rejected in every CloudFront behavior', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  const distribution = invalid.Resources.FrontendDistribution.Properties.DistributionConfig;
  distribution.CacheBehaviors.find((behavior) => behavior.TargetOriginId === 'assets').CachePolicyId = '00000000-0000-0000-0000-000000000000';
  assert.ok(validate(invalid).some((error) => /CachePolicyKnown/.test(error)), 'A syntactically valid UUID must not bypass managed-policy validation');
});

test('registration cannot bypass protected membership provisioning or its Cognito source boundary', async () => {
  const validate = await validator();
  const invalid = structuredClone(template);
  invalid.Resources.IdentityTokenFunctionPermission.Properties.SourceArn = '*';
  invalid.Resources.UserPool.Properties.LambdaConfig.PreTokenGenerationConfig.LambdaVersion = 'V2_0';
  const errors = validate(invalid);
  assert.ok(errors.some(error => /source-scoped.*Cognito/i.test(error)));
  assert.ok(errors.some(error => /pre-token.*V1_0/i.test(error)));
});
