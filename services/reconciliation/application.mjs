import { createHash } from 'node:crypto';
import { DomainError, validateId } from '../shared/http.mjs';
import { applyPayment, reversePayment, operationId } from './domain/ledger.mjs';
import { parseImport } from './domain/csv.mjs';
import { assertEventWorking, assertFinancialOpen, balancesFor, createClosingService } from './closing.mjs';
const notFound = () => { throw new DomainError(404, 'BATCH_NOT_FOUND', 'Importación no encontrada.'); };
const scopeFor = (actor, eventId) => ({ organizationId: validateId(actor.organizationId, 'organizationId'), eventId: validateId(eventId, 'eventId') });
export function createReconciliationService({ repository, eventReader, eventCommand, eventLister, uploadSigner, now = () => new Date().toISOString() }) {
  async function context(actor, eventId) { const scope = scopeFor(actor, eventId); const result = await eventReader(scope); if (!result?.event || !Array.isArray(result.participants)) throw new DomainError(404, 'EVENT_NOT_FOUND', 'Evento no encontrado.'); return { scope, ...result }; }
  async function batchFor(scope, id) { const batch = await repository.getBatch(scope, validateId(id, 'batchId')); if (!batch) notFound(); return batch; }
  return {
    ...createClosingService({ repository, eventReader, eventCommand, eventLister, now }),
    async startImport(actor, eventId, input) {
      const { scope, event } = await context(actor, eventId);
      assertEventWorking(event); assertFinancialOpen(await repository.loadLedger(scope, event.currency));
      operationId(input.operationId);
      if (!/^[a-f0-9]{64}$/.test(input.sha256 ?? '') || typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 160) throw new DomainError(400, 'INVALID_UPLOAD', 'Archivo CSV y huella SHA-256 requeridos.');
      const batchId = input.sha256;
      const key = `tenants/${scope.organizationId}/events/${eventId}/imports/${batchId}/input.csv`;
      const batch = await repository.createBatch(scope, { batchId, fileName: input.fileName, sha256: input.sha256, key, status: 'awaiting_upload', rows: [], batchVersion: 0, createdAt: now(), createdBy: actor.subject }, input.operationId, actor);
      return { batch, upload: await uploadSigner({ key, sha256: input.sha256 }) };
    },
    async recordPayment(actor, eventId, input) {
      const { scope, event, participants } = await context(actor, eventId);
      if (!participants.some((participant) => participant.participantId === input.participantId)) throw new DomainError(404, 'PARTICIPANT_NOT_FOUND', 'Participante no encontrado.');
      if (typeof input.reference !== 'string' || !input.reference.trim() || input.reference.length > 120 || /[\u0000-\u001f\u007f]/.test(input.reference)) throw new DomainError(400, 'INVALID_REFERENCE', 'Indica una referencia estable de hasta 120 caracteres.');
      const state = await repository.loadLedger(scope, event.currency);
      const next = applyPayment(state, { operationId: input.operationId, participantId: input.participantId, itemId: input.itemId, provider: 'manual', externalMovementId: input.reference.trim(), amountMinor: input.amountMinor, currency: input.currency, expectedVersion: input.expectedVersion });
      if (next !== state) { assertEventWorking(event); assertFinancialOpen(state); Object.assign(next.movements.at(-1), { createdBy: actor.subject, createdAt: now() }); await repository.commit(scope, next, state.version, undefined, actor); }
      const movement = next.movements.find((entry) => entry.operationId === input.operationId);
      return { movement, version: movement.sequence };
    },
    async listImports(actor, eventId) { const { scope } = await context(actor, eventId); return { batches: (await repository.listBatches(scope)).map(({ rows, ...batch }) => ({ ...batch, rowCount: rows.length })) }; },
    async getImport(actor, eventId, batchId) { const { scope } = await context(actor, eventId); return { batch: await batchFor(scope, batchId) }; },
    async processImport({ organizationId, eventId, batchId, csv }) {
      const { scope, event, participants } = await context({ organizationId }, eventId);
      const batch = await batchFor(scope, batchId);
      if (createHash('sha256').update(csv).digest('hex') !== batch.sha256) throw new DomainError(400, 'HASH_MISMATCH', 'El archivo no coincide con su huella SHA-256.');
      if (batch.status === 'ready') return { batch };
      const processing = { ...batch, status: 'processing', batchVersion: batch.batchVersion + 1 };
      await repository.saveBatch(scope, processing, batch.batchVersion);
      let rows;
      try { rows = parseImport(csv, event.currency, participants); }
      catch (error) { const failed = { ...processing, status: 'failed', error: error.message, batchVersion: processing.batchVersion + 1 }; await repository.saveBatch(scope, failed, processing.batchVersion); return { batch: failed }; }
      const ledger = await repository.loadLedger(scope, event.currency);
      rows = rows.map((row) => ledger.movements.some((movement) => movement.kind === 'payment' && movement.provider === row.provider && movement.externalMovementId === row.movementId) ? { ...row, status: 'duplicate', reason: 'Movimiento confirmado en otro archivo.' } : row);
      const ready = { ...processing, status: 'ready', rows, processedAt: now(), batchVersion: processing.batchVersion + 1 };
      try { await repository.saveBatch(scope, ready, processing.batchVersion); }
      catch (error) {
        if (error.code !== 'BATCH_TOO_LARGE') throw error;
        const failed = { ...processing, status: 'failed', rows: [], error: error.message, batchVersion: processing.batchVersion + 1 };
        await repository.saveBatch(scope, failed, processing.batchVersion);
        return { batch: failed };
      }
      return { batch: ready };
    },
    async allocate(actor, eventId, input) {
      const { scope, event, participants } = await context(actor, eventId);
      const batch = await batchFor(scope, input.batchId);
      const row = batch.rows.find((entry) => entry.rowId === String(input.rowId));
      if (!row || !['suggested', 'ambiguous', 'unmatched', 'applied'].includes(row.status)) throw new DomainError(409, 'ROW_NOT_REVIEWABLE', 'La fila no admite confirmación.');
      if (!participants.some((participant) => participant.participantId === input.participantId)) throw new DomainError(404, 'PARTICIPANT_NOT_FOUND', 'Participante no encontrado.');
      const state = await repository.loadLedger(scope, event.currency);
      const next = applyPayment(state, { ...input, amountMinor: row.amountMinor, currency: row.currency, provider: row.provider, externalMovementId: row.movementId });
      const movement = next.movements.find((entry) => entry.operationId === input.operationId);
      if (next !== state) { assertEventWorking(event); assertFinancialOpen(state); Object.assign(movement, { createdBy: actor.subject, createdAt: now() }); const updated = { ...batch, batchVersion: batch.batchVersion + 1, rows: batch.rows.map((entry) => entry.rowId === row.rowId ? { ...entry, status: 'applied', participantId: input.participantId, appliedMovementId: movement.movementId } : entry) }; await repository.commit(scope, next, state.version, updated, actor); }
      return { movement, version: movement.sequence };
    },
    async reverse(actor, eventId, movementId, input) {
      const { scope, event } = await context(actor, eventId);
      const state = await repository.loadLedger(scope, event.currency);
      const next = reversePayment(state, { ...input, movementId });
      if (next !== state) { assertEventWorking(event); assertFinancialOpen(state); Object.assign(next.movements.at(-1), { createdBy: actor.subject, createdAt: now() }); await repository.commit(scope, next, state.version, undefined, actor); }
      const movement = next.movements.find((entry) => entry.operationId === input.operationId);
      return { movement, version: movement.sequence };
    },
    async movements(actor, eventId) { const { scope, event } = await context(actor, eventId); const ledger = await repository.loadLedger(scope, event.currency); return { movements: ledger.movements, version: ledger.version, financialStatus: ledger.financialStatus, lifecycleVersion: ledger.lifecycleVersion }; },
    async balances(actor, eventId) {
      const { scope, event, participants } = await context(actor, eventId);
      const ledger = await repository.loadLedger(scope, event.currency);
      return { version: ledger.version, currency: event.currency, financialStatus: ledger.financialStatus, lifecycleVersion: ledger.lifecycleVersion, balances: balancesFor(event, participants, ledger) };
    },
  };
}
