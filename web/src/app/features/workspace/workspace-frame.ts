import { afterNextRender, Component, effect, inject, input, untracked } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { EventRecord } from '../../core/models';
import { SessionService } from '../../core/session';
import { OrganizationStore } from '../../core/organization.store';
import { planNames } from '../../core/organization.models';

@Component({
  imports: [RouterLink, RouterLinkActive],
  selector: 'app-workspace-frame',
  styleUrl: './workspace-frame.scss',
  templateUrl: './workspace-frame.html',
})
export class WorkspaceFrame {
  readonly session = inject(SessionService);
  readonly organization = inject(OrganizationStore);
  private readonly router = inject(Router);
  readonly event = input<EventRecord>();
  readonly heading = input('');
  readonly busy = input(false);
  readonly planNames = planNames;
  constructor() {
    afterNextRender(() => { void this.session.initialize(); });
    effect(() => {
      if (this.session.ready() && this.session.authenticated()) untracked(() => { void this.organization.ensureLoaded(); });
    });
  }
  async switchOrganization(event: Event) {
    const candidate = (event.target as HTMLSelectElement).value;
    await this.organization.switchOrganization(candidate);
    await this.router.navigateByUrl('/app');
  }
  async home() { await this.organization.returnHome(); await this.router.navigateByUrl('/app'); }
}
