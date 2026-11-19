import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DomainError } from '../shared/http.mjs';
import { createLedger, fingerprint } from './domain/ledger.mjs';
import { buildAccessConditions } from '../shared/access.mjs';
const copy = (value) => structuredClone(value);
const partition = ({ organizationId, eventId }) => `ORG#${organizationId}#EVENT#${eventId}`;
const conflict = () => { throw new DomainError(409, 'VERSION_CONFLICT', 'El saldo cambió. Actualiza y revisa el abono.'); };
const closed = () => { throw new DomainError(409, 'EVENT_CLOSED', 'La conciliación está cerrada. Reábrela antes de registrar movimientos nuevos.'); };
const lifecycle = ledger => ({ financialStatus: ledger?.financialStatus ?? 'open', lifecycleVersion: ledger?.lifecycleVersion ?? 0, ...(ledger?.currentClosureId ? { currentClosureId: ledger.currentClosureId } : {}) });
const accessConditions = (actor, tableName) => actor?.accessGuards ? buildAccessConditions(actor, { tableName }) : [];
const snapshotSize = snapshot => { if (Buffer.byteLength(JSON.stringify(snapshot)) > 300000) throw new DomainError(413, 'CLOSURE_TOO_LARGE', 'El cierre supera el tamaño técnico permitido. Divide el evento antes de cerrarlo.'); return snapshot; };
function itemSize(value) { if (Buffer.byteLength(JSON.stringify(value)) > 300000) throw new DomainError(413, 'BATCH_TOO_LARGE', 'El detalle del archivo supera el límite del piloto. Divide el CSV.'); return value; }
export class MemoryReconciliationRepository {
  #batches = new Map(); #ledgers = new Map(); #operations = new Map(); #closures = new Map(); #lifecycleOperations = new Map();
  constructor({ validateAccess = () => {} } = {}) { this.validateAccess = validateAccess; }
  async getBatch(scope, batchId) { return copy(this.#batches.get(`${partition(scope)}#${batchId}`) ?? null); }
  async listBatches(scope) { return [...this.#batches.entries()].filter(([key]) => key.startsWith(`${partition(scope)}#`)).map(([, batch]) => copy(batch)); }
  async createBatch(scope, batch, operation, actor) {
    this.validateAccess(actor);
    if ((this.#ledgers.get(partition(scope))?.financialStatus ?? 'open') !== 'open') closed();
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
  async loadLedger(scope, currency) { const stored = this.#ledgers.get(partition(scope)); return copy({ ...(stored ?? createLedger(currency)), ...lifecycle(stored), metaExists: Boolean(stored) }); }
  async commit(scope, ledger, previousVersion, batch, actor) {
    this.validateAccess(actor);
    const key = partition(scope);
    const current = this.#ledgers.get(key);
    if ((current?.financialStatus ?? 'open') !== 'open') closed();
    if ((this.#ledgers.get(key)?.version ?? 0) !== previousVersion) conflict();
    if ((current?.lifecycleVersion ?? 0) !== (ledger.lifecycleVersion ?? 0)) conflict();
    if (batch && this.#batches.get(`${key}#${batch.batchId}`)?.batchVersion !== batch.batchVersion - 1) conflict();
    if (batch) this.#batches.set(`${key}#${batch.batchId}`, copy(itemSize(batch)));
    this.#ledgers.set(key, copy({ ...ledger, ...lifecycle(current), metaExists: true }));
  }
  async getClosure(scope, closureId) { return copy(this.#closures.get(`${partition(scope)}#${closureId}`) ?? null); }
  async listClosures(scope) { return [...this.#closures.entries()].filter(([key]) => key.startsWith(`${partition(scope)}#`)).map(([, value]) => copy(value)).sort((a, b) => b.lifecycleVersion - a.lifecycleVersion); }
  async getLifecycleOperation(scope, operationId) { return copy(this.#lifecycleOperations.get(`${partition(scope)}#${operationId}`) ?? null); }
  async closeLedger(scope, snapshot, expected, actor) {
    snapshotSize(snapshot); this.validateAccess(actor);
    const key = partition(scope); const current = this.#ledgers.get(key) ?? createLedger(snapshot.currency);
    if ((current.financialStatus ?? 'open') !== 'open') closed();
    if (current.version !== expected.ledgerVersion || (current.lifecycleVersion ?? 0) !== expected.lifecycleVersion) conflict();
    if (this.#closures.has(`${key}#${snapshot.closureId}`)) conflict();
    this.#closures.set(`${key}#${snapshot.closureId}`, copy(snapshot));
    this.#ledgers.set(key, copy({ ...current, financialStatus: 'closed', lifecycleVersion: expected.lifecycleVersion + 1, currentClosureId: snapshot.closureId, metaExists: true }));
  }
  async reopenLedger(scope, operation, expected, actor) {
    this.validateAccess(actor); const key = partition(scope); const current = this.#ledgers.get(key);
    if (!current || current.financialStatus !== 'closed' || current.version !== expected.ledgerVersion || current.lifecycleVersion !== expected.lifecycleVersion) conflict();
    this.#lifecycleOperations.set(`${key}#${operation.operationId}`, copy(operation));
    this.#ledgers.set(key, copy({ ...current, financialStatus: 'open', lifecycleVersion: current.lifecycleVersion + 1 }));
  }
}
export class DynamoReconciliationRepository {
  constructor({ tableName = process.env.RECONCILIATION_TABLE, identityTableName = process.env.IDENTITY_TABLE, client = DynamoDBDocumentClient.from(new DynamoDBClient({})) } = {}) { this.tableName = tableName; this.identityTableName = identityTableName; this.client = client; }
  async get(scope, sk) { return (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: partition(scope), sk }, ConsistentRead: true }))).Item?.data ?? null; }
  async query(scope, prefix, projectionFields) {
    const result = []; let cursor;
    do { const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': partition(scope), ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey: cursor, ...(projectionFields ? { ProjectionExpression: projectionFields.map((_, index) => `#data.#field${index}`).join(','), ExpressionAttributeNames: Object.fromEntries([['#data', 'data'], ...projectionFields.map((field, index) => [`#field${index}`, field])]) } : {}) })); result.push(...(response.Items ?? []).map((item) => item.data)); cursor = response.LastEvaluatedKey; } while (cursor);
    return result;
  }
  async getBatch(scope, batchId) { return this.get(scope, `BATCH#${batchId}`); }
  async listBatches(scope) { return this.query(scope, 'BATCH#'); }
  async createBatch(scope, batch, operation, actor, attempt = 0) {
    const existingOperation = await this.get(scope, `UPLOAD#${fingerprint(operation)}`);
    if (existingOperation && existingOperation.batchId !== batch.batchId) throw new DomainError(409, 'OPERATION_CONFLICT', 'Esta operación ya se usó con otro archivo.');
    const existing = await this.getBatch(scope, batch.batchId);
    if (existing && existingOperation?.batchId === batch.batchId) return existing;
    const entries = [{ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `UPLOAD#${fingerprint(operation)}`, data: { batchId: batch.batchId } }, ConditionExpression: 'attribute_not_exists(pk) OR #data.batchId = :batch', ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':batch': batch.batchId } } }];
    if (!existing) entries.push({ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, data: itemSize(batch), version: batch.batchVersion }, ConditionExpression: 'attribute_not_exists(pk)' } });
    entries.push({ ConditionCheck: { TableName: this.tableName, Key: { pk: partition(scope), sk: 'LEDGER' }, ConditionExpression: 'attribute_not_exists(pk) OR attribute_not_exists(#data.#status) OR #data.#status = :open', ExpressionAttributeNames: { '#data': 'data', '#status': 'financialStatus' }, ExpressionAttributeValues: { ':open': 'open' } } }, ...accessConditions(actor, this.identityTableName));
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      const found = await this.getBatch(scope, batch.batchId);
      const op = await this.get(scope, `UPLOAD#${fingerprint(operation)}`);
      if (op && op.batchId !== batch.batchId) throw new DomainError(409, 'OPERATION_CONFLICT', 'Esta operación ya se usó con otro archivo.');
      if (found && op?.batchId === batch.batchId) return found;
      if (!found || attempt >= 2) conflict();
      return this.createBatch(scope, found, operation, actor, attempt + 1);
    }
    return existing ?? batch;
  }
  async saveBatch(scope, batch, previousVersion) {
    try { await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, data: itemSize(batch), version: batch.batchVersion }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previousVersion } } }] })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
  async loadLedger(scope, currency) {
    for (let attempt = 0; attempt < 3; attempt++) { const meta = await this.get(scope, 'LEDGER'); const movements = await this.query(scope, 'MOVEMENT#'); if (movements.length === (meta?.version ?? 0)) return { currency: meta?.currency ?? currency, version: movements.length, movements, ...lifecycle(meta), metaExists: Boolean(meta) }; }
    conflict();
  }
  async commit(scope, ledger, previousVersion, batch, actor) {
    const movement = ledger.movements.at(-1);
    const paidMinor = ledger.movements.filter((entry) => entry.participantId === movement.participantId).reduce((sum, entry) => sum + BigInt(entry.amountMinor), 0n).toString();
    const entries = [
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: 'LEDGER', version: ledger.version, data: { version: ledger.version, currency: ledger.currency, ...lifecycle(ledger) } }, ...this.#openCondition(ledger, previousVersion) } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `MOVEMENT#${String(movement.sequence).padStart(12, '0')}`, data: movement }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BALANCE#${movement.participantId}`, data: { participantId: movement.participantId, currency: ledger.currency, paidMinor, version: ledger.version } } } },
    ];
    if (batch) entries.push({ Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `BATCH#${batch.batchId}`, version: batch.batchVersion, data: itemSize(batch) }, ConditionExpression: '#version = :previous', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': batch.batchVersion - 1 } } });
    entries.push(...accessConditions(actor, this.identityTableName));
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
  #openCondition(ledger, version) {
    if (!ledger.metaExists && version === 0) return { ConditionExpression: 'attribute_not_exists(pk)' };
    return { ConditionExpression: '#version = :previous AND (attribute_not_exists(#data.#status) OR #data.#status = :open) AND (attribute_not_exists(#data.#lifecycle) OR #data.#lifecycle = :lifecycle)', ExpressionAttributeNames: { '#version': 'version', '#data': 'data', '#status': 'financialStatus', '#lifecycle': 'lifecycleVersion' }, ExpressionAttributeValues: { ':previous': version, ':open': 'open', ':lifecycle': ledger.lifecycleVersion ?? 0 } };
  }
  async getClosure(scope, closureId) { return this.get(scope, `CLOSURE#${closureId}`); }
  async listClosures(scope) { return (await this.query(scope, 'CLOSURE#', ['closureId', 'operationId', 'createdAt', 'createdBy', 'ledgerVersion', 'lifecycleVersion', 'rosterRevision'])).sort((a, b) => b.lifecycleVersion - a.lifecycleVersion); }
  async getLifecycleOperation(scope, operationId) { return this.get(scope, `LIFECYCLE#${fingerprint(operationId)}`); }
  async closeLedger(scope, snapshot, expected, actor) {
    snapshotSize(snapshot);
    const ledger = { metaExists: expected.metaExists, lifecycleVersion: expected.lifecycleVersion };
    const entries = [
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: 'LEDGER', version: expected.ledgerVersion, data: { version: expected.ledgerVersion, currency: snapshot.currency, financialStatus: 'closed', lifecycleVersion: expected.lifecycleVersion + 1, currentClosureId: snapshot.closureId } }, ...this.#openCondition(ledger, expected.ledgerVersion) } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `CLOSURE#${snapshot.closureId}`, data: snapshot }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ...accessConditions(actor, this.identityTableName),
    ];
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
  async reopenLedger(scope, operation, expected, actor) {
    const entries = [
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: 'LEDGER', version: expected.ledgerVersion, data: { version: expected.ledgerVersion, currency: operation.currency, financialStatus: 'open', lifecycleVersion: expected.lifecycleVersion + 1, currentClosureId: operation.closureId } }, ConditionExpression: '#version = :previous AND #data.#status = :closed AND #data.#lifecycle = :lifecycle', ExpressionAttributeNames: { '#version': 'version', '#data': 'data', '#status': 'financialStatus', '#lifecycle': 'lifecycleVersion' }, ExpressionAttributeValues: { ':previous': expected.ledgerVersion, ':closed': 'closed', ':lifecycle': expected.lifecycleVersion } } },
      { Put: { TableName: this.tableName, Item: { pk: partition(scope), sk: `LIFECYCLE#${fingerprint(operation.operationId)}`, data: operation }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ...accessConditions(actor, this.identityTableName),
    ];
    try { await this.client.send(new TransactWriteCommand({ TransactItems: entries })); }
    catch (error) { if (error.name === 'TransactionCanceledException') conflict(); throw error; }
  }
}
