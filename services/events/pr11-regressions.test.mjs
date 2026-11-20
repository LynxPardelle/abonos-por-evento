import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventsHandler } from './index.mjs';
import { MemoryEventsRepository } from './repository.mjs';

const scope = { organizationId: 'org-regression', eventId: 'future-event' };
const actor = (overrides) => ({
  subject: 'owner',
  organizationId: scope.organizationId,
  roles: ['operator'],
  eventIds: null,
  capabilities: { createEvent: true },
  limits: { maxActiveEvents: 5 },
  accessGuards: [],
  ...overrides,
});
const request = (body) => ({
  rawPath: '/api/v1/events',
  requestContext: { http: { method: 'POST' } },
  body: JSON.stringify(body),
});
const create = {
  eventId: scope.eventId,
  operationId: 'create-event',
  name: 'Regresión PR11',
  currency: 'MXN',
};
const internal = (action, input, currentActor = actor()) => ({
  internal: { action, ...scope, ...input, actor: currentActor },
});

test('scoped operator cannot create an allowed future event or consume quota', async () => {
  const repository = new MemoryEventsRepository();
  let resolverOptions;
  const handler = createEventsHandler({
    repository,
    accessResolver: async (_request, _roles, options) => {
      resolverOptions = options;
      return actor({
        eventIds: [scope.eventId],
        capabilities: { createEvent: false },
      });
    },
  });
  const response = await handler(request(create));
  assert.equal(response.statusCode, 403);
  assert.equal(resolverOptions.capability, 'createEvent');
  assert.equal(await repository.getEvent(scope), null);
  assert.equal((await repository.getUsage(scope)).nonArchivedCount, 0);
});

test('event creation requires capability even for an unscoped injected actor', async () => {
  const repository = new MemoryEventsRepository();
  const denied = createEventsHandler({
    repository,
    accessResolver: async () => actor({ capabilities: { createEvent: false } }),
  });
  assert.equal((await denied(request(create))).statusCode, 403);
  assert.equal((await repository.getUsage(scope)).nonArchivedCount, 0);
  const allowed = createEventsHandler({
    repository,
    accessResolver: async () => actor(),
  });
  assert.equal((await allowed(request(create))).statusCode, 201);
  assert.equal((await repository.getUsage(scope)).nonArchivedCount, 1);
});

for (const length of [81, 256]) {
  test(`internal archive, begin and finalize accept ${length}-character operation IDs and replay without quota drift`, async () => {
    const repository = new MemoryEventsRepository();
    const handler = createEventsHandler({
      repository,
      accessResolver: async () => actor(),
    });
    const created = JSON.parse((await handler(request(create))).body).event;
    const archive = internal('archiveEvent', {
      operationId: 'a'.repeat(length),
      expectedEventRevision: created.revision,
      closureId: 'close-1',
      closureVersion: 1,
    });
    const archived = await handler(archive);
    assert.equal(archived.statusCode, undefined, 'The IAM lifecycle request must succeed');
    assert.ok(archived.event.archivedAt);
    assert.deepEqual(await handler(archive), archived);
    assert.equal((await repository.getUsage(scope)).nonArchivedCount, 0);
    const reopen = internal('beginReopen', {
      operationId: 'r'.repeat(length),
      expectedEventRevision: archived.event.revision,
      closureId: 'close-1',
    });
    const reserved = await handler(reopen);
    assert.equal(reserved.statusCode, undefined);
    assert.equal(reserved.event.reopening.operationId.length, length);
    assert.deepEqual(await handler(reopen), reserved);
    assert.equal((await repository.getUsage(scope)).nonArchivedCount, 1);
    const finalize = internal('finalizeReopen', {
      operationId: 'r'.repeat(length),
      lifecycleVersion: 2,
    });
    const finished = await handler(finalize);
    assert.equal(finished.statusCode, undefined);
    assert.equal(finished.event.reopening, undefined);
    assert.deepEqual(await handler(finalize), finished);
    assert.equal((await repository.getUsage(scope)).nonArchivedCount, 1);
  });
}

test('257-character lifecycle operation IDs reject before state or quota changes at every step', async () => {
  const repository = new MemoryEventsRepository();
  const handler = createEventsHandler({
    repository,
    accessResolver: async () => actor(),
  });
  const created = JSON.parse((await handler(request(create))).body).event;
  async function assertRejected(action, input) {
    const before = await repository.getEvent(scope);
    const usage = await repository.getUsage(scope);
    const response = await handler(internal(action, { ...input, operationId: 'x'.repeat(257) }));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_OPERATION');
    assert.deepEqual(await repository.getEvent(scope), before);
    assert.deepEqual(await repository.getUsage(scope), usage);
  }
  const archiveInput = {
    operationId: 'archive-short',
    expectedEventRevision: created.revision,
    closureId: 'close-1',
    closureVersion: 1,
  };
  await assertRejected('archiveEvent', archiveInput);
  const archived = await handler(internal('archiveEvent', archiveInput));
  const reopenInput = {
    operationId: 'reopen-short',
    expectedEventRevision: archived.event.revision,
    closureId: 'close-1',
  };
  await assertRejected('beginReopen', reopenInput);
  await handler(internal('beginReopen', reopenInput));
  await assertRejected('finalizeReopen', { lifecycleVersion: 2 });
});
