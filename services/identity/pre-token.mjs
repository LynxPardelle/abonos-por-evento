import { createIdentityService, requireTrigger } from './service.mjs';
import { DynamoIdentityRepository } from './repository.mjs';

export function createPreTokenHandler({ service }) {
  return async event => {
    requireTrigger(event, ['TokenGeneration_HostedAuth', 'TokenGeneration_Authentication', 'TokenGeneration_NewPasswordChallenge', 'TokenGeneration_AuthenticateDevice', 'TokenGeneration_RefreshTokens']);
    const membership = await service.ensureMembership(event);
    const previous = event.response?.claimsOverrideDetails ?? {};
    event.response = {
      ...event.response,
      claimsOverrideDetails: {
        ...previous,
        claimsToAddOrOverride: {
          ...previous.claimsToAddOrOverride,
          'custom:organizationId': membership.organizationId,
          'custom:roles': membership.roles.join(','),
          'custom:tier': membership.tier,
        },
        // Authorization claims must survive even if another response field tried to suppress them.
        ...(previous.claimsToSuppress ? { claimsToSuppress: previous.claimsToSuppress.filter(claim => !['custom:organizationId', 'custom:roles', 'custom:tier'].includes(claim)) } : {}),
      },
    };
    return event;
  };
}
let defaultHandler;
export async function handler(event) {
  defaultHandler ??= createPreTokenHandler({ service: createIdentityService({ repository: new DynamoIdentityRepository(), selfRegistrationEnabled: process.env.SELF_REGISTRATION_ENABLED === 'true' }) });
  return defaultHandler(event);
}
