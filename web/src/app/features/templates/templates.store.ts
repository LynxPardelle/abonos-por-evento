import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../../core/api';
import { EventRecord } from '../../core/models';
import { EventList, EventTemplate } from '../../core/product.models';
import { scopedRequest } from '../../core/scoped-request';

@Injectable()
export class TemplatesStore {
  private readonly api = inject(ApiClient);
  readonly templates = signal<EventTemplate[]>([]);
  readonly events = signal<EventRecord[]>([]);
  readonly selected = signal<EventTemplate | undefined>(undefined);
  readonly request = scopedRequest(() => { this.templates.set([]); this.events.set([]); this.selected.set(undefined); });
  load(canManage: boolean) {
    return this.request.run(async () => {
      const [templates, events] = await Promise.all([
        this.api.request<{ templates: EventTemplate[] }>('GET', '/templates'),
        canManage ? this.api.request<EventList>('GET', '/events') : Promise.resolve({ events: [] }),
      ]);
      return { templates: templates.templates, events: events.events };
    }, result => { this.templates.set(result.templates); this.events.set(result.events); });
  }
  select(templateId: string) { return this.request.run(() => this.api.request<{ template: EventTemplate }>('GET', `/templates/${encodeURIComponent(templateId)}`), result => this.selected.set(result.template)); }
  save(input: { name: string; sourceEventId: string }) {
    return this.request.run(() => this.api.request<{ template: EventTemplate }>('POST', '/templates', { ...input, operationId: this.request.operationId('template', input) }), result => { this.selected.set(result.template); this.templates.update(items => [...items.filter(item => item.templateId !== result.template.templateId), result.template]); }, 'Plantilla guardada. Conserva la preparación, sin copiar movimientos.');
  }
  createEvent(template: EventTemplate, name: string) {
    const input = { name, expectedTemplateVersion: template.version };
    return this.request.run(() => this.api.request<{ event: EventRecord }>('POST', `/templates/${encodeURIComponent(template.templateId)}/events`, { ...input, operationId: this.request.operationId(`use-${template.templateId}`, input) }), () => {});
  }
}
