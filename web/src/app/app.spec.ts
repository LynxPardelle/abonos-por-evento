import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { routes } from './app.routes';

describe('Abonos por Evento', () => {
  it('loads the product workspace and its two main areas', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    const harness = await RouterTestingHarness.create('/');
    const page = harness.routeNativeElement;

    expect(page?.querySelector('h1')?.textContent ?? '').toContain('Abonos por Evento');
    expect(page?.querySelectorAll('main ul li')).toHaveLength(2);
  });
});
