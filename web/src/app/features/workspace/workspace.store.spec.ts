import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../../core/api';
import { WorkspaceStore } from './workspace.store';
import { OrganizationContext } from '../../core/organization-context';

describe('review workflow', () => {
  it('does not restore an old batch when a CSV upload finishes after switching organizations', async () => {
    let finishUpload!: () => void;
    let finishReload: ((value: unknown) => void) | undefined;
    let eventReads = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST') return { batch: { batchId: 'private-batch-a', fileName: 'private-a.csv' }, upload: { url: 'https://upload.invalid', headers: {} } };
      if (path === '/events') {
        if (++eventReads > 1) return new Promise(resolve => { finishReload = resolve; });
        return { events: [{ eventId: 'e1', name: 'Organization A', currency: 'MXN' }] };
      }
      if (path.endsWith('/participants')) return { participants: [] };
      if (path.endsWith('/balances')) return { version: 0, balances: [] };
      if (path.endsWith('/movements')) return { movements: [] };
      if (path.endsWith('/closing')) return { financialStatus: 'open', closures: [] };
      return { batches: [] };
    });
    const upload = vi.fn(() => new Promise<void>(resolve => { finishUpload = resolve; }));
    TestBed.configureTestingModule({ providers: [WorkspaceStore, { provide: ApiClient, useValue: { request, upload } }] });
    const context = TestBed.inject(OrganizationContext);
    context.select('org-a');
    const store = TestBed.inject(WorkspaceStore);
    await store.load('e1');
    const file = { name: 'private-a.csv', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } as File;
    const pending = store.importFile(file);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    context.select('org-b');
    finishUpload();
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      expect(store.selectedBatch()).toBeUndefined();
      expect(eventReads).toBe(1);
      expect(store.notice()).toBe('');
    } finally {
      finishReload?.({ events: [] });
      await pending;
    }
  });
  it('clears loaded data immediately when the organization changes', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/participants')) return { participants: [{ participantId: 'p1', name: 'Private Ana' }] };
      if (path.endsWith('/balances')) return { version: 0, balances: [] };
      if (path.endsWith('/movements')) return { movements: [] };
      if (path.endsWith('/imports')) return { batches: [] };
      if (path.endsWith('/closing')) return { financialStatus: 'open', closures: [] };
      return { events: [{ eventId: 'e1', name: 'Private event', currency: 'MXN' }] };
    });
    TestBed.configureTestingModule({ providers: [WorkspaceStore, { provide: ApiClient, useValue: { request } }] });
    const context = TestBed.inject(OrganizationContext);
    context.select('org-a');
    const store = TestBed.inject(WorkspaceStore);
    await store.load('e1');
    expect(store.participants()).toHaveLength(1);
    context.select('org-b');
    expect(store.events()).toEqual([]);
    expect(store.participants()).toEqual([]);
    expect(store.movements()).toEqual([]);
  });
  it('does not change balances until an operator explicitly confirms a row', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/participants')) return { participants: [{ participantId: 'p1', name: 'Ana', reference: 'ANA', agreedMinor: '100000' }] };
      if (path.endsWith('/balances')) return { version: 0, balances: [] };
      if (path.endsWith('/movements')) return { movements: [] };
      if (path.endsWith('/imports')) return { batches: [{ batchId: 'b1', status: 'ready', fileName: 'demo.csv' }] };
      if (path === '/events') return { events: [{ eventId: 'e1', name: 'Taller', currency: 'MXN' }] };
      return {};
    });
    TestBed.configureTestingModule({ providers: [WorkspaceStore, { provide: ApiClient, useValue: { request } }] });
    const store = TestBed.inject(WorkspaceStore);
    await store.load('e1');
    expect(request.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    expect(store.eventId()).toBe('e1');
  });
  it('shows server errors without losing the pending batch', async () => {
    const request = vi.fn().mockRejectedValue({ error: { error: { message: 'La versión cambió; vuelve a revisar.' } } });
    TestBed.configureTestingModule({ providers: [WorkspaceStore, { provide: ApiClient, useValue: { request } }] });
    const store = TestBed.inject(WorkspaceStore);
    await store.load('e1');
    expect(store.error()).toContain('versión cambió');
    expect(store.busy()).toBe(false);
  });
});
