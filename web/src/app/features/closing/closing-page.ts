import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormField, form } from '@angular/forms/signals';
import { OrganizationStore } from '../../core/organization.store';
import { WorkspaceFrame } from '../workspace/workspace-frame';
import { ClosingStore } from './closing.store';

@Component({
  imports: [WorkspaceFrame, RouterLink, FormField],
  providers: [ClosingStore],
  selector: 'app-closing-page',
  styleUrl: './closing-page.scss',
  templateUrl: './closing-page.html',
})
export class ClosingPage {
  readonly store = inject(ClosingStore);
  readonly organization = inject(OrganizationStore);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal((this.route.parent?.snapshot.paramMap.has('eventId') ? this.route.parent : this.route).paramMap);
  readonly eventId = computed(() => this.params()?.get('eventId') ?? '');
  readonly action = signal<'close' | 'reopen' | 'archive' | ''>('');
  readonly labels = { close: 'Cerrar finanzas', reopen: 'Reabrir finanzas', archive: 'Archivar evento' };
  readonly model = signal({ acknowledged: false });
  readonly fields = form(this.model);
  constructor() { effect(() => { const eventId = this.eventId(); if (this.organization.current() && eventId) untracked(() => { this.action.set(''); void this.store.load(eventId); }); }); }
  prepare(action: 'close' | 'reopen' | 'archive') { this.model.set({ acknowledged: false }); this.action.set(action); }
  async confirm(event: Event) { event.preventDefault(); const action = this.action(); if (action && this.model().acknowledged && await this.store.transition(action) !== undefined) this.action.set(''); }
  date(value: string) { return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC'; }
}
