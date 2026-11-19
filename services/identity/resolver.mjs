import { DomainError, handleError } from "../shared/http.mjs";
import { assertActorAccess } from "../shared/access.mjs";
import { createAccountsService } from "./accounts.mjs";
import { DynamoAccountsRepository } from "./accounts-repository.mjs";
import { internalCommand } from "./accounts-runtime.mjs";

export function createResolverHandler({ service, userPoolId }) {
  return async (event) => {
    try {
      const input = internalCommand(event, ["resolveAccess"], userPoolId);
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "action",
              "userPoolId",
              "subject",
              "organizationHint",
              "eventId",
              "requiredRoles",
              "capability",
            ].includes(key),
        )
      )
        throw new DomainError(
          400,
          "INVALID_INTERNAL_REQUEST",
          "La solicitud interna contiene campos no admitidos.",
        );
      const actor = await service.resolve(input);
      return input.requiredRoles || input.capability
        ? assertActorAccess(actor, input.requiredRoles ?? [], {
            eventId: input.eventId,
            capability: input.capability,
          })
        : actor;
    } catch (error) {
      return handleError(error);
    }
  };
}
let runtime;
export async function handler(event) {
  try {
    if (!process.env.USER_POOL_ID)
      throw new DomainError(
        503,
        "IDENTITY_UNAVAILABLE",
        "El servicio de acceso no está disponible.",
      );
    runtime ??= createResolverHandler({
      service: createAccountsService({
        repository: new DynamoAccountsRepository(),
        userPoolId: process.env.USER_POOL_ID,
      }),
      userPoolId: process.env.USER_POOL_ID,
    });
    return runtime(event);
  } catch (error) {
    return handleError(error);
  }
}
