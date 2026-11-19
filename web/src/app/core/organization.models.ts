export type PlanCode = 'pilot' | 'event' | 'organizer' | 'team';
export type Role = 'operator' | 'importer' | 'confirmer' | 'auditor';
export type Capability = 'createEvent' | 'manageParticipants' | 'importPayments' | 'confirmPayments' | 'reversePayments' | 'closeEvent' | 'exportEvent' | 'manageTemplates' | 'viewOverview' | 'manageTeam';
export interface OrganizationMembership { organizationId: string; name?: string; isHome: boolean; isOwner: boolean; roles: string[]; status: string; }
export interface OrganizationAccess {
  organizationId: string;
  plan: { code: PlanCode; catalogVersion: string | number; assignmentVersion: number; status: string; source: 'default' | 'manual' };
  capabilities: Partial<Record<Capability, boolean>>;
  limits: { maxActiveEvents: number | null; maxSeats: number };
  usage: { activeSeats: number | null; seatBaselineVerified: boolean };
}
export interface MeResponse { homeOrganizationId: string; activeOrganizationId: string; organizations: OrganizationMembership[]; organization: OrganizationAccess; }
export interface TeamMember { memberId: string; organizationId: string; roles: string[]; eventIds: string[] | null; status: 'active' | 'revoked'; version: number; isOwner: boolean; }
export const planNames: Record<PlanCode, string> = { pilot: 'Piloto', event: 'Por Evento', organizer: 'Organizador', team: 'Equipo' };
export const roleNames: Record<string, string> = { admin: 'Propietario', operator: 'Operación', importer: 'Importación', confirmer: 'Confirmación', auditor: 'Consulta' };
