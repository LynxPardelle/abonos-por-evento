import { signalStore, withState } from '@ngrx/signals';

interface WorkspaceArea {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

interface WorkspaceState {
  readonly title: string;
  readonly description: string;
  readonly areas: readonly WorkspaceArea[];
}

const initialState: WorkspaceState = {
  title: 'Abonos por Evento',
  description: 'Revisa movimientos importados y conserva el saldo por participante.',
  areas: [
    { id: 'events', label: 'Eventos', description: 'Participantes, compromisos y permisos de operación.' },
    { id: 'reconciliation', label: 'Conciliación', description: 'Importaciones, abonos, saldos y movimientos reversados.' },
  ],
};

export const WorkspaceStore = signalStore(withState(initialState));
