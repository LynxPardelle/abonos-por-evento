import { computed, DestroyRef, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient } from '../../core/api';
import { Balance, BalancesResponse, EventRecord, ImportBatch, Movement, Participant } from '../../core/models';
import { OrganizationContext } from '../../core/organization-context';
import { OrganizationStore } from '../../core/organization.store';
import { ClosingState, EventList, OverviewResponse } from '../../core/product.models';
import { requestError } from '../../core/request-error';

const initialState = {
  eventId: '', events: [] as EventRecord[], participants: [] as Participant[],
  batches: [] as ImportBatch[], selectedBatch: undefined as ImportBatch | undefined,
  balances: [] as Balance[], movements: [] as Movement[], version: 0,
  busy: false, error: '', notice: '',
  closing: undefined as ClosingState | undefined,
  usage: undefined as EventList['usage'],
  overview: undefined as OverviewResponse | undefined,
};

export const WorkspaceStore = signalStore(
  withState(initialState),
  withComputed(store => ({
    event: computed(() => store.events().find(event => event.eventId === store.eventId())),
    paidMinor: computed(() => store.balances().reduce((total, balance) => total + BigInt(balance.paidMinor), 0n).toString()),
    pendingMinor: computed(() => store.balances().reduce((total, balance) => total + BigInt(balance.pendingMinor), 0n).toString()),
  })),
  withMethods((store, api = inject(ApiClient), context = inject(OrganizationContext), organization = inject(OrganizationStore)) => {
    let generation = 0;
    const unsubscribe = context.onChange(() => { generation++; patchState(store, initialState); });
    inject(DestroyRef).onDestroy(() => { generation++; unsubscribe(); });
    async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
      const epoch = context.capture();
      patchState(store, { busy: true, error: '', notice: '' });
      try { const value = await action(); return context.isCurrent(epoch) ? value : undefined; }
      catch (error) { if (context.isCurrent(epoch)) patchState(store, { error: requestError(error) }); return undefined; }
      finally { if (context.isCurrent(epoch)) patchState(store, { busy: false }); }
    }
    async function reload(eventId = store.eventId()) {
      const requestGeneration = ++generation;
      const epoch = context.capture();
      const [list, overview] = await Promise.all([
        api.request<EventList>('GET', '/events'),
        !eventId && organization.can('viewOverview') ? api.request<OverviewResponse>('GET', '/overview') : Promise.resolve(undefined),
      ]);
      if (requestGeneration !== generation || !context.isCurrent(epoch)) return;
      const { events, usage } = list;
      if (!eventId) { patchState(store, { events, usage, overview, eventId: '', participants: [], batches: [], selectedBatch: undefined, balances: [], movements: [], version: 0, closing: undefined }); return; }
      const base = `/events/${encodeURIComponent(eventId)}`;
      const [people, imports, balances, ledger, closing] = await Promise.all([
        api.request<{ participants: Participant[] }>('GET', `${base}/participants`),
        api.request<{ batches: ImportBatch[] }>('GET', `${base}/imports`),
        api.request<BalancesResponse>('GET', `${base}/balances`),
        api.request<{ movements: Movement[] }>('GET', `${base}/movements`),
        api.request<ClosingState>('GET', `${base}/closing`),
      ]);
      if (requestGeneration !== generation || !context.isCurrent(epoch)) return;
      patchState(store, { eventId, events, usage, overview, closing, participants: people.participants, batches: imports.batches, balances: balances.balances, version: balances.version, movements: ledger.movements });
      const selectedId = store.selectedBatch()?.batchId;
      if (selectedId) {
        const { batch } = await api.request<{ batch: ImportBatch }>('GET', `${base}/imports/${encodeURIComponent(selectedId)}`);
        if (requestGeneration === generation && context.isCurrent(epoch)) patchState(store, { selectedBatch: batch });
      }
    }
    const base = () => `/events/${encodeURIComponent(store.eventId())}`;
    return {
      load: (eventId = '') => run(() => {
        if (store.eventId() !== eventId) patchState(store, { eventId, participants: [], batches: [], selectedBatch: undefined, balances: [], movements: [], version: 0, closing: undefined });
        return reload(eventId);
      }),
      refresh: () => run(() => reload()),
      createEvent: (name: string, currency: string) => run(async () => {
        const { event } = await api.request<{ event: EventRecord }>('POST', '/events', { name, currency, operationId: crypto.randomUUID() });
        await reload(); return event;
      }),
      addParticipant: (participant: { name: string; reference: string; agreedMinor: string }) => run(async () => {
        await api.request('POST', `${base()}/participants`, { ...participant, operationId: crypto.randomUUID() });
        await reload(); patchState(store, { notice: 'Participante registrado.' }); return true;
      }),
      importFile: (file: File) => run(async () => {
        if (file.size > 1_048_576) throw new Error('El CSV puede tener hasta 1 MB.');
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
        const result = await api.request<{ batch: ImportBatch; upload?: { url: string; headers: Record<string, string> } }>('POST', `${base()}/imports`, { operationId: sha256, sha256, fileName: file.name });
        if (result.upload) await api.upload(result.upload.url, file, result.upload.headers);
        patchState(store, { selectedBatch: result.batch });
        await reload(); patchState(store, { notice: 'Archivo recibido. Revisa las coincidencias antes de confirmar.' }); return true;
      }),
      selectBatch: (batchId: string) => run(async () => {
        const { batch } = await api.request<{ batch: ImportBatch }>('GET', `${base()}/imports/${encodeURIComponent(batchId)}`);
        patchState(store, { selectedBatch: batch });
      }),
      confirm: (batchId: string, rowId: string, participantId: string) => run(async () => {
        await api.request('POST', `${base()}/allocations`, { operationId: `allocation-${batchId}-${rowId}`, batchId, rowId, participantId, expectedVersion: store.version() });
        await reload(); patchState(store, { notice: 'Abono confirmado. El saldo se actualizó.' }); return true;
      }),
      reverse: (movementId: string) => run(async () => {
        await api.request('POST', `${base()}/movements/${encodeURIComponent(movementId)}/reversals`, { operationId: `reversal-${movementId}`, expectedVersion: store.version() });
        await reload(); patchState(store, { notice: 'Reverso registrado. El movimiento original se conserva.' }); return true;
      }),
      recordPayment: (input: { operationId: string; participantId: string; reference: string; amountMinor: string }) => run(async () => {
        await api.request('POST', `${base()}/payments`, { ...input, currency: store.event()?.currency, expectedVersion: store.version() });
        await reload(); patchState(store, { notice: 'Abono manual confirmado. El saldo se actualizó.' }); return true;
      }),
    };
  }),
);
