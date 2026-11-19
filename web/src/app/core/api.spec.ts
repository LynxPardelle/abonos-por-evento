import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api';
import { SessionService } from './session';
import { OrganizationContext } from './organization-context';

describe('authenticated API boundary', () => {
  it('sends the selected organization and discards an old response after a switch', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const context = TestBed.inject(OrganizationContext);
    context.select('org-a');
    const client = TestBed.inject(ApiClient);
    const http = TestBed.inject(HttpTestingController);
    const result = client.request('GET', '/events').catch(error => error);
    const request = http.expectOne('/api/v1/events');
    expect(request.request.headers.get('X-SaldoEvento-Organization')).toBe('org-a');
    context.select('org-b');
    request.flush({ events: [{ name: 'Private organization A' }] });
    expect(await result).toMatchObject({ code: 'ORGANIZATION_CHANGED' });
    http.verify();
  });
  it('sends the session token to the API and requires a new session after a 401', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const session = TestBed.inject(SessionService);
    session.token.set('synthetic-test-token');
    const client = TestBed.inject(ApiClient);
    const http = TestBed.inject(HttpTestingController);
    const result = client.request('GET', '/events').catch(error => error);
    const request = http.expectOne('/api/v1/events');
    expect(request.request.headers.get('Authorization')).toBe('Bearer synthetic-test-token');
    request.flush({ error: { message: 'La sesión venció.' } }, { status: 401, statusText: 'Unauthorized' });
    await result;
    expect(session.token()).toBe('');
    expect(session.message()).toContain('sesión');
    http.verify();
  });
});
