import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconciliationService } from './application.mjs';
import { MemoryReconciliationRepository } from './repository.mjs';

test('overview groups active event balances by currency without adding archived events or mixed money', async () => {
  const events = [{ eventId: 'mx', currency: 'MXN' }, { eventId: 'usd', currency: 'USD' }, { eventId: 'old', currency: 'MXN', archivedAt: '2026-11-01' }].map(event => ({ ...event, organizationId: 'org-a', name: event.eventId }));
  const actor = { organizationId: 'org-a', subject: 'owner', roles: ['admin'], capabilities: { viewOverview: true } };
  const service = createReconciliationService({ repository: new MemoryReconciliationRepository(), eventLister: async () => ({ events, usage: { nonArchivedCount: 2 } }), eventReader: async scope => ({ event: events.find(event => event.eventId === scope.eventId), participants: [{ participantId: 'one', name: 'Participante', agreedMinor: scope.eventId === 'mx' ? '100000' : '50000' }] }), uploadSigner: async () => ({}) });
  assert.equal(typeof service.overview, 'function', 'Expose an organization overview backed by each ledger');
  const overview = await service.overview(actor);
  assert.equal(overview.events.length, 2); assert.equal(overview.activeOnly, true);
  assert.deepEqual(overview.totalsByCurrency.map(total => [total.currency, total.agreedMinor]), [['MXN', '100000'], ['USD', '50000']]);
  await assert.rejects(service.overview({ ...actor, eventIds: ['mx'] }), { code: 'FORBIDDEN' });
  await assert.rejects(service.overview({ ...actor, capabilities: { viewOverview: false } }), { code: 'PLAN_CAPABILITY_REQUIRED' });
});
