import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { WorkspaceStore } from './workspace.store';
import { SessionService } from '../../core/session';
import { decimalToMinor, formatMinor } from '../../core/money';
import { ImportRow, Movement } from '../../core/models';

@Component({
  selector: 'app-workspace',
  imports: [RouterLink, RouterLinkActive, FormField],
  templateUrl: './workspace.html',
  styleUrl: './workspace.scss',
})
export class Workspace {
  readonly store = inject(WorkspaceStore);
  readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroy = inject(DestroyRef);
  private readonly routeData = toSignal(this.route.data);
  private readonly params = toSignal((this.route.parent?.snapshot.paramMap.has('eventId') ? this.route.parent : this.route).paramMap);
  readonly section = computed(() => this.routeData()?.['section'] ?? 'events');
  readonly title = computed(() => ({ events: 'Eventos', participants: 'Participantes y saldos', imports: 'Importaciones', movements: 'Movimientos' } as Record<string, string>)[this.section()] ?? 'Eventos');
  readonly format = formatMinor;
  readonly selectedFile = signal<File | undefined>(undefined);
  readonly localError = signal('');
  readonly review = signal<{ batchId: string; row: ImportRow } | undefined>(undefined);
  readonly reversing = signal<Movement | undefined>(undefined);
  readonly eventModel = signal({ name: '', currency: 'MXN' });
  readonly eventForm = form(this.eventModel, path => { required(path.name); required(path.currency); });
  readonly participantModel = signal({ name: '', reference: '', agreed: '' });
  readonly participantForm = form(this.participantModel, path => { required(path.name); required(path.reference); required(path.agreed); });
  readonly confirmationModel = signal({ participantId: '', acknowledged: false });
  readonly confirmationForm = form(this.confirmationModel, path => { required(path.participantId); });
  readonly manualModel = signal({ participantId: '', reference: '', amount: '', acknowledged: false });
  readonly manualForm = form(this.manualModel, path => { required(path.participantId); required(path.reference); required(path.amount); });
  private manualOperationId = '';
  private readonly manualDialog = viewChild<ElementRef<HTMLDialogElement>>('manualDialog');
  private readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');
  private readonly reversalDialog = viewChild<ElementRef<HTMLDialogElement>>('reversalDialog');

  constructor() {
    afterNextRender(() => {
      void this.session.initialize();
      const interval = setInterval(() => {
        if (!this.store.busy() && this.store.batches().some(batch => ['pending', 'uploaded', 'processing', 'awaiting_upload'].includes(batch.status))) void this.store.refresh();
      }, 5000);
      this.destroy.onDestroy(() => clearInterval(interval));
    });
    effect(() => {
      if (this.session.ready() && this.session.authenticated()) void this.store.load(this.params()?.get('eventId') ?? '');
    });
  }
  async createEvent(event: Event) {
    event.preventDefault();
    await submit(this.eventForm, async () => {
      const created = await this.store.createEvent(this.eventModel().name.trim(), this.eventModel().currency);
      if (created) await this.router.navigate(['/eventos', created.eventId, 'asistentes']);
    });
  }
  async addParticipant(event: Event) {
    event.preventDefault(); this.localError.set('');
    await submit(this.participantForm, async () => {
      try {
        const value = this.participantModel();
        if (await this.store.addParticipant({ name: value.name.trim(), reference: value.reference.trim(), agreedMinor: decimalToMinor(value.agreed) })) this.participantModel.set({ name: '', reference: '', agreed: '' });
      } catch (error) { this.localError.set((error as Error).message); }
    });
  }
  chooseFile(event: Event) { this.selectedFile.set((event.target as HTMLInputElement).files?.[0]); }
  async upload(event: Event) { event.preventDefault(); const file = this.selectedFile(); if (file) await this.store.importFile(file); }
  participantName(id: string) { return this.store.participants().find(person => person.participantId === id)?.name ?? id; }
  participantReference(id: string) { return this.store.participants().find(person => person.participantId === id)?.reference ?? '—'; }
  openReview(batchId: string, row: ImportRow) {
    this.review.set({ batchId, row });
    this.confirmationModel.set({ participantId: row.suggestedParticipantId ?? row.suggestion?.participantId ?? row.participantId ?? '', acknowledged: false });
    this.confirmDialog()?.nativeElement.showModal();
  }
  async confirm(event: Event) {
    event.preventDefault(); const review = this.review();
    if (review && this.confirmationModel().acknowledged && this.confirmationModel().participantId) {
      if (await this.store.confirm(review.batchId, review.row.rowId, this.confirmationModel().participantId)) this.confirmDialog()?.nativeElement.close();
    }
  }
  openReversal(movement: Movement) { this.reversing.set(movement); this.reversalDialog()?.nativeElement.showModal(); }
  async reverse() { const movement = this.reversing(); if (movement && await this.store.reverse(movement.movementId)) this.reversalDialog()?.nativeElement.close(); }
  openManual() {
    this.manualOperationId = crypto.randomUUID();
    this.manualModel.set({ participantId: '', reference: '', amount: '', acknowledged: false });
    this.localError.set('');
    this.manualDialog()?.nativeElement.showModal();
  }
  async saveManual(event: Event) {
    event.preventDefault(); this.localError.set('');
    await submit(this.manualForm, async () => {
      if (!this.manualModel().acknowledged) return;
      try {
        const value = this.manualModel();
        if (await this.store.recordPayment({ operationId: this.manualOperationId, participantId: value.participantId, reference: value.reference.trim(), amountMinor: decimalToMinor(value.amount) })) this.manualDialog()?.nativeElement.close();
      } catch (error) { this.localError.set((error as Error).message); }
    });
  }
  canReverse(movement: Movement) { return movement.kind !== 'reversal' && !this.store.movements().some(item => item.reversalOf === movement.movementId); }
  status(value: string) { return ({ ready: 'Para revisar', processed: 'Para revisar', pending: 'En espera', awaiting_upload: 'Esperando archivo', uploaded: 'Recibido', processing: 'Procesando', rejected: 'Rechazado', applied: 'Confirmado', confirmed: 'Confirmado', allocated: 'Confirmado', ambiguous: 'Revisión manual', suggested: 'Coincidencia', unmatched: 'Sin coincidencia', duplicate: 'Duplicado', failed: 'Requiere atención' } as Record<string, string>)[value.toLowerCase()] ?? value; }
}
