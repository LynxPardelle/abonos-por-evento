import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SessionService } from './session';
import { OrganizationContext } from './organization-context';

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly context = inject(OrganizationContext);
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const epoch = this.context.capture();
    const token = this.session.token();
    let headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : new HttpHeaders();
    const organizationId = this.context.organizationId();
    if (organizationId) headers = headers.set('X-SaldoEvento-Organization', organizationId);
    const assertCurrent = () => {
      if (!this.context.isCurrent(epoch) || this.session.token() !== token) throw Object.assign(new Error('La organización cambió.'), { code: 'ORGANIZATION_CHANGED' });
    };
    return firstValueFrom(this.http.request<T>(method, `/api/v1${path}`, { body, headers })).then(result => { assertCurrent(); return result; }).catch(error => {
      assertCurrent();
      if (error.status === 401) {
        sessionStorage.removeItem('saldoevento.session');
        this.session.token.set('');
        this.context.reset();
        this.session.message.set('La sesión venció. Vuelve a entrar para continuar.');
      }
      throw error;
    });
  }
  async upload(url: string, file: File, headers: Record<string, string>) {
    const response = await fetch(url, { method: 'PUT', headers, body: file });
    if (!response.ok) throw new Error('La carga no se completó. Puedes volver a enviar el mismo archivo.');
  }
}
