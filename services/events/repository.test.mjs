import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamoEventsRepository, MemoryEventsRepository } from './repository.mjs';

test('memory repository returns detached data and tenant-scoped participant collections', async () => {
  const repository = new MemoryEventsRepository();
  await repository.insertEvent({ organizationId: 'org-a', eventId: 'event-1', name: 'Original' });
  await repository.insertParticipant({ organizationId: 'org-a', eventId: 'event-1', participantId: 'p1', name: 'Ana' });
  await repository.insertParticipant({ organizationId: 'org-b', eventId: 'event-1', participantId: 'p2', name: 'Luis' });
  const event = await repository.getEvent({ organizationId: 'org-a', eventId: 'event-1' });
  event.name = 'Changed';
  assert.equal((await repository.getEvent({ organizationId: 'org-a', eventId: 'event-1' })).name, 'Original');
  assert.equal(await repository.getEvent({ organizationId: 'org-b', eventId: 'event-1' }), null);
  assert.deepEqual((await repository.listParticipants({ organizationId: 'org-a', eventId: 'event-1' })).map((person) => person.name), ['Ana']);
});

test('DynamoDB adapter reads tenant keys and follows query pagination without a scan', async () => {
  const calls = [];
  const cursor = { pk: 'ORG#org-a#EVENT#event-1', sk: 'PARTICIPANT#p1' };
  const replies = [
    { Item: { data: { eventId: 'event-1' } } },
    { Items: [{ data: { participantId: 'p1' } }], LastEvaluatedKey: cursor },
    { Items: [{ data: { participantId: 'p2' } }] },
  ];
  const repository = new DynamoEventsRepository({ tableName: 'Events', client: { async send(command) { calls.push(command); return replies.shift(); } } });
  assert.deepEqual(await repository.getEvent({ organizationId: 'org-a', eventId: 'event-1' }), { eventId: 'event-1' });
  assert.deepEqual(await repository.listParticipants({ organizationId: 'org-a', eventId: 'event-1' }), [{ participantId: 'p1' }, { participantId: 'p2' }]);
  assert.deepEqual(calls[0].input.Key, { pk: 'ORG#org-a', sk: 'EVENT#event-1' });
  assert.equal(calls[0].input.ConsistentRead, true);
  assert.deepEqual(calls.slice(1).map((command) => command.constructor.name), ['QueryCommand', 'QueryCommand']);
  assert.deepEqual(calls[1].input.ExpressionAttributeValues, { ':pk': 'ORG#org-a#EVENT#event-1', ':prefix': 'PARTICIPANT#' });
  assert.deepEqual(calls[2].input.ExclusiveStartKey, cursor);
});

test('DynamoDB conditional create returns existing data after a concurrent duplicate', async () => {
  const original = { organizationId: 'org-a', eventId: 'event-1', name: 'Original' };
  const calls = [];
  const repository = new DynamoEventsRepository({ tableName: 'Events', client: { async send(command) {
    calls.push(command);
    if (command.constructor.name === 'PutCommand') throw Object.assign(new Error('collision'), { name: 'ConditionalCheckFailedException' });
    return { Item: { data: original } };
  } } });
  assert.deepEqual(await repository.insertEvent({ ...original, name: 'Changed' }), { created: false, value: original });
  assert.equal(calls[0].input.ConditionExpression, 'attribute_not_exists(pk)');
  assert.deepEqual(calls[1].input.Key, { pk: 'ORG#org-a', sk: 'EVENT#event-1' });
});
