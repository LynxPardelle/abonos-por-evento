import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api';
import { SessionService } from './session';

describe('authenticated API boundary', () => {
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
