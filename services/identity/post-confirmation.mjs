import { createIdentityService, requireTrigger } from './service.mjs';
import { DynamoIdentityRepository } from './repository.mjs';

export function createPostConfirmationHandler({ service }) {
  return async event => {
    requireTrigger(event, ['PostConfirmation_ConfirmSignUp', 'PostConfirmation_ConfirmForgotPassword']);
    await service.ensureMembership(event);
    return event;
  };
}
let defaultHandler;
export async function handler(event) {
  defaultHandler ??= createPostConfirmationHandler({ service: createIdentityService({ repository: new DynamoIdentityRepository(), selfRegistrationEnabled: process.env.SELF_REGISTRATION_ENABLED === 'true' }) });
  return defaultHandler(event);
}
