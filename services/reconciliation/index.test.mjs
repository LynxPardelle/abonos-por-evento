import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconciliationHandler } from './index.mjs';
import { createImportWorker } from './worker.mjs';
function request(method, path, roles = 'auditor', org = 'org-a') { return { rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'user-1', 'custom:organizationId': org, 'custom:roles': roles } } } } }; }
test('business routes reject missing identity and insufficient role', async () => {
  let called = false;
  const handler = createReconciliationHandler({ service: { startImport() { called = true; } } });
  const path = '/api/v1/events/event-1/imports';
  assert.equal((await handler({ rawPath: path, requestContext: { http: { method: 'POST' } } })).statusCode, 401);
  assert.equal((await handler({ ...request('POST', path), body: '{}' })).statusCode, 403);
  assert.equal(called, false);
});
test('read dispatch derives organization from signed claims, never body', async () => {
  let observed;
  const handler = createReconciliationHandler({ service: { listImports(actor, eventId) { observed = { actor, eventId }; return { batches: [] }; } } });
  const response = await handler({ ...request('GET', '/api/v1/events/event-1/imports'), body: '{"organizationId":"victim"}' });
  assert.equal(response.statusCode, 200);
  assert.equal(observed.actor.organizationId, 'org-a');
});
test('named HTTP API stage is removed before matching business routes', async () => {
  const handler = createReconciliationHandler({ service: { listImports: async () => ({ batches: [] }) } });
  const event = request('GET', '/dev/api/v1/events/event-1/imports');
  event.requestContext.stage = 'dev';
  assert.equal((await handler(event)).statusCode, 200);
});
test('manual payments require confirmer and return a recorded movement', async () => {
  const handler = createReconciliationHandler({ service: { recordPayment: async () => ({ movement: { movementId: 'manual' }, version: 1 }) } });
  const path = '/api/v1/events/event-1/payments';
  assert.equal((await handler({ ...request('POST', path, 'importer'), body: '{}' })).statusCode, 403);
  assert.equal((await handler({ ...request('POST', path, 'confirmer'), body: '{}' })).statusCode, 200);
});
test('worker reports partial failures and scopes processing from allowed object key', async () => {
  const processed = [];
  const worker = createImportWorker({ bucketName: 'imports', service: { async processImport(input) { processed.push(input); } }, objectReader: async () => 'csv' });
  const entry = (id, key, bucket = 'imports') => ({ messageId: id, body: JSON.stringify({ Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] }) });
  const batchId = 'a'.repeat(64);
  const result = await worker({ Records: [entry('good', `tenants/org-a/events/event-1/imports/${batchId}/input.csv`), entry('bad', `tenants/org-a/events/event-1/imports/${batchId}/input.csv`, 'attacker')] });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
  assert.equal(processed[0].organizationId, 'org-a');
  assert.equal(processed[0].batchId, batchId);
});
