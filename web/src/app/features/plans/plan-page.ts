import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiClient } from '../../core/api';
import { OrganizationStore } from '../../core/organization.store';
import { planNames } from '../../core/organization.models';
import { EventList } from '../../core/product.models';
import { scopedRequest } from '../../core/scoped-request';
import { WorkspaceFrame } from '../workspace/workspace-frame';

@Component({
  imports: [WorkspaceFrame],
  selector: 'app-plan-page',
  styleUrl: './plan-page.scss',
  templateUrl: './plan-page.html',
})
export class PlanPage {
  readonly organization = inject(OrganizationStore);
  private readonly api = inject(ApiClient);
  readonly usage = signal<EventList['usage']>(undefined);
  readonly request = scopedRequest(() => this.usage.set(undefined));
  readonly names = planNames;
  readonly tiers = [
    { name: 'Por Evento', audience: 'Un evento ocasional', detail: 'Cierre financiero y reportes. Una contratación por evento, todavía por validar.', capacity: '1 evento en trabajo · 1 persona' },
    { name: 'Organizador', audience: 'Eventos recurrentes', detail: 'Plantillas y una vista entre eventos. Modelo mensual o anual por validar.', capacity: '5 eventos en trabajo · 1 persona' },
    { name: 'Equipo', audience: 'Una operación compartida', detail: 'Colaboradores administrados, roles y alcance por evento. Modelo mensual o anual por validar.', capacity: '20 eventos en trabajo · 5 personas' },
  ];
  constructor() { effect(() => { if (this.organization.current()) untracked(() => { void this.loadUsage(); }); }); }
  refresh() { return this.organization.reload(); }
  private loadUsage() { return this.request.run(() => this.api.request<EventList>('GET', '/events'), result => this.usage.set(result.usage)); }
}
