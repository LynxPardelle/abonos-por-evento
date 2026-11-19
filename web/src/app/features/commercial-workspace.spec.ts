import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiClient } from '../core/api';
import { SessionService } from '../core/session';
import { OrganizationStore } from '../core/organization.store';
import { OrganizationContext } from '../core/organization-context';
import { PlanPage } from './plans/plan-page';
import { TeamPage } from './team/team-page';
import { ClosingPage } from './closing/closing-page';
import { TemplatesPage } from './templates/templates-page';

const organization = { organizationId: 'org-a', plan: { code: 'pilot', source: 'default', status: 'active' }, capabilities: {}, limits: { maxActiveEvents: null, maxSeats: 1 }, usage: { activeSeats: 1, seatBaselineVerified: true } };
function setup(request: (method: string, path: string, body?: unknown) => Promise<any> = async () => ({}), capabilities: Record<string, boolean> = {}) {
  const access = { ...organization, capabilities };
  const account = { organization: signal(access), current: signal({ activeOrganizationId: 'org-a', organizations: [{ organizationId: 'org-a', isHome: true, isOwner: true }] }), can: (key: string) => capabilities[key] === true, ensureLoaded: async () => true, reload: vi.fn(async () => true), busy: signal(false), error: signal('') };
  TestBed.configureTestingModule({ providers: [
    provideRouter([
      { path: 'app/plan', component: PlanPage }, { path: 'app/equipo', component: TeamPage },
      { path: 'app/plantillas', component: TemplatesPage }, { path: 'eventos/:eventId/cierre', component: ClosingPage },
    ]),
    { provide: ApiClient, useValue: { request } },
    { provide: SessionService, useValue: { token: signal(''), ready: signal(true), authenticated: signal(true), local: signal(true), message: signal(''), initialize: async () => {}, signOut: vi.fn() } },
    { provide: OrganizationStore, useValue: account },
  ] });
  TestBed.inject(OrganizationContext).select('org-a');
  return account;
}

describe('organization workspaces', () => {
  it('refreshes verified plan and seat capacity when requested', async () => {
    const account = setup(vi.fn(async () => ({ events: [], usage: { nonArchivedEvents: 0, limit: null } })));
    const harness = await RouterTestingHarness.create('/app/plan');
    await harness.fixture.whenStable(); harness.detectChanges();
    const button = [...harness.routeNativeElement!.querySelectorAll('button')].find(item => item.textContent?.includes('Actualizar capacidad'))!;
    button.click();
    await harness.fixture.whenStable();
    expect(account.reload).toHaveBeenCalledOnce();
  });
  it.each(['role', 'revoke'])('refreshes verified organization access after a successful team %s change', async action => {
    const member = { memberId: 'person', organizationId: 'org-a', roles: ['auditor'], eventIds: null, status: 'active', version: 1, isOwner: false };
    const account = setup(vi.fn(async (method: string) => method === 'POST' ? { member: { ...member, version: 2 } } : { members: [member] }), { manageTeam: true });
    const harness = await RouterTestingHarness.create('/app/equipo');
    await harness.fixture.whenStable();
    const page = harness.routeDebugElement!.componentInstance as TeamPage;
    if (action === 'revoke') { page.revoking.set(member as any); await page.revoke(); }
    else { page.edit(member as any); page.model.update(value => ({ ...value, acknowledged: true })); await page.save(new Event('submit')); }
    expect(account.reload).toHaveBeenCalledOnce();
  });
  it('shows actual pilot access without an upgrade or invented unlimited allowance', async () => {
    setup(vi.fn(async () => ({ events: [], usage: { nonArchivedEvents: 0, limit: null } })));
    const harness = await RouterTestingHarness.create('/app/plan');
    await harness.fixture.whenStable(); harness.detectChanges();
    const text = harness.routeNativeElement?.textContent ?? '';
    expect(text).toContain('Piloto');
    expect(text).toContain('Sin cuota comercial');
    expect(text).toContain('1 MiB');
    expect(text.toLowerCase()).not.toContain('ilimitado');
    expect([...harness.routeNativeElement!.querySelectorAll('button')].some(button => /comprar|contratar|mejorar plan/i.test(button.textContent ?? ''))).toBe(false);
  });

  it('preserves template history without showing create actions after a downgrade', async () => {
    setup(vi.fn(async () => ({ templates: [{ templateId: 't1', name: 'Taller anterior', version: 1, currency: 'MXN', participantCount: 2 }] })));
    const harness = await RouterTestingHarness.create('/app/plantillas');
    await harness.fixture.whenStable(); harness.detectChanges();
    expect(harness.routeNativeElement?.textContent).toContain('Taller anterior');
    expect(harness.routeNativeElement?.textContent).toContain('consulta');
    expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
  });

  it('never offers to revoke the owner or invents an invitation flow', async () => {
    setup(vi.fn(async () => ({ members: [{ memberId: 'owner', roles: ['admin'], eventIds: null, status: 'active', version: 1, isOwner: true }] })), { manageTeam: true });
    const harness = await RouterTestingHarness.create('/app/equipo');
    await harness.fixture.whenStable(); harness.detectChanges();
    expect(harness.routeNativeElement?.textContent).toContain('Propietario');
    expect(harness.routeNativeElement?.textContent).toContain('administrada');
    expect([...harness.routeNativeElement!.querySelectorAll('button')].some(button => /revocar|invitar/i.test(button.textContent ?? ''))).toBe(false);
  });

  it('does not request a team roster when the current access cannot administer members', async () => {
    const request = vi.fn(async () => ({ members: [] }));
    setup(request);
    const harness = await RouterTestingHarness.create('/app/equipo');
    await harness.fixture.whenStable(); harness.detectChanges();
    expect(request).not.toHaveBeenCalled();
    expect(harness.routeNativeElement?.textContent).toContain('requiere acceso Equipo');
  });

  it('uses server closing permissions and keeps historical exports after a downgrade', async () => {
    setup(vi.fn(async (_method: string, path: string) => path.endsWith('/closing') ? { financialStatus: 'closed', lifecycleVersion: 2, ledgerVersion: 3, eventRevision: 4, canClose: false, canReopen: true, canArchive: false, closures: [{ closureId: 'c1', createdAt: '2026-11-19T21:00:00Z', createdBy: 'subject', ledgerVersion: 3, rosterRevision: 4 }] } : { event: { eventId: 'e1', name: 'Taller', currency: 'MXN' } }));
    const harness = await RouterTestingHarness.create('/eventos/e1/cierre');
    await harness.fixture.whenStable(); harness.detectChanges();
    const buttons = [...harness.routeNativeElement!.querySelectorAll('button')];
    expect(buttons.some(button => button.textContent?.includes('Exportar cierre'))).toBe(true);
    expect(buttons.some(button => button.textContent?.trim() === 'Cerrar finanzas')).toBe(false);
    expect(harness.routeNativeElement?.textContent).toContain('Versión del ledger');
  });
  it('offers a recoverable reopening after reloading a pending transition', async () => {
    setup(vi.fn(async (_method: string, path: string) => path.endsWith('/closing') ? { financialStatus: 'open', lifecycleVersion: 3, ledgerVersion: 7, eventRevision: 8, transition: { kind: 'reopening', operationId: 'resume', closureId: 'c1', expectedLifecycleVersion: 2, expectedEventRevision: 8 }, canClose: false, canReopen: true, canArchive: false, closures: [] } : { event: { eventId: 'e1', name: 'Taller', currency: 'MXN' } }));
    const harness = await RouterTestingHarness.create('/eventos/e1/cierre');
    await harness.fixture.whenStable(); harness.detectChanges();
    expect([...harness.routeNativeElement!.querySelectorAll('button')].some(button => button.textContent?.includes('Reanudar reapertura'))).toBe(true);
  });
});
