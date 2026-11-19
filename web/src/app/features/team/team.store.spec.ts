import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../../core/api';
import { TeamMember } from '../../core/organization.models';
import { TeamStore } from './team.store';

describe('team permissions', () => {
  it('sends an explicit null when broadening an existing event scope', async () => {
    const member: TeamMember = { memberId: 'person', organizationId: 'org-a', roles: ['auditor'], eventIds: ['e1'], status: 'active', version: 3, isOwner: false };
    const request = vi.fn(async () => ({ member: { ...member, eventIds: null, version: 4 } }));
    TestBed.configureTestingModule({ providers: [TeamStore, { provide: ApiClient, useValue: { request } }] });
    await TestBed.inject(TeamStore).changeRole(member, ['auditor'], null);
    expect(request).toHaveBeenCalledWith('POST', '/organizations/current/members/person/role', expect.objectContaining({ expectedVersion: 3, eventIds: null }));
  });
});
