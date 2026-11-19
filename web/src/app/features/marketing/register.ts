import { afterNextRender, ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SessionService } from '../../core/session';

@Component({
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-register',
  styleUrl: './register.scss',
  templateUrl: './register.html',
})
export class Register {
  readonly session = inject(SessionService);
  private readonly router = inject(Router);
  constructor() { afterNextRender(() => { void this.session.initialize(); }); }
  async create() {
    if (this.session.authenticated()) { await this.router.navigateByUrl('/app'); return; }
    if (this.session.registrationEnabled()) await this.session.signIn('signup');
  }
  async enter() { if (this.session.authenticated()) await this.router.navigateByUrl('/app'); else await this.session.signIn(); }
}
