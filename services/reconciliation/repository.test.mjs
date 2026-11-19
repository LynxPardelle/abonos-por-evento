import test from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoReconciliationRepository } from './repository.mjs';
import { applyPayment, createLedger } from './domain/ledger.mjs';

const scope = { organizationId: 'org-a', eventId: 'event-1' };
const pk = 'ORG#org-a#EVENT#event-1';
const batch = { batchId: 'a'.repeat(64), batchVersion: 2, status: 'ready', rows: [{ rowId: '2', status: 'applied' }] };
const cancellation = () => Object.assign(new Error('DynamoDB conditional transaction failed'), { name: 'TransactionCanceledException' });

test('Dynamo transaction atomically appends movement, advances version, updates balance and marks batch row', async () => {
  const calls = [];
  const repository = new DynamoReconciliationRepository({ tableName: 'reconciliation-test', client: { async send(command) { calls.push(command); return {}; } } });
  const first = applyPayment(createLedger('MXN'), { operationId: 'first', participantId: 'ana', provider: 'bank', externalMovementId: 'bank-1', amountMinor: '50000', currency: 'MXN', expectedVersion: 0 });
  const second = applyPayment(first, { operationId: 'second', participantId: 'ana', provider: 'bank', externalMovementId: 'bank-2', amountMinor: '25000', currency: 'MXN', expectedVersion: 1 });
  await repository.commit(scope, second, 1, batch);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof TransactWriteCommand);
  const entries = calls[0].input.TransactItems;
  assert.equal(entries.length, 4);
  assert.ok(entries.every(({ Put }) => Put.TableName === 'reconciliation-test' && Put.Item.pk === pk));
  const metadata = entries.find(({ Put }) => Put.Item.sk === 'LEDGER').Put;
  assert.equal(metadata.ExpressionAttributeValues[':previous'], 1);
  assert.deepEqual(metadata.Item.data, { version: 2, currency: 'MXN' });
  assert.equal(Object.hasOwn(metadata.Item.data, 'movements'), false);
  const movement = entries.find(({ Put }) => Put.Item.sk.startsWith('MOVEMENT#')).Put;
  assert.equal(movement.Item.data.operationId, 'second');
  assert.equal(movement.ConditionExpression, 'attribute_not_exists(pk)');
  const projection = entries.find(({ Put }) => Put.Item.sk === 'BALANCE#ana').Put.Item.data;
  assert.equal(projection.paidMinor, '75000');
  const persistedBatch = entries.find(({ Put }) => Put.Item.sk === `BATCH#${batch.batchId}`).Put;
  assert.equal(persistedBatch.ExpressionAttributeValues[':previous'], 1);
  assert.equal(persistedBatch.Item.data.rows[0].status, 'applied');
});

test('Dynamo ledger reads are tenant scoped, strongly consistent and follow all query pages', async () => {
  const calls = [];
  const cursor = { pk, sk: 'MOVEMENT#000000000002' };
  const client = { async send(command) {
    calls.push(command);
    if (command instanceof GetCommand) return { Item: { data: { currency: 'MXN', version: 3 } } };
    if (command instanceof QueryCommand && !command.input.ExclusiveStartKey) return { Items: [{ data: { sequence: 1 } }, { data: { sequence: 2 } }], LastEvaluatedKey: cursor };
    if (command instanceof QueryCommand) return { Items: [{ data: { sequence: 3 } }] };
    throw new Error('unexpected command');
  } };
  const repository = new DynamoReconciliationRepository({ tableName: 'reconciliation-test', client });
  const ledger = await repository.loadLedger(scope, 'MXN');
  assert.deepEqual(ledger.movements.map((movement) => movement.sequence), [1, 2, 3]);
  assert.equal(ledger.version, 3);
  const queries = calls.filter((command) => command instanceof QueryCommand);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].input.ExclusiveStartKey, cursor);
  assert.ok(queries.every(({ input }) => input.ConsistentRead && input.ExpressionAttributeValues[':pk'] === pk && input.ExpressionAttributeValues[':prefix'] === 'MOVEMENT#'));
});

test('Dynamo conditional conflicts are reported without committing a partial allocation', async () => {
  let calls = 0;
  const repository = new DynamoReconciliationRepository({ tableName: 'reconciliation-test', client: { async send(command) { assert.ok(command instanceof TransactWriteCommand); calls++; throw cancellation(); } } });
  const ledger = applyPayment(createLedger('MXN'), { operationId: 'first', participantId: 'ana', provider: 'bank', externalMovementId: 'bank-1', amountMinor: '50000', currency: 'MXN', expectedVersion: 0 });
  await assert.rejects(repository.commit(scope, ledger, 0, batch), { code: 'VERSION_CONFLICT', status: 409 });
  assert.equal(calls, 1);
});

test('Dynamo upload retry preserves batch identity and rejects a changed operation mapping', async () => {
  let mappedBatch = batch.batchId;
  const calls = [];
  const repository = new DynamoReconciliationRepository({ tableName: 'reconciliation-test', client: { async send(command) {
    calls.push(command);
    if (command instanceof GetCommand) return { Item: { data: command.input.Key.sk.startsWith('UPLOAD#') ? { batchId: mappedBatch } : batch } };
    if (command instanceof TransactWriteCommand) return {};
    throw new Error('unexpected command');
  } } });
  assert.deepEqual(await repository.createBatch(scope, { ...batch, fileName: 'new-name.csv' }, 'upload-1'), batch);
  mappedBatch = 'b'.repeat(64);
  await assert.rejects(repository.createBatch(scope, batch, 'upload-1'), { code: 'OPERATION_CONFLICT' });
  assert.ok(calls.filter((command) => command instanceof TransactWriteCommand).length <= 1);
});

test('Dynamo upload transaction conflict has bounded retries even when the batch already exists', async () => {
  let writes = 0;
  const repository = new DynamoReconciliationRepository({ tableName: 'reconciliation-test', client: { async send(command) {
    if (command instanceof GetCommand) return command.input.Key.sk.startsWith('BATCH#') ? { Item: { data: batch } } : {};
    if (command instanceof TransactWriteCommand) { writes++; if (writes > 3) throw new Error('UNBOUNDED_RETRY'); throw cancellation(); }
    throw new Error('unexpected command');
  } } });
  await assert.rejects(repository.createBatch(scope, batch, 'upload-conflict'), { code: 'VERSION_CONFLICT', status: 409 });
  assert.ok(writes <= 3);
});
