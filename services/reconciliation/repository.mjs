import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DomainError } from '../shared/http.mjs';
import { createLedger, fingerprint } from './domain/ledger.mjs';
const copy = (value) => structuredClone(value);
const partition = ({ organizationId, eventId }) => `ORG#${organizationId}#EVENT#${eventId}`;
const conflict = () => { throw new DomainError(409, 'VERSION_CONFLICT', 'El saldo cambió. Actualiza y revisa el abono.'); };
function itemSize(value) { if (Buffer.byteLength(JSON.stringify(value)) > 300000) throw new DomainError(413, 'BATCH_TOO_LARGE', 'El detalle del archivo supera el límite del piloto. Divide el CSV.'); return value; }
export class MemoryReconciliationRepository {
  #batches = new Map(); #ledgers = new Map(); #operations = new Map();
  async getBatch(scope, batchId) { return copy(this.#batches.get(`${partition(scope)}#${batchId}`) ?? null); }
  async listBatches(scope) { return [...this.#batches.entries()].filter(([key]) => key.startsWith(`${partition(scope)}#`)).map(([, batch]) => copy(batch)); }
  async createBatch(scope, batch, operation) {
    const opKey = `${partition(scope)}#${operation}`;
    const prior = this.#operations.get(opKey);
    if (prior && prior !== batch.batchId) throw new DomainError(409, 'OPERATION_CONFLICT', 'Esta operación ya se usó con otro archivo.');
    this.#operations.set(opKey, batch.batchId);
    const key = `${partition(scope)}#${batch.batchId}`;
    if (!this.#batches.has(key)) this.#batches.set(key, copy(itemSize(batch)));
    return copy(this.#batches.get(key));
  }
  async saveBatch(scope, batch, previousVersion) {
    const key = `${partition(scope)}#${batch.batchId}`;
    if (this.#batches.get(key)?.batchVersion !== previousVersion) conflict();
    this.#batches.set(key, copy(itemSize(batch)));
  }
  async loadLedger(scope, currency) { return copy(this.#ledgers.get(partition(scope)) ?? createLedger(currency)); }
  async commit(scope, ledger, previousVersion, batch) {
    const key = partition(scope);
    if ((this.#ledgers.get(key)?.version ?? 0) !== previousVersion) conflict();
    if (batch && this.#batches.get(`${key}#${batch.batchId}`)?.batchVersion !== batch.batchVersion - 1) conflict();
    if (batch) this.#batches.set(`${key}#${batch.batchId}`, copy(itemSize(batch)));
    this.#ledgers.set(key, copy(ledger));
  }
}
export class DynamoReconciliationRepository {
  constructor({ tableName = process.env.RECONCILIATION_TABLE, client = DynamoDBDocumentClient.from(new DynamoDBClient({})) } = {}) { this.tableName = tableName; this.client = client; }
  async get(scope, sk) { return (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: partition(scope), sk }, ConsistentRead: true }))).Item?.data ?? null; }
  async query(scope, prefix) {
    const result = []; let cursor;
    do { const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': partition(scope), ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey: cursor })); result.push(...(response.Items ?? []).map((item) => item.data)); cursor = response.LastEvaluatedKey; } while (cursor);
    return result;
  }
  async getBatch(scope, batchId) { return this.get(scope, `BATCH#${batchId}`); }
  async listBatches(scope) { return this.query(scope, 'BATCH#'); }
  async createBatch(scope, batch, operation, attempt = 0) {
    const existingOperation = await this.get(scope, `UPLOAD#${fingerprint(operation)}`);
    if (existingOperation && existingOperation.batchId !== batch.batchId) throw new DomainError(409, 'OPERATION_CONFLICT', 'Esta operación ya se usó con otro archivo.');
    const existing = await this.getBatch(scope, batch.batchId);
    if (existing && existingOperation?.batchId === batch.batchId) return existing;
    const entries = [{ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `UPLOAD#${fingerprint(operation)}`, data: { batchId: batch.batchId } }, ConditionExpression: 'attribute_not_exists(pk) OR #data.batchId = :batch', ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':batch': batch.batchId } } }];
    if (!existing) entries.push({ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, data: itemSize(batch), version: batch.batchVersion }, ConditionExpression: 'attribute_not_exists(pk)' } });
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      const found = await this.getBatch(scope, batch.batchId);
      const op = await this.get(scope, `UPLOAD#${fingerprint(operation)}`);
      if (op && op.batchId !== batch.batchId) throw new DomainError(409, 'OPERATION_CONFLICT', 'Esta operación ya se usó con otro archivo.');
      if (found && op?.batchId === batch.batchId) return found;
      if (!found || attempt >= 2) conflict();
      return this.createBatch(scope, found, operation, attempt + 1);
    }
    return existing ?? batch;
  }
  async saveBatch(scope, batch, previousVersion) {
    try { await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, data: itemSize(batch), version: batch.batchVersion }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previousVersion } } }] })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
  async loadLedger(scope, currency) {
    for (let attempt = 0; attempt < 3; attempt++) { const meta = await this.get(scope, 'LEDGER'); const movements = await this.query(scope, 'MOVEMENT#'); if (movements.length === (meta?.version ?? 0)) return { currency: meta?.currency ?? currency, version: movements.length, movements }; }
    conflict();
  }
  async commit(scope, ledger, previousVersion, batch) {
    const movement = ledger.movements.at(-1);
    const paidMinor = ledger.movements.filter((entry) => entry.participantId === movement.participantId).reduce((sum, entry) => sum + BigInt(entry.amountMinor), 0n).toString();
    const entries = [
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: 'LEDGER', version: ledger.version, data: { version: ledger.version, currency: ledger.currency } }, ConditionExpression: previousVersion ? '#version = :previous' : 'attribute_not_exists(pk)', ...(previousVersion ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': previousVersion } } : {}) } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `MOVEMENT#${String(movement.sequence).padStart(12, '0')}`, data: movement }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BALANCE#${movement.participantId}`, data: { participantId: movement.participantId, currency: ledger.currency, paidMinor, version: ledger.version } } } },
    ];
    if (batch) entries.push({ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, version: batch.batchVersion, data: itemSize(batch) }, ConditionExpression: '#version = :previous', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': batch.batchVersion - 1 } } });
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
}
