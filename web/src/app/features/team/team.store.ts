import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../../core/api';
import { Role, TeamMember } from '../../core/organization.models';
import { scopedRequest } from '../../core/scoped-request';

@Injectable()
export class TeamStore {
  private readonly api = inject(ApiClient);
  readonly members = signal<TeamMember[]>([]);
  readonly request = scopedRequest(() => this.members.set([]));
  load() { return this.request.run(() => this.api.request<{ members: TeamMember[] }>('GET', '/organizations/current/members'), result => this.members.set(result.members)); }
  private update(member: TeamMember, action: 'role' | 'revoke', details: { roles: Role[]; eventIds?: string[] | null } | Record<string, never>) {
    const input = { expectedVersion: member.version, ...details };
    return this.request.run(() => this.api.request<{ member: TeamMember }>('POST', `/organizations/current/members/${encodeURIComponent(member.memberId)}/${action}`, { ...input, operationId: this.request.operationId(`${action}-${member.memberId}`, input) }), result => this.members.update(items => items.map(item => item.memberId === result.member.memberId ? result.member : item)), action === 'revoke' ? 'Acceso revocado. El historial del equipo se conserva.' : 'Permisos actualizados.');
  }
  changeRole(member: TeamMember, roles: Role[], eventIds?: string[] | null) { return this.update(member, 'role', { roles, ...(eventIds !== undefined ? { eventIds } : {}) }); }
  revoke(member: TeamMember) { return this.update(member, 'revoke', {}); }
}
