import { afterNextRender, ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SessionService } from './session';

@Component({
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auth-callback',
  styles: `main{max-width:34rem;margin:15vh auto;padding:2rem;font-size:1rem}h1{margin:2rem 0 1rem}a{font-weight:700}p{line-height:1.7}button{margin-top:1rem}`,
  template: `<main><a routerLink="/">SaldoEvento.</a><h1>Preparando tu espacio</h1>@if (session.message()) {<p role="alert">{{session.message()}}</p><button (click)="session.signIn()">Volver a entrar</button>} @else {<p role="status">Estamos comprobando el acceso a tu cuenta.</p>}</main>`,
})
export class AuthCallback {
  readonly session = inject(SessionService);
  private readonly router = inject(Router);
  constructor() { afterNextRender(() => { void this.session.initialize().then(() => { if (this.session.authenticated()) void this.router.navigateByUrl('/app', { replaceUrl: true }); }); }); }
}
