import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { SessionService } from '../../core/session';
import { routes } from '../../app.routes';
import { Landing } from './landing';

const session = () => ({ ready: signal(true), authenticated: signal(false), local: signal(false), registrationEnabled: signal(true), message: signal(''), initialize: vi.fn().mockResolvedValue(undefined), signIn: vi.fn().mockResolvedValue(undefined) });

describe('public product and registration journey', () => {
  it('introduces the real product with registration and honestly labels future plans', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: SessionService, useValue: session() }] });
    const harness = await RouterTestingHarness.create('/');
    const page = harness.routeNativeElement!;
    expect(page.querySelector('h1')?.textContent).toContain('SaldoEvento');
    expect(page.querySelector('a[href="/registro"]')).toBeTruthy();
    expect(page.textContent).toContain('Sin tarjeta');
    expect(page.textContent).toContain('En diseño');
    expect(page.querySelector('a[href*="checkout.stripe"]')).toBeFalsy();
  });
  it('lets the visitor explore confirmation and reversal without changing real data', async () => {
    TestBed.configureTestingModule({ imports: [Landing], providers: [provideRouter(routes), { provide: SessionService, useValue: session() }] });
    const fixture = TestBed.createComponent(Landing);
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;
    const button = [...page.querySelectorAll('button')].find(item => item.textContent?.includes('Con reverso'))!;
    button.click(); await fixture.whenStable();
    expect(page.querySelector('[data-testid="demo-total"]')?.textContent).toContain('750.00');
    expect(page.textContent).toContain('Ejemplo ilustrativo');
  });
  it('starts Cognito signup from the registration page without a payment form', async () => {
    const account = session();
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: SessionService, useValue: account }] });
    const harness = await RouterTestingHarness.create('/registro');
    const page = harness.routeNativeElement!;
    const create = [...page.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Crear cuenta')!;
    expect(create).toBeTruthy(); create.click();
    expect(account.signIn).toHaveBeenCalledWith('signup');
    expect(page.querySelector('input[type="password"]')).toBeFalsy();
  });
  it('explains when public registration is unavailable', async () => {
    const account = session(); account.registrationEnabled.set(false);
    TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: SessionService, useValue: account }] });
    const harness = await RouterTestingHarness.create('/registro');
    expect(harness.routeNativeElement?.textContent).toContain('El registro aún no está abierto');
  });
});
