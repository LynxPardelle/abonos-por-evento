import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionService } from '../../core/session';

@Component({
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-landing',
  styleUrl: './landing.scss',
  templateUrl: './landing.html',
})
export class Landing {
  readonly session = inject(SessionService);
  readonly demoPhase = signal<'imported' | 'confirmed' | 'reversed'>('confirmed');
  readonly demoTotal = computed(() => ({ imported: '0.00', confirmed: '1,250.00', reversed: '750.00' })[this.demoPhase()]);
  readonly demoPending = computed(() => ({ imported: '2,000.00', confirmed: '750.00', reversed: '1,250.00' })[this.demoPhase()]);
  readonly futurePlans = [
    { name: 'Por Evento', audience: 'Una ocasión, un cierre', description: 'Para quien organiza un taller, un curso o un encuentro puntual.', features: ['Contratación por evento', 'Cierre con exportes', 'Capacidad y vigencia por validar'] },
    { name: 'Organizador', audience: 'Tus eventos, con continuidad', description: 'Para quienes vuelven a abrir inscripciones durante el año.', features: ['Suscripción mensual o anual', 'Preparación reutilizable', 'Visión de varios eventos'] },
    { name: 'Equipo', audience: 'Un cierre compartido', description: 'Para organizaciones con varias personas en la operación.', features: ['Invitaciones de colaboradores', 'Permisos por persona', 'Trazabilidad ampliada'] },
  ];
  constructor() { afterNextRender(() => { void this.session.initialize(); }); }
  enter() { if (this.session.authenticated()) return; void this.session.signIn(); }
}
