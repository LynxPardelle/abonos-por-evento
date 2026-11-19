import { createHash } from 'node:crypto';

const knownRoles = new Set(['admin', 'operator', 'importer', 'confirmer', 'auditor']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
class IdentityError extends Error {
  constructor(code) { super('No se pudo preparar tu espacio. Vuelve a iniciar sesión.'); this.code = code; }
}
const fail = code => { throw new IdentityError(code); };

function rolesFromAttribute(value) {
  if (typeof value !== 'string' || value.length > 200) fail('INVALID_ADMIN_MEMBERSHIP');
  let roles;
  try { roles = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',').map(role => role.trim()); }
  catch { fail('INVALID_ADMIN_MEMBERSHIP'); }
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(role => !knownRoles.has(role))) fail('INVALID_ADMIN_MEMBERSHIP');
  return [...new Set(roles)];
}

function scopeFromEvent(event) {
  const userPoolId = event?.userPoolId;
  const userSub = event?.request?.userAttributes?.sub;
  if (typeof userPoolId !== 'string' || !/^[a-z]{2}-[a-z0-9-]+-\d_[A-Za-z0-9]{1,64}$/.test(userPoolId) || typeof userSub !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(userSub)) fail('INVALID_IDENTITY');
  return { userPoolId, userSub };
}

function validateMembership(membership, scope) {
  if (!membership || membership.userPoolId !== scope.userPoolId || membership.userSub !== scope.userSub || !validId(membership.organizationId) || !Array.isArray(membership.roles) || membership.roles.length === 0 || membership.roles.some(role => !knownRoles.has(role)) || membership.tier !== 'pilot') fail('INVALID_MEMBERSHIP');
  if (membership.status !== 'active') fail('MEMBERSHIP_DISABLED');
  return membership;
}

export function createIdentityService({ repository, selfRegistrationEnabled = false, now = () => new Date().toISOString() }) {
  if (!repository) throw new Error('Identity repository is required.');
  return {
    async ensureMembership(event) {
      const scope = scopeFromEvent(event);
      const attributes = event.request.userAttributes;
      if (attributes.email_verified !== 'true' && attributes.email_verified !== true) fail('EMAIL_NOT_VERIFIED');
      const existing = await repository.get(scope);
      if (existing) return validateMembership(existing, scope);

      let organizationId; let roles; let source;
      // Only administration can write these attributes: the app client never has
      // write permissions for custom attributes. ClientMetadata is deliberately ignored.
      const hasLegacyOrganization = attributes['custom:organizationId'] !== undefined;
      const hasLegacyRoles = attributes['custom:roles'] !== undefined;
      if (hasLegacyOrganization || hasLegacyRoles) {
        organizationId = attributes['custom:organizationId'];
        if (!validId(organizationId) || !hasLegacyRoles) fail('INVALID_ADMIN_MEMBERSHIP');
        roles = rolesFromAttribute(attributes['custom:roles']); source = 'administrative';
      } else {
        if (!selfRegistrationEnabled) fail('REGISTRATION_CLOSED');
        organizationId = `org-${createHash('sha256').update(JSON.stringify([scope.userPoolId, scope.userSub])).digest('hex').slice(0, 32)}`;
        roles = ['admin']; source = 'self-registration';
      }
      const created = await repository.createIfAbsent({ ...scope, organizationId, roles, tier: 'pilot', status: 'active', source, createdAt: now(), schemaVersion: 1 });
      return validateMembership(created, scope);
    },
  };
}

export function requireTrigger(event, allowedSources) {
  if (String(event?.version) !== '1' || !allowedSources.includes(event?.triggerSource)) fail('INVALID_TRIGGER');
}
