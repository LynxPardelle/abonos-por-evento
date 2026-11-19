import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { routes } from './app.routes';

describe('SaldoEvento', () => {
  it('identifies the product and keeps operational routes available', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    const harness = await RouterTestingHarness.create('/app');
    const page = harness.routeNativeElement;

    expect(page?.textContent ?? '').toContain('SaldoEvento');
    expect(page?.querySelector('main')).toBeTruthy();
  });
});
