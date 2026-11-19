import { Component, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { FormField, form, required, submit } from '@angular/forms/signals';
import { OrganizationStore } from '../../core/organization.store';
import { formatMinor } from '../../core/money';
import { WorkspaceFrame } from '../workspace/workspace-frame';
import { TemplatesStore } from './templates.store';

@Component({
  imports: [WorkspaceFrame, FormField],
  providers: [TemplatesStore],
  selector: 'app-templates-page',
  styleUrl: './templates-page.scss',
  templateUrl: './templates-page.html',
})
export class TemplatesPage {
  readonly store = inject(TemplatesStore);
  readonly organization = inject(OrganizationStore);
  private readonly router = inject(Router);
  readonly model = signal({ name: '', sourceEventId: '' });
  readonly fields = form(this.model, path => { required(path.name); required(path.sourceEventId); });
  readonly useModel = signal({ name: '' });
  readonly useFields = form(this.useModel, path => required(path.name));
  readonly format = formatMinor;
  constructor() { effect(() => { if (this.organization.current()) untracked(() => { void this.store.load(this.organization.can('manageTemplates')); }); }); }
  async save(event: Event) { event.preventDefault(); await submit(this.fields, async () => { const input = this.model(); await this.store.save({ ...input, name: input.name.trim() }); }); }
  async use(event: Event) {
    event.preventDefault();
    await submit(this.useFields, async () => {
      const template = this.store.selected();
      if (!template) return;
      const result = await this.store.createEvent(template, this.useModel().name.trim());
      if (result) await this.router.navigate(['/eventos', result.event.eventId, 'asistentes']);
    });
  }
}
