import { DomainError, validateId } from './http.mjs';

const knownRoles = new Set(['admin', 'operator', 'importer', 'confirmer', 'auditor']);

function rolesFromClaim(value) {
  if (typeof value !== 'string' || value.length > 200) return [];
  try {
    const parsed = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',').map((role) => role.trim());
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((role) => !knownRoles.has(role))) return [];
    return [...new Set(parsed)];
  } catch {
    return [];
  }
}

export function authorize(event, requiredRolesArray = []) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  if (!claims || typeof claims.sub !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:@.-]{0,127}$/.test(claims.sub)) {
    throw new DomainError(401, 'UNAUTHENTICATED', 'Inicia sesión para continuar.');
  }
  if (claims.token_use !== undefined && claims.token_use !== 'id') {
    throw new DomainError(401, 'UNAUTHENTICATED', 'Usa el ID token de la sesión para continuar.');
  }
  let organizationId;
  try {
    organizationId = validateId(claims['custom:organizationId'], 'organizationId');
  } catch {
    throw new DomainError(401, 'UNAUTHENTICATED', 'La sesión no tiene una organización válida.');
  }
  const roles = rolesFromClaim(claims['custom:roles']);
  if (roles.length === 0) throw new DomainError(401, 'UNAUTHENTICATED', 'La sesión no tiene roles válidos.');
  const effectiveRoles = new Set(roles);
  if (roles.includes('operator')) ['importer', 'confirmer', 'auditor'].forEach((role) => effectiveRoles.add(role));
  if (roles.includes('importer') || roles.includes('confirmer')) effectiveRoles.add('auditor');
  if (requiredRolesArray.length && !roles.includes('admin') && !requiredRolesArray.some((role) => effectiveRoles.has(role))) {
    throw new DomainError(403, 'FORBIDDEN', 'Tu rol no permite realizar esta operación.');
  }
  return { subject: claims.sub, organizationId, roles };
}
