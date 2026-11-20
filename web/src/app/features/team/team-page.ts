import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormField, form, submit } from '@angular/forms/signals';
import { OrganizationStore } from '../../core/organization.store';
import { Role, TeamMember, roleNames } from '../../core/organization.models';
import { WorkspaceFrame } from '../workspace/workspace-frame';
import { TeamStore } from './team.store';

@Component({
  imports: [WorkspaceFrame, FormField],
  providers: [TeamStore],
  selector: 'app-team-page',
  styleUrl: './team-page.scss',
  templateUrl: './team-page.html',
})
export class TeamPage {
  readonly store = inject(TeamStore);
  readonly organization = inject(OrganizationStore);
  readonly labels = roleNames;
  readonly roleOptions: Role[] = ['operator', 'importer', 'confirmer', 'auditor'];
  readonly editing = signal<TeamMember | undefined>(undefined);
  readonly revoking = signal<TeamMember | undefined>(undefined);
  readonly model = signal({ operator: false, importer: false, confirmer: false, auditor: true, eventIds: '', acknowledged: false });
  readonly fields = form(this.model);
  readonly selectedRoles = computed(() => this.roleOptions.filter(role => this.model()[role]));
  constructor() { effect(() => { if (this.organization.current()) untracked(() => { this.editing.set(undefined); this.revoking.set(undefined); void this.refresh(); }); }); }
  refresh() { if (this.organization.can('manageTeam')) return this.store.load(); this.store.members.set([]); return undefined; }
  edit(member: TeamMember) {
    if (member.isOwner || !this.organization.can('manageTeam')) return;
    this.revoking.set(undefined); this.editing.set(member);
    this.model.set({ operator: member.roles.includes('operator'), importer: member.roles.includes('importer'), confirmer: member.roles.includes('confirmer'), auditor: member.roles.includes('auditor'), eventIds: member.eventIds?.join(', ') ?? '', acknowledged: false });
  }
  async save(event: Event) {
    event.preventDefault();
    await submit(this.fields, async () => {
      const member = this.editing(), value = this.model();
      if (!member || !value.acknowledged || !this.organization.can('manageTeam') || !this.selectedRoles().length) return;
      const eventIds = [...new Set(value.eventIds.split(',').map(id => id.trim()).filter(Boolean))];
      if (await this.store.changeRole(member, this.selectedRoles(), eventIds.length ? eventIds : null)) { this.editing.set(undefined); await this.organization.reload(); }
    });
  }
  async revoke() { const member = this.revoking(); if (member && !member.isOwner && this.organization.can('manageTeam') && await this.store.revoke(member)) { this.revoking.set(undefined); await this.organization.reload(); } }
}
