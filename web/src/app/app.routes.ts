import { Routes } from '@angular/router';
import { WorkspaceStore } from './features/workspace/workspace.store';

const workspace = () => import('./features/workspace/workspace').then(module => module.Workspace);
export const routes: Routes = [
  { path: '', title: 'SaldoEvento · Cada abono en su lugar', loadComponent: () => import('./features/marketing/landing').then(module => module.Landing) },
  { path: 'registro', title: 'Crea tu cuenta de piloto · SaldoEvento', loadComponent: () => import('./features/marketing/register').then(module => module.Register) },
  { path: 'app/plan', title: 'Plan y capacidad · SaldoEvento', loadComponent: () => import('./features/plans/plan-page').then(module => module.PlanPage) },
  { path: 'app/plantillas', title: 'Plantillas · SaldoEvento', loadComponent: () => import('./features/templates/templates-page').then(module => module.TemplatesPage) },
  { path: 'app/equipo', title: 'Equipo y permisos · SaldoEvento', loadComponent: () => import('./features/team/team-page').then(module => module.TeamPage) },
  { path: 'app', title: 'Eventos · SaldoEvento', providers: [WorkspaceStore], data: { section: 'events' }, loadComponent: workspace },
  { path: 'auth/callback', title: 'Acceso · SaldoEvento', loadComponent: () => import('./core/auth-callback').then(module => module.AuthCallback) },
  { path: 'eventos/:eventId', providers: [WorkspaceStore], children: [
    { path: 'cierre', title: 'Cierre y reportes · SaldoEvento', loadComponent: () => import('./features/closing/closing-page').then(module => module.ClosingPage) },
    { path: 'asistentes', title: 'Participantes · SaldoEvento', data: { section: 'participants' }, loadComponent: workspace },
    { path: 'importaciones', title: 'Importaciones · SaldoEvento', data: { section: 'imports' }, loadComponent: workspace },
    { path: 'movimientos', title: 'Movimientos · SaldoEvento', data: { section: 'movements' }, loadComponent: workspace },
    { path: '', pathMatch: 'full', redirectTo: 'asistentes' },
  ] },
  { path: '**', redirectTo: '' },
];
