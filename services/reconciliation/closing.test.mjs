import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconciliationService } from './application.mjs';
import { MemoryReconciliationRepository } from './repository.mjs';

const scope = { organizationId: 'org-a', eventId: 'event-a' };
const owner = { organizationId: 'org-a', subject: 'owner-a', roles: ['admin'], isOwner: true, capabilities: { closeEvent: true, exportEvent: true, viewOverview: true }, limits: { maxActiveEvents: 1 } };
const people = [
  { participantId: 'ana', name: 'Ana', reference: 'ANA-01', agreedMinor: '100000' },
  { participantId: 'bruno', name: 'Bruno', reference: 'BRUNO-02', agreedMinor: '100000' },
];

function fixture({ participants = people, failFinalizeOnce = false, quotaBlocked = false } = {}) {
  const repository = new MemoryReconciliationRepository();
  let event = { ...scope, name: 'Evento de prueba', currency: 'MXN', revision: 0 };
  let roster = structuredClone(participants); let reservations = 0; let finalizations = 0; let beginCalls = 0;
  const service = createReconciliationService({
    repository,
    eventReader: async requested => requested.organizationId === scope.organizationId && requested.eventId === scope.eventId ? { event: structuredClone(event), participants: structuredClone(roster) } : {},
    eventCommand: async (action, requested, input) => {
      assert.equal(requested.organizationId, scope.organizationId);
      if (action === 'archiveEvent') { assert.equal((await repository.loadLedger(scope, 'MXN')).financialStatus, 'closed'); event = { ...event, archivedAt: '2026-11-19T22:00:00Z', archiveClosureId: input.closureId, revision: event.revision + 1 }; }
      if (action === 'beginReopen') {
        beginCalls++;
        assert.equal((await repository.loadLedger(scope, 'MXN')).financialStatus, 'closed');
        if (quotaBlocked) { const error = new Error('No hay capacidad.'); error.code = 'EVENT_LIMIT_REACHED'; throw error; }
        if (!event.reopening) { reservations++; event = { ...event, archivedAt: undefined, revision: event.revision + 1, reopening: { kind: 'reopening', operationId: input.operationId, closureId: input.closureId } }; }
      }
      if (action === 'finalizeReopen') {
        assert.equal((await repository.loadLedger(scope, 'MXN')).financialStatus, 'open'); finalizations++;
        if (failFinalizeOnce && finalizations === 1) throw new Error('Simulated transport failure after ledger reopened');
        event = { ...event, reopening: undefined, revision: event.revision + 1 };
      }
      return { event: structuredClone(event) };
    },
    uploadSigner: async () => ({}), now: () => '2026-11-19T22:00:00.000Z',
  });
  assert.equal(typeof service.close, 'function', 'Expose a financial close backed by a persisted snapshot');
  return { service, repository, event: () => event, setRoster: value => { roster = structuredClone(value); event.revision++; }, reservations: () => reservations, beginCalls: () => beginCalls };
}

const pay = (service, operationId = 'pay-ana', expectedVersion = 0, participantId = 'ana', amountMinor = '50000') => service.recordPayment(owner, 'event-a', { operationId, expectedVersion, participantId, reference: operationId, amountMinor, currency: 'MXN' });
const close = (service, expectedLedgerVersion = 0, expectedLifecycleVersion = 0, operationId = 'close-a') => service.close(owner, 'event-a', { operationId, expectedLedgerVersion, expectedLifecycleVersion });

test('financial close persists exact captured balances and replay cannot create another snapshot', async () => {
  const { service } = fixture(); await pay(service); await pay(service, 'pay-bruno', 1, 'bruno', '75000');
  const result = await close(service, 2);
  assert.equal(result.financialStatus, 'closed'); assert.equal(result.ledgerVersion, 2);
  assert.equal(result.latestClosure.totals.paidMinor, '125000');
  assert.equal(result.latestClosure.totals.pendingMinor, '75000');
  assert.equal(result.latestClosure.rosterRevision, 0);
  assert.equal((await close(service, 2)).latestClosure.closureId, result.latestClosure.closureId);
  assert.equal((await service.closing(owner, 'event-a')).closures.length, 1);
});

test('closed ledger rejects new financial mutations but returns an already committed retry', async () => {
  const { service } = fixture(); const first = await pay(service); await close(service, 1);
  assert.equal((await pay(service)).movement.movementId, first.movement.movementId);
  await assert.rejects(pay(service, 'new-payment', 1), { code: 'EVENT_CLOSED' });
  await assert.rejects(service.reverse(owner, 'event-a', first.movement.movementId, { operationId: 'reverse-closed', expectedVersion: 1 }), { code: 'EVENT_CLOSED' });
  assert.equal((await service.movements(owner, 'event-a')).movements.length, 1);
});

test('payment and close competing on the same version cannot both commit', async () => {
  const { service } = fixture();
  const results = await Promise.allSettled([pay(service), close(service)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const ledger = await service.movements(owner, 'event-a');
  const status = await service.closing(owner, 'event-a');
  assert.ok((status.financialStatus === 'closed' && ledger.movements.length === 0) || (status.financialStatus === 'open' && ledger.movements.length === 1));
});

test('closing and reopening an empty ledger preserves version zero and permits the first payment', async () => {
  const { service, event } = fixture(); const closed = await close(service);
  await service.reopen(owner, 'event-a', { operationId: 'reopen-empty', expectedLifecycleVersion: closed.lifecycleVersion, expectedEventRevision: event().revision });
  assert.equal((await pay(service)).version, 1);
});

test('reopen reserves the event before opening the ledger and can recover a lost finalization', async () => {
  const { service, event, reservations } = fixture({ failFinalizeOnce: true });
  const closed = await close(service);
  const input = { operationId: 'reopen-retry', expectedLifecycleVersion: closed.lifecycleVersion, expectedEventRevision: event().revision };
  await assert.rejects(service.reopen(owner, 'event-a', input));
  assert.equal((await service.closing(owner, 'event-a')).financialStatus, 'open');
  assert.ok(event().reopening);
  await service.reopen(owner, 'event-a', input);
  assert.equal(event().reopening, undefined); assert.equal(reservations(), 1);
});

test('a capacity rejection leaves an archived ledger closed', async () => {
  const { service, event } = fixture({ quotaBlocked: true }); const closed = await close(service);
  await service.archive(owner, 'event-a', { operationId: 'archive-a', expectedLifecycleVersion: closed.lifecycleVersion, expectedEventRevision: event().revision });
  await assert.rejects(service.reopen(owner, 'event-a', { operationId: 'no-capacity', expectedLifecycleVersion: closed.lifecycleVersion, expectedEventRevision: event().revision }), { code: 'EVENT_LIMIT_REACHED' });
  assert.equal((await service.closing(owner, 'event-a')).financialStatus, 'closed'); assert.ok(event().archivedAt);
});

test('reloading a reserved reopen recovers when the ledger write failed before committing', async () => {
  const { service, repository, event, reservations, beginCalls } = fixture(); const state = await close(service);
  const original = repository.reopenLedger.bind(repository); let attempts = 0;
  repository.reopenLedger = async (...args) => { if (++attempts === 1) throw new Error('Ledger transport unavailable'); return original(...args); };
  const input = { operationId: 'reopen-reserved', expectedLifecycleVersion: state.lifecycleVersion, expectedEventRevision: event().revision };
  await assert.rejects(service.reopen(owner, 'event-a', input), /transport/);
  const pending = await service.closing(owner, 'event-a');
  assert.equal(pending.financialStatus, 'closed'); assert.ok(pending.transition);
  await service.reopen(owner, 'event-a', { operationId: pending.transition.operationId, expectedLifecycleVersion: pending.transition.expectedLifecycleVersion, expectedEventRevision: pending.transition.expectedEventRevision });
  assert.equal(reservations(), 1); assert.equal(beginCalls(), 1); assert.equal(attempts, 2);
  assert.equal((await service.closing(owner, 'event-a')).financialStatus, 'open');
  assert.equal(event().reopening, undefined);
});

test('archive rejects a guessed future event revision before issuing its internal command', async () => {
  const { service, event } = fixture(); const state = await close(service);
  await assert.rejects(service.archive(owner, 'event-a', { operationId: 'forged-revision', expectedLifecycleVersion: state.lifecycleVersion, expectedEventRevision: 999 }), { code: 'VERSION_CONFLICT' });
  assert.equal(event().archivedAt, undefined);
});

test('historical report is immutable across roster growth and remains readable after a downgrade', async () => {
  const { service, setRoster } = fixture(); await pay(service); const closed = await close(service, 1);
  const snapshotId = closed.latestClosure.closureId;
  const original = await service.report(owner, 'event-a', snapshotId);
  setRoster([...people, { participantId: 'new-person', name: 'Nueva', reference: 'NEW', agreedMinor: '20000' }]);
  const downgraded = { ...owner, capabilities: { ...owner.capabilities, closeEvent: false, exportEvent: false } };
  assert.equal((await service.report(downgraded, 'event-a', snapshotId)).content, original.content);
  await assert.rejects(service.close(downgraded, 'event-a', { operationId: 'paid-feature', expectedLedgerVersion: 1, expectedLifecycleVersion: closed.lifecycleVersion }), { code: 'PLAN_CAPABILITY_REQUIRED' });
});

test('backend CSV escapes formula text while preserving exact large and negative money', async () => {
  const participants = [{ participantId: 'ana', name: '=SUM(1,2)', reference: '@reference', agreedMinor: '999999999999999999999999999999' }];
  const { service } = fixture({ participants }); const payment = await pay(service, 'large-payment', 0, 'ana', '123456789012345678901234567890');
  await service.reverse(owner, 'event-a', payment.movement.movementId, { operationId: 'reverse-large', expectedVersion: 1 });
  const report = await service.report(owner, 'event-a');
  assert.match(report.content, /'=SUM\(1,2\)/); assert.match(report.content, /'@reference/);
  assert.match(report.content, /1234567890123456789012345678\.90/); assert.match(report.content, /-1234567890123456789012345678\.90/);
  assert.equal(report.contentType, 'text/csv; charset=utf-8');
});

test('an importer cannot close merely by supplying a capability boolean', async () => {
  const { service } = fixture();
  await assert.rejects(service.close({ ...owner, roles: ['importer'], isOwner: false }, 'event-a', { operationId: 'forbidden', expectedLedgerVersion: 0, expectedLifecycleVersion: 0 }), { code: 'FORBIDDEN' });
});

test('oversize snapshot fails before closing or writing a partial report', async () => {
  const participants = Array.from({ length: 1300 }, (_, index) => ({ participantId: `person-${index}`, name: 'x'.repeat(120), reference: `REF-${index}`, agreedMinor: '10000' }));
  const { service } = fixture({ participants });
  await assert.rejects(close(service), { code: 'CLOSURE_TOO_LARGE' });
  assert.equal((await service.closing(owner, 'event-a')).financialStatus, 'open');
});
