import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../../core/api';
import { EventRecord } from '../../core/models';
import { ClosingState, EventReport } from '../../core/product.models';
import { scopedRequest } from '../../core/scoped-request';

export function downloadReport(report: EventReport) {
  if (!/^text\/csv(?:;|$)/i.test(report.contentType) || typeof report.content !== 'string' || !report.fileName) throw new Error('El reporte recibido no es válido.');
  const url = URL.createObjectURL(new Blob([report.content], { type: report.contentType }));
  const link = document.createElement('a');
  link.href = url; link.download = report.fileName.replace(/[\\/:*?"<>|\r\n]/g, '-');
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

@Injectable()
export class ClosingStore {
  private readonly api = inject(ApiClient);
  readonly event = signal<EventRecord | undefined>(undefined);
  readonly closing = signal<ClosingState | undefined>(undefined);
  readonly request = scopedRequest(() => { this.event.set(undefined); this.closing.set(undefined); });
  load(eventId: string) {
    const base = `/events/${encodeURIComponent(eventId)}`;
    return this.request.run(async () => {
      const [event, closing] = await Promise.all([this.api.request<{ event: EventRecord }>('GET', base), this.api.request<ClosingState>('GET', `${base}/closing`)]);
      return { event: event.event, closing };
    }, result => { this.event.set(result.event); this.closing.set(result.closing); });
  }
  async transition(action: 'close' | 'reopen' | 'archive') {
    const event = this.event(), state = this.closing();
    if (!event || !state) return undefined;
    const resume = action === 'reopen' && state.transition?.kind === 'reopening' ? state.transition : undefined;
    const input = action === 'close' ? { expectedLedgerVersion: state.ledgerVersion, expectedLifecycleVersion: state.lifecycleVersion } : { expectedLifecycleVersion: resume?.expectedLifecycleVersion ?? state.lifecycleVersion, expectedEventRevision: resume?.expectedEventRevision ?? state.eventRevision };
    const operationId = resume?.operationId ?? this.request.operationId(action, [event.eventId, input]);
    const result = await this.request.run(() => this.api.request('POST', `/events/${encodeURIComponent(event.eventId)}/${action === 'close' ? 'closing' : action}`, { ...input, operationId }), () => {});
    if (result !== undefined) {
      if (!await this.load(event.eventId)) return undefined;
      this.request.notice.set(this.closing()?.transition ? 'La reapertura sigue pendiente. Puedes reanudar la misma operación.' : ({ close: 'Cierre financiero guardado. El reporte conserva su versión.', reopen: 'Finanzas reabiertas. Los cierres anteriores se conservan.', archive: 'Evento archivado. El historial y sus cierres permanecen consultables.' })[action]);
    }
    return result;
  }
  export(closureId?: string) {
    const event = this.event(); if (!event) return;
    return this.request.run(() => this.api.request<EventReport>('GET', `/events/${encodeURIComponent(event.eventId)}/report${closureId ? `/${encodeURIComponent(closureId)}` : ''}`), downloadReport, 'Reporte descargado.');
  }
}
