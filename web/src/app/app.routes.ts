import { Routes } from '@angular/router';
import { WorkspaceStore } from './features/workspace/workspace.store';

const workspace = () => import('./features/workspace/workspace').then(module => module.Workspace);
export const routes: Routes = [
  { path: '', title: 'Eventos · SaldoEvento', providers: [WorkspaceStore], data: { section: 'events' }, loadComponent: workspace },
  { path: 'auth/callback', title: 'Acceso · SaldoEvento', providers: [WorkspaceStore], data: { section: 'events' }, loadComponent: workspace },
  { path: 'eventos/:eventId', providers: [WorkspaceStore], children: [
    { path: 'asistentes', title: 'Participantes · SaldoEvento', data: { section: 'participants' }, loadComponent: workspace },
    { path: 'importaciones', title: 'Importaciones · SaldoEvento', data: { section: 'imports' }, loadComponent: workspace },
    { path: 'movimientos', title: 'Movimientos · SaldoEvento', data: { section: 'movements' }, loadComponent: workspace },
    { path: '', pathMatch: 'full', redirectTo: 'asistentes' },
  ] },
  { path: '**', redirectTo: '' },
];
