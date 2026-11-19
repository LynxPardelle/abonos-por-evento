import { createAccessResolver } from "../shared/access.mjs";
import {
  DomainError,
  handleError,
  json,
  parseBody,
  requestPath,
} from "../shared/http.mjs";
import { createAccountsService } from "./accounts.mjs";
import { DynamoAccountsRepository } from "./accounts-repository.mjs";

export function createAccountsHttpHandler({ service, userPoolId }) {
  const resolve = createAccessResolver({ identityReader: service, userPoolId });
  return async (event) => {
    try {
      const path = requestPath(event);
      const method = event?.requestContext?.http?.method;
      if (path === "/api/v1/me" && method === "GET") {
        const actor = await resolve(event);
        return json(
          200,
          await service.me({
            userPoolId: actor.userPoolId,
            subject: actor.subject,
            organizationHint: actor.organizationId,
          }),
        );
      }
      if (path === "/api/v1/organizations/current/members" && method === "GET")
        return json(
          200,
          await service.members(
            await resolve(event, [], { capability: "manageTeam" }),
          ),
        );
      const match =
        /^\/api\/v1\/organizations\/current\/members\/([^/]+)\/(role|revoke)$/.exec(
          path,
        );
      if (match && method === "POST") {
        const actor = await resolve(event, [], { capability: "manageTeam" });
        const body = parseBody(event);
        return json(
          200,
          await (match[2] === "role"
            ? service.updateMember(actor, match[1], body)
            : service.revokeMember(actor, match[1], body)),
        );
      }
      throw new DomainError(404, "ROUTE_NOT_FOUND", "No se encontró la ruta.");
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
    runtime ??= createAccountsHttpHandler({
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
