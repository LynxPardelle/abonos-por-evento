import assert from 'node:assert/strict';
import test from 'node:test';
import { createCognitoAdapter, parseArgs, runCloudSmoke, validateCloudTarget } from './smoke-cloud.mjs';

const stack = (stage = 'dev') => ({
  StackName: 'saldoevento-dev', StackStatus: 'CREATE_COMPLETE',
  Parameters: [{ ParameterKey: 'Stage', ParameterValue: stage }, { ParameterKey: 'PublicOrigin', ParameterValue: 'https://saldoevento-dev.lynxpardelle.com' }],
  Outputs: [
    { OutputKey: 'UserPoolId', OutputValue: 'us-east-1_synthetic' },
    { OutputKey: 'UserPoolClientId', OutputValue: 'synthetic-client' },
    { OutputKey: 'ProductDomain', OutputValue: 'saldoevento-dev.lynxpardelle.com' },
  ],
});

test('cloud smoke refuses production, wrong stages and foreign origins before creating identities', async () => {
  assert.deepEqual(parseArgs(['--stack', 'saldoevento-dev', '--region', 'us-east-1']), { stack: 'saldoevento-dev', region: 'us-east-1' });
  assert.throws(() => parseArgs(['--stack', 'saldoevento-prod']));
  assert.throws(() => validateCloudTarget('saldoevento-dev', stack('prod')));
  const foreign = stack(); foreign.Parameters[1].ParameterValue = 'https://foreign.example';
  assert.throws(() => validateCloudTarget('saldoevento-dev', foreign));
  let touched = false;
  await assert.rejects(runCloudSmoke({ stackName: 'saldoevento-prod', stackDescription: stack(), cognito: { createUser() { touched = true; } } }));
  assert.equal(touched, false);
});

function syntheticCloud({ failUpload = false, failSecondUser = false } = {}) {
  const created = []; const deleted = []; const identities = new Map(); const participants = []; const movements = []; const operations = new Map();
  let event; let batch; let uploadCount = 0;
  const response = (status, data) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
  const cognito = {
    async createUser(input) { created.push(input); if (failSecondUser && created.length === 2) throw Object.assign(new Error('private provider diagnostic'), { name: 'SyntheticProviderFailure' }); },
    async setPassword() {},
    async authenticate({ username }) { const user = created.find((entry) => entry.username === username); const token = `secret-token-${identities.size}`; identities.set(token, user); return token; },
    async deleteUser({ username }) { deleted.push(username); },
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); const method = options.method ?? 'GET';
    const token = (options.headers?.Authorization ?? '').replace(/^Bearer /, ''); const identity = identities.get(token);
    const payload = options.body && typeof options.body === 'string' && options.headers?.['content-type'] === 'application/json' ? JSON.parse(options.body) : undefined;
    if (url.hostname === 'uploads.synthetic.invalid') { uploadCount++; if (failUpload) throw new Error(`private-signed-url ${url}`); return response(200, ''); }
    if (url.pathname === '/') return response(200, '<title>SaldoEvento</title><main>SaldoEvento</main>');
    if (url.pathname === '/runtime-config.json') return response(200, { mode: 'cloud', clientId: 'synthetic-client' });
    if (!identity) return response(401, {});
    const tenantEvent = event && identity.organizationId === event.organizationId;
    if (url.pathname === '/api/v1/events') {
      if (method === 'GET') return response(200, { events: tenantEvent ? [event] : [] });
      event = { ...payload, organizationId: identity.organizationId }; return response(201, { event });
    }
    if (!tenantEvent) return response(404, {});
    if (url.pathname.endsWith('/participants')) {
      if (method === 'GET') return response(200, { participants });
      participants.push(payload); return response(201, { participant: payload });
    }
    if (url.pathname.endsWith('/imports') && method === 'POST') {
      batch ??= { batchId: payload.sha256, status: 'ready', rows: [
        { rowId: '2', status: 'suggested', amountMinor: '50000', currency: 'MXN' },
        { rowId: '3', status: 'suggested', amountMinor: '75000', currency: 'MXN' },
        { rowId: '4', status: 'ambiguous', amountMinor: '10000', currency: 'MXN' },
        { rowId: '5', status: 'rejected', currency: 'MXN' },
      ] };
      return response(201, { batch, upload: { url: 'https://uploads.synthetic.invalid/input.csv?credential=secret-signed-url', headers: { 'content-type': 'text/csv' } } });
    }
    if (url.pathname.endsWith('/imports')) return response(200, { batches: [batch] });
    if (url.pathname.includes('/imports/')) return response(200, { batch });
    if (url.pathname.endsWith('/allocations')) {
      if (identity.roles === 'importer') return response(403, {});
      if (operations.has(payload.operationId)) return response(200, operations.get(payload.operationId));
      assert.equal(payload.expectedVersion, movements.length);
      const movement = { movementId: `movement-${movements.length + 1}`, participantId: payload.participantId, kind: 'payment', amountMinor: payload.rowId === '2' ? '50000' : '75000', sequence: movements.length + 1 };
      movements.push(movement); const result = { movement, version: movements.length }; operations.set(payload.operationId, result); return response(200, result);
    }
    if (url.pathname.endsWith('/reversals')) {
      assert.equal(payload.expectedVersion, movements.length);
      const movement = { movementId: 'movement-3', participantId: movements[0].participantId, kind: 'reversal', amountMinor: '-50000', reversalOf: movements[0].movementId };
      movements.push(movement); return response(200, { movement, version: movements.length });
    }
    if (url.pathname.endsWith('/movements')) return response(200, { movements, version: movements.length });
    if (url.pathname.endsWith('/balances')) return response(200, { version: movements.length, balances: participants.map((person) => ({ participantId: person.participantId, paidMinor: movements.filter((movement) => movement.participantId === person.participantId).reduce((sum, movement) => sum + BigInt(movement.amountMinor), 0n).toString() })) });
    throw new Error(`unexpected route ${url.pathname}`);
  };
  return { cognito, fetchImpl, created, deleted, uploadCount: () => uploadCount };
}

test('synthetic cloud smoke verifies payments, reversal, replay and isolation without leaking secrets', async () => {
  const cloud = syntheticCloud();
  const report = await runCloudSmoke({ stackName: 'saldoevento-dev', stackDescription: stack(), region: 'us-east-1', ...cloud });
  assert.equal(report.status, 'passed');
  assert.equal(report.metrics.paidMinor, '75000');
  assert.equal(report.metrics.movements, 3);
  assert.equal(report.metrics.batches, 1);
  assert.equal(cloud.created.length, 3);
  assert.equal(cloud.deleted.length, 3);
  assert.equal(cloud.uploadCount(), 2);
  assert.ok(cloud.created.every((user) => user.username.endsWith('@example.test')));
  assert.doesNotMatch(JSON.stringify(report), /secret-token|secret-signed-url|password|private provider/);
});

test('cloud smoke cleans up every attempted temporary identity when user provisioning fails', async () => {
  const cloud = syntheticCloud({ failSecondUser: true });
  const report = await runCloudSmoke({ stackName: 'saldoevento-dev', stackDescription: stack(), ...cloud });
  assert.equal(report.status, 'failed');
  assert.equal(cloud.deleted.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /private provider diagnostic/);
});

test('cloud smoke cleans up users and hides a signed URL when upload transport fails', async () => {
  const cloud = syntheticCloud({ failUpload: true });
  const report = await runCloudSmoke({ stackName: 'saldoevento-dev', stackDescription: stack(), ...cloud });
  assert.equal(report.status, 'failed');
  assert.equal(cloud.deleted.length, 3);
  assert.doesNotMatch(JSON.stringify(report), /secret-signed-url|private-signed-url/);
});

test('Cognito adapter suppresses messages, sets a permanent password and requests an ID token', async () => {
  const commands = Object.fromEntries(['AdminCreateUserCommand', 'AdminSetUserPasswordCommand', 'AdminInitiateAuthCommand', 'AdminDeleteUserCommand'].map((name) => [name, class { constructor(input) { this.name = name; this.input = input; } }]));
  const calls = [];
  const adapter = await createCognitoAdapter({ commands, client: { async send(command) { calls.push(command); return { AuthenticationResult: { IdToken: 'synthetic-secret-token' } }; } } });
  const user = { userPoolId: 'us-east-1_synthetic', clientId: 'synthetic-client', username: 'synthetic@example.test', organizationId: 'org-a', roles: 'operator', password: 'synthetic-secret-password' };
  await adapter.createUser(user); await adapter.setPassword(user);
  assert.equal(await adapter.authenticate(user), 'synthetic-secret-token');
  await adapter.deleteUser(user);
  assert.equal(calls[0].input.MessageAction, 'SUPPRESS');
  assert.equal(calls[0].input.TemporaryPassword, undefined);
  assert.deepEqual(calls[0].input.UserAttributes.filter((attribute) => attribute.Name.startsWith('custom:')), [{ Name: 'custom:organizationId', Value: 'org-a' }, { Name: 'custom:roles', Value: 'operator' }]);
  assert.equal(calls[1].input.Permanent, true);
  assert.equal(calls[2].input.AuthFlow, 'ADMIN_USER_PASSWORD_AUTH');
  assert.equal(calls[3].name, 'AdminDeleteUserCommand');
});

test('a failed temporary-user cleanup marks the smoke as failed even if all product checks pass', async () => {
  const cloud = syntheticCloud();
  cloud.cognito.deleteUser = async () => { throw new Error('provider diagnostic with private values'); };
  const report = await runCloudSmoke({ stackName: 'saldoevento-dev', stackDescription: stack(), ...cloud });
  assert.equal(report.status, 'failed');
  assert.equal(report.cleanup.failures, 3);
  assert.ok(report.checks.some((check) => check.code === 'COGNITO_CLEANUP_FAILED'));
  assert.doesNotMatch(JSON.stringify(report), /provider diagnostic/);
});
