import { TestBed } from '@angular/core/testing';
import { createAuthorizationUrl, SessionService } from './session';

const config = { mode: 'cloud', cognitoDomain: 'https://synthetic.auth.us-east-1.amazoncognito.com', clientId: 'synthetic-client', selfRegistrationEnabled: true };

describe('self-service access and callback', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState({}, '', '/');
  });
  it('opens signup with Authorization Code, S256 and the same registered callback as sign-in', () => {
    const signup = createAuthorizationUrl(config, 'https://saldoevento-test.lynxpardelle.com', 'signup', 'synthetic-challenge', 'synthetic-state');
    expect(signup.pathname).toBe('/signup');
    expect(signup.searchParams.get('response_type')).toBe('code');
    expect(signup.searchParams.get('code_challenge_method')).toBe('S256');
    expect(signup.searchParams.get('redirect_uri')).toBe('https://saldoevento-test.lynxpardelle.com/auth/callback');
    expect(createAuthorizationUrl(config, 'https://saldoevento-test.lynxpardelle.com', 'signin', 'challenge', 'state').pathname).toBe('/oauth2/authorize');
    expect(() => createAuthorizationUrl({ ...config, cognitoDomain: 'http://untrusted.invalid' }, 'https://saldoevento-test.lynxpardelle.com', 'signup', 'challenge', 'state')).toThrow();
  });
  it('reads the public registration flag without treating invalid local storage as an account', async () => {
    sessionStorage.setItem('saldoevento.session', '{broken-json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => config }));
    const session = TestBed.inject(SessionService);
    await session.initialize();
    expect(session.registrationEnabled()).toBe(true);
    expect(session.authenticated()).toBe(false);
    expect(session.message()).toBe('');
    expect(sessionStorage.getItem('saldoevento.session')).toBeNull();
  });
  it('rejects a callback with mismatched state before contacting the token endpoint', async () => {
    history.replaceState({}, '', '/auth/callback?code=synthetic-code&state=wrong');
    sessionStorage.setItem('saldoevento.pkce', JSON.stringify({ verifier: 'v'.repeat(64), state: 'right', createdAt: Date.now() }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => config });
    vi.stubGlobal('fetch', fetchMock);
    const session = TestBed.inject(SessionService);
    await session.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.authenticated()).toBe(false);
    expect(session.message()).toContain('caducó');
    expect(location.pathname).toBe('/app');
  });
  it('exchanges a valid callback once and restores the new account in the operational app', async () => {
    history.replaceState({}, '', '/auth/callback?code=synthetic-code&state=right');
    sessionStorage.setItem('saldoevento.pkce', JSON.stringify({ verifier: 'v'.repeat(64), state: 'right', createdAt: Date.now() }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => config })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id_token: 'synthetic-id-token', expires_in: 900 }) });
    vi.stubGlobal('fetch', fetchMock);
    const session = TestBed.inject(SessionService);
    await Promise.all([session.initialize(), session.initialize()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.authenticated()).toBe(true);
    expect(session.token()).toBe('synthetic-id-token');
    expect(location.pathname).toBe('/app');
    expect(sessionStorage.getItem('saldoevento.pkce')).toBeNull();
    expect(fetchMock.mock.calls[1][1].body.get('code_verifier')).toBe('v'.repeat(64));
  });
});
