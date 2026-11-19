import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryEventsRepository, DynamoEventsRepository } from './repository.mjs';
import { createEventsHandler } from './index.mjs';

const actor = (code = 'event', overrides = {}) => ({
  subject: 'owner',
  organizationId: 'org-a',
  roles: ['admin'],
  eventIds: null,
  plan: { code },
  limits: { maxActiveEvents: { pilot: null, event: 1, organizer: 5, team: 20 }[code] },
  capabilities: { manageTemplates: ['organizer', 'team'].includes(code) },
  accessGuards: [],
  ...overrides,
});
const event = (id, org = 'org-a') => ({
  organizationId: org,
  eventId: id,
  name: id,
  currency: 'MXN',
  createdAt: '2026-11-19T00:00:00Z',
});
const request = (method, path, body) => ({
  rawPath: path,
  requestContext: {
    http: { method, path },
    authorizer: {
      jwt: { claims: { sub: 'owner', 'custom:organizationId': 'org-a', 'custom:roles': 'admin' } },
    },
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const body = (response) => JSON.parse(response.body);
const internal = (action, fields) => ({
  internal: { action, organizationId: 'org-a', eventId: 'e1', ...fields },
});

test('one last event slot is atomic under concurrent creates and replay consumes no slot', async () => {
  const repository = new MemoryEventsRepository();
  const results = await Promise.allSettled(
    ['e1', 'e2'].map((id) => repository.insertEvent(event(id), { actor: actor() })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'EVENT_LIMIT_REACHED',
  );
  const existing = (await repository.listEvents({ organizationId: 'org-a' }))[0];
  assert.equal((await repository.insertEvent(existing, { actor: actor() })).created, false);
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 1);
});

test('legacy events count before quota initialization, pilot stays uncapped, tenant counters are separate', async () => {
  const repository = new MemoryEventsRepository();
  await repository.insertEvent(event('old1'));
  await repository.insertEvent(event('old2'));
  await assert.rejects(repository.insertEvent(event('e3'), { actor: actor() }), {
    code: 'EVENT_LIMIT_REACHED',
  });
  await repository.insertEvent(event('e3'), { actor: actor('pilot') });
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 3);
  await repository.insertEvent(event('b1', 'org-b'), {
    actor: actor('event', { organizationId: 'org-b' }),
  });
  assert.equal((await repository.getUsage({ organizationId: 'org-b' })).nonArchivedEvents, 1);
  assert.equal((await repository.listEvents({ organizationId: 'org-a' })).length, 3);
});

test('archive and reopening reserve quota once with durable replay and metadata OCC', async () => {
  const repository = new MemoryEventsRepository();
  const created = (await repository.insertEvent(event('e1'), { actor: actor() })).value;
  const command = {
    operationId: 'archive-1',
    expectedEventRevision: created.revision,
    closureId: 'close-1',
    closureVersion: 1,
  };
  const archived = await repository.archiveEvent(
    { organizationId: 'org-a', eventId: 'e1' },
    command,
    { actor: actor() },
  );
  assert.ok(archived.archivedAt);
  assert.deepEqual(
    await repository.archiveEvent({ organizationId: 'org-a', eventId: 'e1' }, command, {
      actor: actor(),
    }),
    archived,
  );
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 0);
  await assert.rejects(
    repository.beginReopen(
      { organizationId: 'org-a', eventId: 'e1' },
      {
        operationId: 'reopen-stale',
        closureId: 'close-1',
        expectedEventRevision: created.revision,
      },
      { actor: actor() },
    ),
    { code: 'EVENT_VERSION_CONFLICT' },
  );
  const reopen = {
    operationId: 'reopen-1',
    closureId: 'close-1',
    expectedEventRevision: archived.revision,
  };
  const reserved = await repository.beginReopen(
    { organizationId: 'org-a', eventId: 'e1' },
    reopen,
    { actor: actor() },
  );
  assert.equal(reserved.reopening.operationId, 'reopen-1');
  assert.equal(reserved.archivedAt, undefined);
  assert.deepEqual(
    await repository.beginReopen({ organizationId: 'org-a', eventId: 'e1' }, reopen, {
      actor: actor(),
    }),
    reserved,
  );
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 1);
  await assert.rejects(
    repository.archiveEvent(
      { organizationId: 'org-a', eventId: 'e1' },
      { ...command, operationId: 'archive-2', expectedEventRevision: reserved.revision },
      { actor: actor() },
    ),
    { code: 'EVENT_TRANSITION_PENDING' },
  );
  const finished = await repository.finalizeReopen(
    { organizationId: 'org-a', eventId: 'e1' },
    { operationId: 'reopen-1', lifecycleVersion: 2 },
    { actor: actor() },
  );
  assert.equal(finished.reopening, undefined);
  assert.equal(finished.lastReopenLifecycleVersion, 2);
  assert.deepEqual(
    await repository.finalizeReopen(
      { organizationId: 'org-a', eventId: 'e1' },
      { operationId: 'reopen-1', lifecycleVersion: 2 },
      { actor: actor() },
    ),
    finished,
  );
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 1);
});

test('archive and beginReopen cannot both commit from the same event revision', async () => {
  const repository = new MemoryEventsRepository();
  const scope = { organizationId: 'org-a', eventId: 'e1' };
  const created = (await repository.insertEvent(event('e1'), { actor: actor() })).value;
  const results = await Promise.allSettled([
    repository.archiveEvent(
      scope,
      {
        operationId: 'a',
        closureId: 'c',
        closureVersion: 1,
        expectedEventRevision: created.revision,
      },
      { actor: actor() },
    ),
    repository.beginReopen(
      scope,
      { operationId: 'r', closureId: 'c', expectedEventRevision: created.revision },
      { actor: actor() },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});

test('participant writes advance revision once and cannot mutate archived/reopening events', async () => {
  const repository = new MemoryEventsRepository();
  const scope = { organizationId: 'org-a', eventId: 'e1' };
  await repository.insertEvent(event('e1'), { actor: actor() });
  const person = {
    ...scope,
    participantId: 'p1',
    name: 'Ana',
    reference: 'A',
    agreedMinor: '100',
    currency: 'MXN',
  };
  const before = (await repository.getEvent(scope)).revision;
  await repository.insertParticipant(person, { actor: actor() });
  assert.equal((await repository.getEvent(scope)).revision, before + 1);
  await repository.insertParticipant(person, { actor: actor() });
  assert.equal((await repository.getEvent(scope)).revision, before + 1);
  await repository.archiveEvent(
    scope,
    { operationId: 'a', closureId: 'c', closureVersion: 1, expectedEventRevision: before + 1 },
    { actor: actor() },
  );
  await assert.rejects(
    repository.insertParticipant({ ...person, participantId: 'p2' }, { actor: actor() }),
    { code: 'EVENT_ARCHIVED' },
  );
  assert.equal((await repository.getContext(scope)).participants.length, 1);
});

test('template routes enforce capability, copy roster only, create event atomically and support replay', async () => {
  const repository = new MemoryEventsRepository();
  let current = actor('organizer');
  const handler = createEventsHandler({ repository, accessResolver: async () => current });
  await handler(
    request('POST', '/api/v1/events', { eventId: 'source', name: 'Fuente', currency: 'MXN' }),
  );
  await handler(
    request('POST', '/api/v1/events/source/participants', {
      participantId: 'old-person',
      name: 'Ana',
      reference: 'A',
      agreedMinor: '100',
    }),
  );
  const created = await handler(
    request('POST', '/api/v1/templates', {
      operationId: 'template-one',
      name: 'Curso',
      sourceEventId: 'source',
    }),
  );
  assert.equal(created.statusCode, 201);
  const template = body(created).template;
  assert.equal(template.version, 1);
  assert.equal(template.participantCount, 1);
  assert.deepEqual(template.participants, [{ name: 'Ana', reference: 'A', agreedMinor: '100' }]);
  const input = { operationId: 'apply-one', name: 'Nuevo', expectedTemplateVersion: 1 };
  const applied = await handler(
    request('POST', `/api/v1/templates/${template.templateId}/events`, input),
  );
  assert.equal(applied.statusCode, 201);
  const newEvent = body(applied).event;
  assert.equal(
    (await repository.listParticipants({ organizationId: 'org-a', eventId: newEvent.eventId }))
      .length,
    1,
  );
  assert.notEqual(
    (await repository.listParticipants({ organizationId: 'org-a', eventId: newEvent.eventId }))[0]
      .participantId,
    'old-person',
  );
  assert.equal(
    (await handler(request('POST', `/api/v1/templates/${template.templateId}/events`, input)))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await handler(
        request('POST', `/api/v1/templates/${template.templateId}/events`, {
          ...input,
          expectedTemplateVersion: 2,
        }),
      )
    ).statusCode,
    409,
  );
  current = actor('event');
  assert.equal(
    (await handler(request('GET', `/api/v1/templates/${template.templateId}`))).statusCode,
    200,
  );
  assert.equal(
    (
      await handler(
        request('POST', '/api/v1/templates', {
          operationId: 'blocked',
          name: 'No',
          sourceEventId: 'source',
        }),
      )
    ).statusCode,
    403,
  );
  assert.equal(body(await handler(request('GET', '/api/v1/events'))).events.length, 2);
});

test('templates reject more than 90 participants and event grants filter every discovery route', async () => {
  const repository = new MemoryEventsRepository();
  await repository.insertEvent(event('e1'));
  await repository.insertEvent(event('e2'));
  for (let index = 0; index < 91; index++)
    await repository.insertParticipant({
      organizationId: 'org-a',
      eventId: 'e1',
      participantId: `p${index}`,
      name: 'Ana',
      reference: `P${index}`,
      agreedMinor: '100',
      currency: 'MXN',
    });
  let current = actor('organizer');
  const handler = createEventsHandler({ repository, accessResolver: async () => current });
  assert.equal(
    (
      await handler(
        request('POST', '/api/v1/templates', {
          operationId: 'large',
          name: 'Grande',
          sourceEventId: 'e1',
        }),
      )
    ).statusCode,
    413,
  );
  current = actor('organizer', { eventIds: ['e1'] });
  assert.deepEqual(
    body(await handler(request('GET', '/api/v1/events'))).events.map((item) => item.eventId),
    ['e1'],
  );
  assert.equal((await handler(request('GET', '/api/v1/events/e2/participants'))).statusCode, 404);
});

test('internal transitions reject HTTP forgery and getEvent returns stable revision', async () => {
  const repository = new MemoryEventsRepository();
  const handler = createEventsHandler({ repository });
  await handler(request('POST', '/api/v1/events', { eventId: 'e1', name: 'Uno', currency: 'MXN' }));
  const context = await handler(internal('getEvent', {}));
  assert.equal(context.event.revision, 1);
  const forged = {
    ...request('GET', '/api/v1/events'),
    ...internal('archiveEvent', {
      operationId: 'a',
      expectedEventRevision: 1,
      closureId: 'c',
      closureVersion: 1,
    }),
  };
  assert.equal((await handler(forged)).statusCode, 400);
});

test('Dynamo event create writes quota/event and Identity read guards in one transaction', async () => {
  const calls = [];
  const guard = {
    ConditionCheck: {
      TableName: 'Identity',
      Key: { pk: 'ORG#org-a', sk: 'PLAN' },
      ConditionExpression: '#data = :snapshot',
      ExpressionAttributeNames: { '#data': 'data' },
      ExpressionAttributeValues: { ':snapshot': { assignmentVersion: 2 } },
    },
  };
  const repository = new DynamoEventsRepository({
    tableName: 'Events',
    accessConditions: () => [guard],
    client: {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === 'QueryCommand') return { Items: [] };
        return {};
      },
    },
  });
  await repository.insertEvent(event('e1'), { actor: actor() });
  const transaction = calls.find((command) => command.constructor.name === 'TransactWriteCommand');
  assert.ok(transaction);
  assert.deepEqual(transaction.input.TransactItems[0], guard);
  const usage = transaction.input.TransactItems.find((item) => item.Put?.Item.sk === 'USAGE#EVENTS')
    .Put.Item;
  assert.equal(usage.nonArchivedCount, 1);
  assert.equal(usage.version, 1);
  assert.equal(
    transaction.input.TransactItems.filter((item) => item.Put?.Item.sk === 'EVENT#e1').length,
    1,
  );
});

test('one operation cannot create two explicit event IDs or consume quota twice', async () => {
  const repository = new MemoryEventsRepository();
  const handler = createEventsHandler({
    repository,
    accessResolver: async () => actor('organizer'),
  });
  const input = { eventId: 'first', operationId: 'one-creation', name: 'Uno', currency: 'MXN' };
  assert.equal((await handler(request('POST', '/api/v1/events', input))).statusCode, 201);
  assert.equal(
    (await handler(request('POST', '/api/v1/events', { ...input, eventId: 'second' }))).statusCode,
    409,
  );
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 1);
});

test('memory access validation is synchronous at transaction boundary and usage exposes downgrade guard', async () => {
  let allowed = false;
  const repository = new MemoryEventsRepository({
    validateAccess: () => {
      if (!allowed) throw Object.assign(new Error('changed'), { code: 'ACCESS_CHANGED' });
    },
  });
  await assert.rejects(repository.insertEvent(event('blocked'), { actor: actor('organizer') }), {
    code: 'ACCESS_CHANGED',
  });
  assert.equal(repository.getUsageSync({ organizationId: 'org-a' }).nonArchivedEvents, 0);
  allowed = true;
  await repository.insertEvent(event('e1'), { actor: actor('organizer') });
  const usage = repository.getUsageSync({ organizationId: 'org-a' });
  repository.assertUsageGuardSync({ organizationId: 'org-a', ...usage });
  await repository.insertEvent(event('e2'), { actor: actor('organizer') });
  assert.throws(() => repository.assertUsageGuardSync({ organizationId: 'org-a', ...usage }), {
    code: 'USAGE_CHANGED',
  });
});

test('roster context retries an interleaved participant write instead of returning mixed revisions', async () => {
  class Interleaved extends MemoryEventsRepository {
    calls = 0;
    async listParticipants(scope) {
      const result = await super.listParticipants(scope);
      if (++this.calls === 1)
        await this.insertParticipant(
          { ...scope, participantId: 'p1', name: 'Ana', reference: 'A', agreedMinor: '100' },
          { actor: actor() },
        );
      return result;
    }
  }
  const repository = new Interleaved();
  await repository.insertEvent(event('e1'), { actor: actor() });
  const context = await repository.getContext({ organizationId: 'org-a', eventId: 'e1' });
  assert.equal(repository.calls, 2);
  assert.equal(context.event.revision, 2);
  assert.equal(context.participants.length, 1);
});

test('failed reopen quota reservation preserves the closed archive and existing capacity', async () => {
  const repository = new MemoryEventsRepository();
  const scope = { organizationId: 'org-a', eventId: 'e1' };
  await repository.insertEvent(event('e1'), { actor: actor() });
  const archived = await repository.archiveEvent(
    scope,
    { operationId: 'a', closureId: 'c', closureVersion: 1, expectedEventRevision: 1 },
    { actor: actor() },
  );
  await repository.insertEvent(event('e2'), { actor: actor() });
  await assert.rejects(
    repository.beginReopen(
      scope,
      { operationId: 'r', closureId: 'c', expectedEventRevision: archived.revision },
      { actor: actor() },
    ),
    { code: 'EVENT_LIMIT_REACHED' },
  );
  assert.deepEqual(await repository.getEvent(scope), archived);
  assert.equal((await repository.getUsage(scope)).nonArchivedEvents, 1);
});

test('Dynamo quota transaction rejects an Identity change without retrying stale access', async () => {
  let writes = 0;
  const guard = {
    ConditionCheck: {
      TableName: 'Identity',
      Key: { pk: 'ORG#org-a', sk: 'PLAN' },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
  const repository = new DynamoEventsRepository({
    tableName: 'Events',
    accessConditions: () => [guard],
    client: {
      async send(command) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] };
        if (command.constructor.name === 'TransactWriteCommand') {
          writes++;
          throw Object.assign(new Error('stale'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
        return {};
      },
    },
  });
  await assert.rejects(repository.insertEvent(event('e1'), { actor: actor() }), {
    code: 'ACCESS_CHANGED',
  });
  assert.equal(writes, 1);
});

test('90-row template application fits one guarded Dynamo transaction', async () => {
  let transaction;
  const guards = [0, 1, 2].map((index) => ({
    ConditionCheck: {
      TableName: 'Identity',
      Key: { pk: 'USER', sk: `GUARD${index}` },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  }));
  const repository = new DynamoEventsRepository({
    tableName: 'Events',
    accessConditions: () => guards,
    client: {
      async send(command) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] };
        if (command.constructor.name === 'TransactWriteCommand')
          transaction = command.input.TransactItems;
        return {};
      },
    },
  });
  const participants = Array.from({ length: 90 }, (_, index) => ({
    organizationId: 'org-a',
    eventId: 'new',
    participantId: `p${index}`,
    name: 'Ana',
    reference: `P${index}`,
    agreedMinor: '100',
    currency: 'MXN',
  }));
  await repository.insertEvent(event('new'), {
    actor: actor('organizer'),
    participants,
    template: { templateId: 't1', version: 1 },
    operationId: 'bulk',
  });
  assert.equal(transaction.length, 97);
  assert.equal(
    transaction.filter((item) => item.Put?.Item.sk.startsWith('PARTICIPANT#')).length,
    90,
  );
  assert.ok(transaction.some((item) => item.ConditionCheck?.Key.sk === 'TEMPLATE#t1'));
  assert.ok(
    transaction.filter((item) => item.Put).every((item) => item.Put.TableName === 'Events'),
  );
});

test('template quota failure never creates a partial event or roster', async () => {
  const repository = new MemoryEventsRepository();
  const limited = actor('organizer', { limits: { maxActiveEvents: 1 } });
  const handler = createEventsHandler({ repository, accessResolver: async () => limited });
  await handler(
    request('POST', '/api/v1/events', { eventId: 'source', name: 'Fuente', currency: 'MXN' }),
  );
  await handler(
    request('POST', '/api/v1/events/source/participants', {
      name: 'Ana',
      reference: 'A',
      agreedMinor: '100',
    }),
  );
  const template = body(
    await handler(
      request('POST', '/api/v1/templates', {
        operationId: 't',
        name: 'Curso',
        sourceEventId: 'source',
      }),
    ),
  ).template;
  const result = await handler(
    request('POST', `/api/v1/templates/${template.templateId}/events`, {
      operationId: 'apply',
      name: 'Nuevo',
      expectedTemplateVersion: 1,
    }),
  );
  assert.equal(result.statusCode, 409);
  assert.equal(body(result).error.code, 'EVENT_LIMIT_REACHED');
  assert.equal((await repository.listEvents({ organizationId: 'org-a' })).length, 1);
  assert.equal((await repository.getUsage({ organizationId: 'org-a' })).nonArchivedEvents, 1);
});

test('legacy zero revision can archive and internal transition payloads require positive closure versions', async () => {
  const repository = new MemoryEventsRepository();
  await repository.insertEvent(event('e1'));
  const handler = createEventsHandler({ repository });
  assert.equal((await handler(internal('getEvent', {}))).event.revision, 0);
  const result = await handler(
    internal('archiveEvent', {
      actor: actor(),
      operationId: 'a',
      closureId: 'c',
      closureVersion: 0,
      expectedEventRevision: 0,
    }),
  );
  assert.equal(result.statusCode, 400);
  const valid = await handler(
    internal('archiveEvent', {
      actor: actor(),
      operationId: 'a',
      closureId: 'c',
      closureVersion: 1,
      expectedEventRevision: 0,
    }),
  );
  assert.equal(valid.event.revision, 1);
  assert.ok(valid.event.archivedAt);
});
