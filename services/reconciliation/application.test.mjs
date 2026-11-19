import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReconciliationService } from './application.mjs';
import { MemoryReconciliationRepository } from './repository.mjs';
const actor = { organizationId: 'org-a', subject: 'operator' };
const context = { event: { eventId: 'event-1', currency: 'MXN' }, participants: [{ participantId: 'ana', reference: 'ANA', agreedMinor: '100000' }] };
const csv = 'provider,movement_id,participant_reference,amount,currency\nbank,bank-1,ANA,500.00,MXN';
const hash = createHash('sha256').update(csv).digest('hex');
function setup(participants = context.participants) { const repository = new MemoryReconciliationRepository(); return { repository, service: createReconciliationService({ repository, eventReader: async ({ organizationId }) => { if (organizationId !== actor.organizationId) throw Object.assign(new Error('not found'), { status: 404 }); return { ...context, participants }; }, uploadSigner: async ({ key }) => ({ url: `https://uploads.invalid/${key}`, method: 'PUT', headers: { 'content-type': 'text/csv' } }) }) }; }
test('same file is one logical batch and only explicit confirmation changes balance', async () => {
  const { service } = setup();
  const first = await service.startImport(actor, 'event-1', { operationId: 'upload-1', sha256: hash, fileName: 'payments.csv' });
  const again = await service.startImport(actor, 'event-1', { operationId: 'upload-2', sha256: hash, fileName: 'again.csv' });
  assert.equal(first.batch.batchId, again.batch.batchId);
  await service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: hash, csv });
  assert.equal((await service.balances(actor, 'event-1')).balances[0].paidMinor, '0');
  const request = { operationId: 'confirm-1', batchId: hash, rowId: '2', participantId: 'ana', expectedVersion: 0 };
  const result = await service.allocate(actor, 'event-1', request);
  assert.equal((await service.balances(actor, 'event-1')).balances[0].paidMinor, '50000');
  assert.deepEqual(await service.allocate(actor, 'event-1', request), result);
  await assert.rejects(service.allocate(actor, 'event-1', { ...request, operationId: 'confirm-2', expectedVersion: 1 }), { code: 'DUPLICATE_MOVEMENT' });
  await assert.rejects(service.getImport({ organizationId: 'org-b' }, 'event-1', hash));
});
test('hash mismatch cannot produce suggestions and replay preserves confirmed rows', async () => {
  const { service } = setup();
  await service.startImport(actor, 'event-1', { operationId: 'upload-1', sha256: hash, fileName: 'payments.csv' });
  await assert.rejects(service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: hash, csv: `${csv}\n` }), { code: 'HASH_MISMATCH' });
  await service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: hash, csv });
  await service.allocate(actor, 'event-1', { operationId: 'confirm-1', batchId: hash, rowId: '2', participantId: 'ana', expectedVersion: 0 });
  await service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: hash, csv });
  assert.equal((await service.getImport(actor, 'event-1', hash)).batch.rows[0].status, 'applied');
});
test('only one concurrent confirmation with the same expected version commits', async () => {
  const { service } = setup();
  await service.startImport(actor, 'event-1', { operationId: 'upload-1', sha256: hash, fileName: 'payments.csv' });
  await service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: hash, csv });
  const results = await Promise.allSettled(['first', 'second'].map((operationId) => service.allocate(actor, 'event-1', { operationId, batchId: hash, rowId: '2', participantId: 'ana', expectedVersion: 0 })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await service.movements(actor, 'event-1')).movements.length, 1);
});
test('oversized persisted batch becomes visibly failed without an endless queue retry', async () => {
  const { service } = setup([{ participantId: 'a'.repeat(80), reference: 'R'.repeat(160), agreedMinor: '100000' }]);
  const largeCsv = `provider,movement_id,participant_reference,amount,currency\n${Array.from({ length: 500 }, (_, index) => `${'p'.repeat(80)},${String(index).padStart(120, 'x')},${'R'.repeat(160)},12345678901234567890123456.00,MXN`).join('\n')}`;
  const sha256 = createHash('sha256').update(largeCsv).digest('hex');
  await service.startImport(actor, 'event-1', { operationId: 'upload-large', sha256, fileName: 'large.csv' });
  const result = await service.processImport({ organizationId: actor.organizationId, eventId: 'event-1', batchId: sha256, csv: largeCsv });
  assert.equal(result.batch.status, 'failed');
  assert.equal((await service.getImport(actor, 'event-1', sha256)).batch.status, 'failed');
});
test('manual payment preserves exact money, retry identity and duplicate reference protection', async () => {
  const { service } = setup();
  const input = { operationId: 'manual-first', participantId: 'ana', reference: 'receipt-001', amountMinor: '9007199254740993', currency: 'MXN', expectedVersion: 0 };
  const first = await service.recordPayment(actor, 'event-1', input);
  assert.equal(first.movement.amountMinor, '9007199254740993');
  assert.deepEqual(await service.recordPayment(actor, 'event-1', input), first);
  await assert.rejects(service.recordPayment(actor, 'event-1', { ...input, operationId: 'manual-again', expectedVersion: 1 }), { code: 'DUPLICATE_MOVEMENT' });
  await assert.rejects(service.recordPayment(actor, 'event-1', { ...input, reference: 'another', currency: 'USD' }), { code: 'CURRENCY_MISMATCH' });
  await assert.rejects(service.recordPayment(actor, 'event-1', { ...input, reference: '\nunsafe' }), { code: 'INVALID_REFERENCE' });
  await assert.rejects(service.recordPayment(actor, 'event-1', { ...input, participantId: 'unknown' }), { code: 'PARTICIPANT_NOT_FOUND' });
});
test('concurrent manual payments cannot overwrite one another', async () => {
  const { service } = setup();
  const results = await Promise.allSettled(['a', 'b'].map((id) => service.recordPayment(actor, 'event-1', { operationId: `manual-${id}`, participantId: 'ana', reference: `reference-${id}`, amountMinor: '100', currency: 'MXN', expectedVersion: 0 })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});
