import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api';
import { OrganizationStore } from './organization.store';
import { SessionService } from './session';

const response = (id: string) => ({ homeOrganizationId: 'org-home', activeOrganizationId: id, organizations: [{ organizationId: id, status: 'active' }], organization: { organizationId: id, plan: { code: 'pilot' }, capabilities: {} } });
describe('verified organization access', () => {
  it('discards a slower membership lookup after another organization was selected', async () => {
    let finishA!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockResolvedValueOnce(response('org-b'));
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: { request } }, { provide: SessionService, useValue: { token: signal('session'), local: signal(false) } }] });
    const store = TestBed.inject(OrganizationStore);
    const first = store.switchOrganization('org-a');
    const second = store.switchOrganization('org-b');
    expect(await second).toBe(true);
    finishA(response('org-a'));
    expect(await first).toBe(false);
    expect(store.current()?.activeOrganizationId).toBe('org-b');
  });
  it('fails closed when the response does not include an active membership', async () => {
    const request = vi.fn(async () => ({ ...response('org-a'), organizations: [] }));
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: { request } }, { provide: SessionService, useValue: { token: signal('session'), local: signal(false) } }] });
    const store = TestBed.inject(OrganizationStore);
    expect(await store.switchOrganization('org-a')).toBe(false);
    expect(store.current()).toBeUndefined();
    expect(store.error()).toContain('verificar');
  });
});
