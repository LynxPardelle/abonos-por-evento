import { Injectable, computed, signal } from '@angular/core';
import { RuntimeConfig } from './models';

const SESSION_KEY = 'saldoevento.session';
const PKCE_KEY = 'saldoevento.pkce';
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type AccessIntent = 'signin' | 'signup';
export function createAuthorizationUrl(config: Pick<RuntimeConfig, 'cognitoDomain' | 'clientId'>, origin: string, intent: AccessIntent, challenge: string, state: string): URL {
  const provider = new URL(config.cognitoDomain);
  if (provider.protocol !== 'https:' || provider.username || provider.password || provider.search || provider.hash || provider.pathname !== '/' || !config.clientId) throw new Error('El proveedor de acceso no está configurado correctamente.');
  const authorize = new URL(intent === 'signup' ? '/signup' : '/oauth2/authorize', provider);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: `${origin}/auth/callback`, scope: 'openid email', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return authorize;
}

function storedObject(key: string) {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); }
  catch { sessionStorage.removeItem(key); return undefined; }
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  readonly ready = signal(false);
  readonly local = signal(false);
  readonly registrationEnabled = signal(false);
  readonly token = signal('');
  readonly message = signal('');
  readonly authenticated = computed(() => this.local() || !!this.token());
  private config: RuntimeConfig = { mode: 'cloud', cognitoDomain: '', clientId: '' };
  private initialization?: Promise<void>;

  initialize(): Promise<void> {
    return this.initialization ??= this.load();
  }

  private async load() {
    try {
      const response = await fetch('/runtime-config.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('No se pudo leer la configuración de acceso.');
      this.config = await response.json();
      this.registrationEnabled.set(this.config.mode === 'cloud' && this.config.selfRegistrationEnabled === true);
      // Local mode is served only by the loopback synthetic API, never the cloud SSR server.
      this.local.set(this.config.mode === 'local' && ['localhost', '127.0.0.1'].includes(location.hostname));
      const callback = new URL(location.href);
      if (callback.pathname === '/auth/callback') await this.completeSignIn(callback);
      const stored = storedObject(SESSION_KEY);
      if (typeof stored?.token === 'string' && stored.token.length > 0 && Number.isFinite(stored.expiresAt) && stored.expiresAt > Date.now()) this.token.set(stored.token);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'No se pudo iniciar la sesión.'); }
    finally { this.ready.set(true); }
  }

  async signIn(intent: AccessIntent = 'signin') {
    try {
      this.message.set('');
      await this.initialize();
      if (intent === 'signup' && !this.registrationEnabled()) throw new Error('El registro todavía no está habilitado en este ambiente.');
      if (!this.config.cognitoDomain || !this.config.clientId) throw new Error('El acceso aún necesita la configuración del ambiente.');
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
      const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, createdAt: Date.now() }));
      const authorize = createAuthorizationUrl(this.config, location.origin, intent, challenge, state);
      location.assign(authorize);
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'No se pudo iniciar el acceso.'); }
  }

  private async completeSignIn(url: URL) {
    const pkce = storedObject(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    history.replaceState({}, '', '/app');
    if (url.searchParams.has('error')) throw new Error('El proveedor de identidad rechazó el acceso.');
    const elapsed = Date.now() - pkce?.createdAt;
    if (!pkce || pkce.state !== url.searchParams.get('state') || !/^[A-Za-z0-9_-]{43,128}$/.test(pkce.verifier) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 600_000 || !url.searchParams.get('code')) throw new Error('El intento de acceso caducó. Inicia sesión de nuevo.');
    const response = await fetch(new URL('/oauth2/token', this.config.cognitoDomain), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, code: url.searchParams.get('code')!, redirect_uri: `${location.origin}/auth/callback`, code_verifier: pkce.verifier }),
    });
    if (!response.ok) throw new Error('No se pudo completar el acceso.');
    const tokens = await response.json();
    if (typeof tokens.id_token !== 'string' || !(tokens.expires_in > 0)) throw new Error('Respuesta de identidad inválida.');
    // The API validates signature, issuer, audience, organization and roles. No claims from the UI grant access.
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000 }));
  }

  signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    this.token.set('');
    if (this.config.cognitoDomain && this.config.clientId) {
      const logout = new URL('/logout', this.config.cognitoDomain);
      logout.search = new URLSearchParams({ client_id: this.config.clientId, logout_uri: location.origin }).toString();
      location.assign(logout);
    }
  }
}
