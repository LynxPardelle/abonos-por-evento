import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventsHandler } from './index.mjs';
import { MemoryEventsRepository } from './repository.mjs';

const request = (method, path, body, organizationId = 'org-a', roles = 'operator') => ({
  rawPath: path,
  requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: 'user-1', 'custom:organizationId': organizationId, 'custom:roles': roles } } } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const data = (response) => JSON.parse(response.body);

test('events and participants can be created, listed and read across the pilot flow', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  const created = await handler(request('POST', '/api/v1/events', { eventId: 'event-1', name: 'Encuentro', currency: 'MXN' }));
  assert.equal(created.statusCode, 201);
  assert.equal(data(created).event.eventId, 'event-1');
  const participant = await handler(request('POST', '/api/v1/events/event-1/participants', { participantId: 'person-1', name: 'Ana', reference: 'ANA-01', agreedMinor: '150000' }));
  assert.equal(participant.statusCode, 201);
  assert.equal(data(participant).participant.currency, 'MXN');
  assert.equal(data(await handler(request('GET', '/api/v1/events'))).events.length, 1);
  assert.equal(data(await handler(request('GET', '/api/v1/events/event-1/participants'))).participants[0].agreedMinor, '150000');
  const internal = await handler({ internal: { action: 'getEvent', organizationId: 'org-a', eventId: 'event-1' } });
  assert.equal(internal.event.name, 'Encuentro');
  assert.equal(internal.participants.length, 1);
});

test('tenant and role boundaries protect event discovery and mutations', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  await handler(request('POST', '/api/v1/events', { eventId: 'same-id', name: 'Privado', currency: 'MXN' }));
  assert.deepEqual(data(await handler(request('GET', '/api/v1/events', undefined, 'org-b'))).events, []);
  assert.equal((await handler(request('GET', '/api/v1/events/same-id/participants', undefined, 'org-b'))).statusCode, 404);
  assert.equal((await handler(request('POST', '/api/v1/events', { name: 'No', currency: 'MXN' }, 'org-a', 'auditor'))).statusCode, 403);
  assert.equal((await handler(request('POST', '/api/v1/events', { name: 'No', currency: 'MXN', organizationId: 'org-b' }))).statusCode, 400);
  const forged = request('GET', '/api/v1/events');
  forged.internal = { action: 'getEvent', organizationId: 'org-b', eventId: 'same-id' };
  assert.equal((await handler(forged)).statusCode, 400);
});

test('event and participant IDs provide idempotent retries and conflict protection', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  const input = { eventId: 'event-1', name: 'Encuentro', currency: 'MXN' };
  await handler(request('POST', '/api/v1/events', input));
  assert.equal((await handler(request('POST', '/api/v1/events', input))).statusCode, 200);
  assert.equal((await handler(request('POST', '/api/v1/events', { ...input, name: 'Otro' }))).statusCode, 409);
  const person = { participantId: 'person-1', name: 'Ana', reference: 'ANA-01', agreedMinor: '100' };
  await handler(request('POST', '/api/v1/events/event-1/participants', person));
  assert.equal((await handler(request('POST', '/api/v1/events/event-1/participants', person))).statusCode, 200);
  assert.equal((await handler(request('POST', '/api/v1/events/event-1/participants', { ...person, agreedMinor: '200' }))).statusCode, 409);
});

test('participant amounts and event currency are validated before persistence', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  for (const currency of ['ZZZ', 'JPY', 'BHD']) {
    assert.equal((await handler(request('POST', '/api/v1/events', { name: 'No', currency }))).statusCode, 400);
  }
  await handler(request('POST', '/api/v1/events', { eventId: 'event-1', name: 'Encuentro', currency: 'MXN' }));
  for (const agreedMinor of ['0', '-100', '10.25', 100, '001', '1e3']) {
    const response = await handler(request('POST', '/api/v1/events/event-1/participants', { name: 'Ana', reference: 'ANA', agreedMinor }));
    assert.equal(response.statusCode, 400, `reject amount ${agreedMinor}`);
  }
  const largeAmount = '9'.repeat(30);
  assert.equal((await handler(request('POST', '/api/v1/events/event-1/participants', { name: 'Ana', reference: 'ANA', agreedMinor: largeAmount }))).statusCode, 201);
  assert.equal((await handler(request('POST', '/api/v1/events/event-1/participants', { name: 'Ana', reference: 'ANA', agreedMinor: '9'.repeat(31) }))).statusCode, 400);
});

test('operation IDs make server-generated identifiers stable across retries', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  const input = { operationId: 'create-event-1', name: 'Encuentro', currency: 'MXN' };
  const first = data(await handler(request('POST', '/api/v1/events', input))).event;
  const secondResponse = await handler(request('POST', '/api/v1/events', input));
  assert.equal(secondResponse.statusCode, 200);
  assert.deepEqual(data(secondResponse).event, first);
  const anotherTenant = data(await handler(request('POST', '/api/v1/events', input, 'org-b'))).event;
  assert.notEqual(anotherTenant.eventId, first.eventId);
  assert.equal((await handler(request('POST', '/api/v1/events', { ...input, currency: 'USD' }))).statusCode, 409);
});

test('named HTTP API stages do not become part of the business route', async () => {
  const handler = createEventsHandler({ repository: new MemoryEventsRepository() });
  const cloudRequest = request('GET', '/dev/api/v1/events');
  cloudRequest.requestContext.stage = 'dev';
  assert.equal((await handler(cloudRequest)).statusCode, 200);
  const localRequest = request('GET', '/api/v1/events');
  localRequest.requestContext.stage = 'dev';
  assert.equal((await handler(localRequest)).statusCode, 200);
  const unrelatedPath = request('GET', '/development/api/v1/events');
  unrelatedPath.requestContext.stage = 'dev';
  assert.equal((await handler(unrelatedPath)).statusCode, 404);
});
