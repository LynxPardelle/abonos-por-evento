import { DomainError, validateId } from '../shared/http.mjs';
import { hasRole } from '../shared/plans.mjs';
import { fingerprint, operationId } from './domain/ledger.mjs';

const version = value => { if (!Number.isSafeInteger(value) || value < 0) throw new DomainError(400, 'INVALID_VERSION', 'Indica una versión vigente no negativa.'); return value; };
const conflict = () => { throw new DomainError(409, 'VERSION_CONFLICT', 'El evento cambió. Actualiza y revisa el cierre.'); };
const scopeFor = (actor, eventId) => ({ organizationId: validateId(actor.organizationId, 'organizationId'), eventId: validateId(eventId, 'eventId') });
const lifecycleRole = actor => { if (!Array.isArray(actor.roles) || !hasRole(actor.roles, ['operator'])) throw new DomainError(403, 'FORBIDDEN', 'Tu rol no permite cambiar el cierre del evento.'); };
const requireFeature = (actor, feature) => { if (actor.capabilities?.[feature] !== true) throw new DomainError(403, 'PLAN_CAPABILITY_REQUIRED', 'La función requiere una habilitación de evaluación del plan.'); };
export function assertFinancialOpen(ledger) { if ((ledger.financialStatus ?? 'open') !== 'open') throw new DomainError(409, 'EVENT_CLOSED', 'La conciliación está cerrada. Reábrela antes de registrar movimientos nuevos.'); }
export function assertEventWorking(event) {
  if (event.archivedAt) throw new DomainError(409, 'EVENT_ARCHIVED', 'El evento está archivado. Reábrelo para continuar.');
  if (event.reopening) throw new DomainError(409, 'EVENT_REOPENING', 'Hay una reapertura pendiente. Reintenta su finalización antes de continuar.');
}

export function balancesFor(event, participants, ledger) {
  const sums = new Map();
  for (const movement of ledger.movements) sums.set(movement.participantId, (sums.get(movement.participantId) ?? 0n) + BigInt(movement.amountMinor));
  return participants.map(person => {
    const paid = sums.get(person.participantId) ?? 0n;
    return { participantId: person.participantId, name: person.name, reference: person.reference, currency: event.currency, paidMinor: paid.toString(), agreedMinor: person.agreedMinor, pendingMinor: (BigInt(person.agreedMinor) - paid).toString() };
  });
}
function totalsFor(currency, balances) {
  const sum = key => balances.reduce((total, balance) => total + BigInt(balance[key]), 0n).toString();
  return { currency, agreedMinor: sum('agreedMinor'), paidMinor: sum('paidMinor'), pendingMinor: sum('pendingMinor') };
}
function summary(snapshot) { const { closureId, operationId, createdAt, createdBy, ledgerVersion, lifecycleVersion, rosterRevision } = snapshot; return { closureId, operationId, createdAt, createdBy, ledgerVersion, lifecycleVersion, rosterRevision }; }
function money(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new DomainError(409, 'INVALID_REPORT_MONEY', 'El importe del reporte no es válido.');
  const amount = BigInt(value); const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
function textCell(value) {
  let source = String(value ?? '');
  if (/^\s*[=+\-@]/.test(source) || /^[\t\r\n]/.test(source)) source = `'${source}`;
  return `"${source.replaceAll('"', '""')}"`;
}
export function snapshotCsv(snapshot) {
  const headers = ['registro', 'participante', 'referencia', 'acordado', 'confirmado', 'por_cubrir', 'moneda', 'movimiento', 'importe', 'tipo_movimiento', 'actor', 'fecha'];
  const rows = [headers.map(textCell).join(',')];
  for (const balance of snapshot.balances) rows.push([
    'saldo', balance.name, balance.reference, money(balance.agreedMinor), money(balance.paidMinor), money(balance.pendingMinor), snapshot.currency, '', '', '', '', '',
  ].map((value, index) => [3, 4, 5].includes(index) ? `"${value}"` : textCell(value)).join(','));
  const names = new Map(snapshot.balances.map(person => [person.participantId, person.name]));
  for (const movement of snapshot.movements) rows.push([
    'movimiento', names.get(movement.participantId) ?? '', movement.externalMovementId ?? '', '', '', '', snapshot.currency, movement.movementId, money(movement.amountMinor), movement.kind, movement.createdBy ?? '', movement.createdAt ?? '',
  ].map((value, index) => index === 8 ? `"${value}"` : textCell(value)).join(','));
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function createClosingService({ repository, eventReader, eventCommand, eventLister, now = () => new Date().toISOString() }) {
  async function context(actor, eventId) {
    const scope = scopeFor(actor, eventId); const result = await eventReader(scope);
    if (!result?.event || !Array.isArray(result.participants)) throw new DomainError(404, 'EVENT_NOT_FOUND', 'Evento no encontrado.');
    return { scope, ...result };
  }
  async function capture(actor, eventId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await context(actor, eventId); const ledger = await repository.loadLedger(current.scope, current.event.currency);
      if (ledger.movements.some(movement => !current.participants.some(person => person.participantId === movement.participantId))) continue;
      const balances = balancesFor(current.event, current.participants, ledger);
      return { ...current, ledger, balances, totals: totalsFor(current.event.currency, balances) };
    }
    throw new DomainError(409, 'ROSTER_CHANGED', 'La lista cambió mientras se preparaba el cierre. Actualiza y vuelve a revisar.');
  }
  async function command(action, scope, input, actor) {
    if (!eventCommand) throw new DomainError(503, 'EVENTS_UNAVAILABLE', 'No se pudo coordinar el estado del evento.');
    return eventCommand(action, scope, input, actor);
  }
  async function closing(actor, eventId) {
    const { scope, event } = await context(actor, eventId); const ledger = await repository.loadLedger(scope, event.currency);
    const closures = await repository.listClosures(scope);
    const latestClosure = ledger.currentClosureId ? await repository.getClosure(scope, ledger.currentClosureId) : null;
    const pendingReopen = event.reopening ? await repository.getLifecycleOperation(scope, event.reopening.operationId) : null;
    const transition = event.reopening ? { ...event.reopening, expectedLifecycleVersion: pendingReopen ? pendingReopen.lifecycleVersion - 1 : ledger.lifecycleVersion, expectedEventRevision: event.revision ?? 0 } : null;
    const operate = Array.isArray(actor.roles) && hasRole(actor.roles, ['operator']);
    return { financialStatus: ledger.financialStatus, lifecycleVersion: ledger.lifecycleVersion, ledgerVersion: ledger.version, eventRevision: event.revision ?? 0, archivedAt: event.archivedAt ?? null, transition, closures: closures.map(summary), latestClosure,
      canClose: operate && actor.capabilities?.closeEvent === true && ledger.financialStatus === 'open' && !event.archivedAt && !event.reopening,
      canReopen: operate && (ledger.financialStatus === 'closed' || Boolean(event.reopening)), canArchive: operate && ledger.financialStatus === 'closed' && !event.archivedAt && !event.reopening };
  }
  return {
    closing,
    async overview(actor) {
      requireFeature(actor, 'viewOverview');
      if (Array.isArray(actor.eventIds)) throw new DomainError(403, 'FORBIDDEN', 'Tu acceso está limitado a eventos concretos.');
      if (!eventLister) throw new DomainError(503, 'EVENTS_UNAVAILABLE', 'No se pudo obtener la vista de eventos.');
      const listing = await eventLister(actor); const active = listing.events.filter(event => !event.archivedAt);
      if (active.length > 50) throw new DomainError(413, 'OVERVIEW_TOO_LARGE', 'La vista admite hasta 50 eventos en trabajo. Archiva los eventos finalizados.');
      const entries = new Array(active.length); let index = 0;
      async function worker() {
        while (index < active.length) {
          const currentIndex = index++; const current = await capture(actor, active[currentIndex].eventId);
          if (!current.event.archivedAt) entries[currentIndex] = { event: current.event, financialStatus: current.ledger.financialStatus, ledgerVersion: current.ledger.version, totals: current.totals };
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, active.length) }, worker));
      const events = entries.filter(Boolean); const groups = new Map();
      for (const entry of events) {
        const previous = groups.get(entry.totals.currency) ?? { currency: entry.totals.currency, agreedMinor: '0', paidMinor: '0', pendingMinor: '0' };
        for (const field of ['agreedMinor', 'paidMinor', 'pendingMinor']) previous[field] = (BigInt(previous[field]) + BigInt(entry.totals[field])).toString();
        groups.set(previous.currency, previous);
      }
      return { events, totalsByCurrency: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)), activeOnly: true, usage: listing.usage };
    },
    async close(actor, eventId, input) {
      lifecycleRole(actor); requireFeature(actor, 'closeEvent');
      operationId(input.operationId); version(input.expectedLedgerVersion); version(input.expectedLifecycleVersion);
      const scope = scopeFor(actor, eventId); const closureId = `close-${fingerprint(input.operationId).slice(0, 40)}`;
      const signature = fingerprint({ expectedLedgerVersion: input.expectedLedgerVersion, expectedLifecycleVersion: input.expectedLifecycleVersion });
      const prior = await repository.getClosure(scope, closureId);
      if (prior) { if (prior.requestFingerprint !== signature) throw new DomainError(409, 'OPERATION_CONFLICT', 'La operación de cierre ya tiene otros datos.'); return closing(actor, eventId); }
      const captured = await capture(actor, eventId); assertEventWorking(captured.event); assertFinancialOpen(captured.ledger);
      if (captured.ledger.version !== input.expectedLedgerVersion || captured.ledger.lifecycleVersion !== input.expectedLifecycleVersion) conflict();
      const batches = await repository.listBatches(scope);
      const snapshot = { closureId, operationId: input.operationId, requestFingerprint: signature, eventId, eventName: captured.event.name, currency: captured.event.currency,
        ledgerVersion: captured.ledger.version, lifecycleVersion: captured.ledger.lifecycleVersion + 1, rosterRevision: captured.event.revision ?? 0,
        createdBy: actor.subject, createdAt: now(), balances: captured.balances, totals: captured.totals, movements: captured.ledger.movements,
        unappliedRows: batches.reduce((count, batch) => count + batch.rows.filter(row => ['suggested', 'ambiguous', 'unmatched'].includes(row.status)).length, 0), pendingBatches: batches.filter(batch => ['awaiting_upload', 'processing'].includes(batch.status)).length };
      await repository.closeLedger(scope, snapshot, { ledgerVersion: captured.ledger.version, lifecycleVersion: captured.ledger.lifecycleVersion, metaExists: captured.ledger.metaExists }, actor);
      return closing(actor, eventId);
    },
    async archive(actor, eventId, input) {
      lifecycleRole(actor); operationId(input.operationId); version(input.expectedEventRevision); version(input.expectedLifecycleVersion);
      const { scope, event } = await context(actor, eventId); const ledger = await repository.loadLedger(scope, event.currency);
      if (ledger.financialStatus !== 'closed' || !ledger.currentClosureId) throw new DomainError(409, 'CLOSE_REQUIRED', 'Cierra la conciliación antes de archivar.');
      if (ledger.lifecycleVersion !== input.expectedLifecycleVersion) conflict();
      if (event.archivedAt) return closing(actor, eventId);
      if ((event.revision ?? 0) !== input.expectedEventRevision) conflict();
      await command('archiveEvent', scope, { ...input, closureId: ledger.currentClosureId, closureVersion: ledger.lifecycleVersion }, actor);
      return closing(actor, eventId);
    },
    async reopen(actor, eventId, input) {
      lifecycleRole(actor); operationId(input.operationId); version(input.expectedEventRevision); version(input.expectedLifecycleVersion);
      const { scope, event } = await context(actor, eventId); const ledger = await repository.loadLedger(scope, event.currency);
      const signature = fingerprint({ expectedLifecycleVersion: input.expectedLifecycleVersion });
      const prior = await repository.getLifecycleOperation(scope, input.operationId);
      if (prior) {
        if (prior.requestFingerprint !== signature) throw new DomainError(409, 'OPERATION_CONFLICT', 'La operación de reapertura ya tiene otros datos.');
        if (event.reopening?.operationId === input.operationId) await command('finalizeReopen', scope, { operationId: input.operationId, lifecycleVersion: prior.lifecycleVersion }, actor);
        return closing(actor, eventId);
      }
      if (ledger.financialStatus !== 'closed' || !ledger.currentClosureId) throw new DomainError(409, 'CLOSE_REQUIRED', 'La conciliación ya está abierta.');
      if (ledger.lifecycleVersion !== input.expectedLifecycleVersion) conflict();
      if (event.reopening && event.reopening.operationId !== input.operationId) throw new DomainError(409, 'REOPEN_PENDING', 'Reanuda la reapertura pendiente antes de iniciar otra.');
      if (!event.reopening && (event.revision ?? 0) !== input.expectedEventRevision) conflict();
      if (event.reopening) {
        if (event.reopening.closureId !== ledger.currentClosureId) conflict();
      } else {
        await command('beginReopen', scope, { ...input, closureId: ledger.currentClosureId, closureVersion: ledger.lifecycleVersion }, actor);
      }
      const operation = { operationId: input.operationId, requestFingerprint: signature, closureId: ledger.currentClosureId, lifecycleVersion: ledger.lifecycleVersion + 1, currency: ledger.currency, createdBy: actor.subject, createdAt: now() };
      await repository.reopenLedger(scope, operation, { ledgerVersion: ledger.version, lifecycleVersion: ledger.lifecycleVersion }, actor);
      await command('finalizeReopen', scope, { operationId: input.operationId, lifecycleVersion: operation.lifecycleVersion }, actor);
      return closing(actor, eventId);
    },
    async report(actor, eventId, closureId) {
      const { scope, event } = await context(actor, eventId); let snapshot;
      if (closureId) { validateId(closureId, 'closureId'); snapshot = await repository.getClosure(scope, closureId); if (!snapshot) throw new DomainError(404, 'CLOSURE_NOT_FOUND', 'No se encontró el cierre guardado.'); }
      else {
        requireFeature(actor, 'exportEvent'); const ledger = await repository.loadLedger(scope, event.currency);
        snapshot = ledger.financialStatus === 'closed' && ledger.currentClosureId ? await repository.getClosure(scope, ledger.currentClosureId) : null;
        if (!snapshot) { const current = await capture(actor, eventId); snapshot = { currency: event.currency, ledgerVersion: current.ledger.version, balances: current.balances, totals: current.totals, movements: current.ledger.movements }; }
      }
      const content = snapshotCsv(snapshot);
      if (Buffer.byteLength(content) > 1_048_576) throw new DomainError(413, 'REPORT_TOO_LARGE', 'El reporte supera el tamaño técnico de exportación.');
      return { fileName: `saldoevento-${eventId}-${snapshot.closureId ?? 'actual'}.csv`, contentType: 'text/csv; charset=utf-8', content, ledgerVersion: snapshot.ledgerVersion, closureId: snapshot.closureId ?? null };
    },
  };
}
