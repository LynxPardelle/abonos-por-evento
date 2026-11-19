import { Routes } from '@angular/router';
import { WorkspaceStore } from './features/workspace/workspace.store';

const workspace = () => import('./features/workspace/workspace').then(module => module.Workspace);
export const routes: Routes = [
  { path: '', title: 'SaldoEvento · Cada abono en su lugar', loadComponent: () => import('./features/marketing/landing').then(module => module.Landing) },
  { path: 'registro', title: 'Crea tu cuenta de piloto · SaldoEvento', loadComponent: () => import('./features/marketing/register').then(module => module.Register) },
  { path: 'app', title: 'Eventos · SaldoEvento', providers: [WorkspaceStore], data: { section: 'events' }, loadComponent: workspace },
  { path: 'auth/callback', title: 'Acceso · SaldoEvento', loadComponent: () => import('./core/auth-callback').then(module => module.AuthCallback) },
  { path: 'eventos/:eventId', providers: [WorkspaceStore], children: [
    { path: 'asistentes', title: 'Participantes · SaldoEvento', data: { section: 'participants' }, loadComponent: workspace },
    { path: 'importaciones', title: 'Importaciones · SaldoEvento', data: { section: 'imports' }, loadComponent: workspace },
    { path: 'movimientos', title: 'Movimientos · SaldoEvento', data: { section: 'movements' }, loadComponent: workspace },
    { path: '', pathMatch: 'full', redirectTo: 'asistentes' },
  ] },
  { path: '**', redirectTo: '' },
];
