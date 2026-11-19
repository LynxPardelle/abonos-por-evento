import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../../core/api';
import { OrganizationContext } from '../../core/organization-context';
import { ClosingStore } from './closing.store';

const event = { eventId: 'e1', name: 'Taller', currency: 'MXN' };
const state = { financialStatus: 'open', lifecycleVersion: 2, ledgerVersion: 7, eventRevision: 4, closures: [], canClose: true, canReopen: false, canArchive: false };
describe('closing requests', () => {
  it('resumes a pending reopen with the original operation and original lifecycle version', async () => {
    const transition = { kind: 'reopening', operationId: 'resume-existing', closureId: 'c1', expectedLifecycleVersion: 2, expectedEventRevision: 8 };
    const request = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'POST') return {};
      return path.endsWith('/closing') ? { ...state, financialStatus: 'open', lifecycleVersion: 3, eventRevision: 8, transition, canReopen: true } : { event };
    });
    TestBed.configureTestingModule({ providers: [ClosingStore, { provide: ApiClient, useValue: { request } }] });
    const store = TestBed.inject(ClosingStore);
    await store.load('e1');
    await store.transition('reopen');
    expect(request).toHaveBeenCalledWith('POST', '/events/e1/reopen', { operationId: 'resume-existing', expectedLifecycleVersion: 2, expectedEventRevision: 8 });
  });
  it('keeps the same operation and version after a failed close, without changing financial state', async () => {
    const request = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'POST') throw { error: { error: { code: 'VERSION_CONFLICT' } } };
      return path.endsWith('/closing') ? state : { event };
    });
    TestBed.configureTestingModule({ providers: [ClosingStore, { provide: ApiClient, useValue: { request } }] });
    const store = TestBed.inject(ClosingStore);
    await store.load('e1');
    await store.transition('close');
    await store.transition('close');
    const posts = request.mock.calls.filter(([method]) => method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0][2]).toMatchObject({ expectedLedgerVersion: 7, expectedLifecycleVersion: 2 });
    expect(store.closing()?.financialStatus).toBe('open');
    expect(store.request.error()).toContain('Actualiza');
  });
  it('does not download a previous organization report after switching context', async () => {
    let finish!: (value: unknown) => void;
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL });
    try {
      const request = vi.fn(async (_method: string, path: string) => {
        if (path.endsWith('/report/c1')) return new Promise(resolve => { finish = resolve; });
        return path.endsWith('/closing') ? state : { event };
      });
      TestBed.configureTestingModule({ providers: [ClosingStore, { provide: ApiClient, useValue: { request } }] });
      const context = TestBed.inject(OrganizationContext);
      context.select('org-a');
      const store = TestBed.inject(ClosingStore);
      await store.load('e1');
      const pending = store.export('c1');
      context.select('org-b');
      finish({ fileName: 'private.csv', contentType: 'text/csv', content: 'private ledger', ledgerVersion: 7 });
      expect(await pending).toBeUndefined();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(store.closing()).toBeUndefined();
      expect(store.event()).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
});
