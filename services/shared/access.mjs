import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { isDeepStrictEqual } from "node:util";
import { DomainError, validateId } from "./http.mjs";
import { hasRole } from "./plans.mjs";

function identityInput(request, configuredPool) {
  const claims = request?.requestContext?.authorizer?.jwt?.claims;
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(claims.sub) ||
    (claims.token_use !== undefined && claims.token_use !== "id")
  )
    throw new DomainError(
      401,
      "UNAUTHENTICATED",
      "Inicia sesión para continuar.",
    );
  const issuer =
    /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)$/.exec(
      claims.iss ?? "",
    );
  if (!issuer || (configuredPool && issuer[2] !== configuredPool))
    throw new DomainError(
      401,
      "UNAUTHENTICATED",
      "La sesión pertenece a otro ambiente.",
    );
  const headers = Object.entries(request.headers ?? {}).filter(
    ([name]) => name.toLowerCase() === "x-saldoevento-organization",
  );
  if (headers.length > 1 || (headers[0] && typeof headers[0][1] !== "string"))
    throw new DomainError(
      400,
      "INVALID_ORGANIZATION",
      "Selecciona una sola organización.",
    );
  const organizationHint = headers[0]?.[1];
  if (organizationHint) validateId(organizationHint, "organizationId");
  return {
    userPoolId: issuer[2],
    subject: claims.sub,
    ...(organizationHint ? { organizationHint } : {}),
  };
}

export function assertActorAccess(
  actor,
  requiredRoles = [],
  { eventId, capability } = {},
) {
  if (
    !actor ||
    !Array.isArray(actor.roles) ||
    !hasRole(actor.roles, requiredRoles)
  )
    throw new DomainError(
      403,
      "FORBIDDEN",
      "Tu rol no permite realizar esta operación.",
    );
  if (
    eventId &&
    Array.isArray(actor.eventIds) &&
    !actor.eventIds.includes(eventId)
  )
    throw new DomainError(404, "EVENT_NOT_FOUND", "No se encontró el evento.");
  if (capability && actor.capabilities?.[capability] !== true)
    throw new DomainError(
      403,
      "PLAN_CAPABILITY_REQUIRED",
      "Tu acceso actual no permite esta función.",
    );
  return actor;
}

export function createAccessResolver({ identityReader, userPoolId } = {}) {
  if (!identityReader) throw new Error("Identity reader is required.");
  return async (request, requiredRoles = [], options = {}) => {
    const input = {
      ...identityInput(request, userPoolId),
      ...(options.eventId ? { eventId: options.eventId } : {}),
    };
    const actor =
      typeof identityReader === "function"
        ? await identityReader(input)
        : await identityReader.resolve(input);
    if (
      !actor ||
      actor.subject !== input.subject ||
      actor.userPoolId !== input.userPoolId ||
      !Array.isArray(actor.accessGuards) ||
      actor.accessGuards.length < 2
    )
      throw new DomainError(
        503,
        "IDENTITY_RESPONSE_INVALID",
        "No se pudo comprobar la identidad actual.",
      );
    validateId(actor.organizationId, "organizationId");
    return assertActorAccess(actor, requiredRoles, options);
  };
}

export function buildAccessConditions(
  actor,
  { tableName = process.env.IDENTITY_TABLE } = {},
) {
  if (
    !tableName ||
    !Array.isArray(actor?.accessGuards) ||
    actor.accessGuards.length < 2
  )
    throw new DomainError(
      503,
      "ACCESS_GUARDS_REQUIRED",
      "No se pudo verificar el acceso actual.",
    );
  const seen = new Set();
  return actor.accessGuards.map((guard) => {
    const encoded = JSON.stringify(guard.key);
    if (
      !guard.key?.pk ||
      !guard.key?.sk ||
      seen.has(encoded) ||
      guard.data === undefined
    )
      throw new DomainError(
        503,
        "ACCESS_GUARDS_REQUIRED",
        "No se pudo verificar el acceso actual.",
      );
    seen.add(encoded);
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: structuredClone(guard.key),
        ...(guard.data === null
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: "#data = :snapshot",
              ExpressionAttributeNames: { "#data": "data" },
              ExpressionAttributeValues: {
                ":snapshot": structuredClone(guard.data),
              },
            }),
      },
    };
  });
}

export async function validateMemoryAccess(actor, identityReader) {
  if (!Array.isArray(actor?.accessGuards) || actor.accessGuards.length < 2)
    throw new DomainError(
      503,
      "ACCESS_GUARDS_REQUIRED",
      "No se pudo verificar el acceso actual.",
    );
  for (const guard of actor.accessGuards) {
    const current =
      typeof identityReader === "function"
        ? await identityReader(guard.key)
        : await identityReader.getItem(guard.key);
    if (!isDeepStrictEqual(current ?? null, guard.data))
      throw new DomainError(
        409,
        "ACCESS_CHANGED",
        "Tu acceso cambió. Actualiza y vuelve a revisar.",
      );
  }
  return true;
}

let runtime;
export async function resolveAccess(request, requiredRoles = [], options = {}) {
  if (!process.env.IDENTITY_RESOLVER_FUNCTION_NAME || !process.env.USER_POOL_ID)
    throw new DomainError(
      503,
      "IDENTITY_UNAVAILABLE",
      "El servicio de acceso no está disponible.",
    );
  runtime ??= createAccessResolver({
    userPoolId: process.env.USER_POOL_ID,
    identityReader: async (input) => {
      try {
        const response = await new LambdaClient({}).send(
          new InvokeCommand({
            FunctionName: process.env.IDENTITY_RESOLVER_FUNCTION_NAME,
            Payload: Buffer.from(
              JSON.stringify({
                internal: { action: "resolveAccess", ...input },
              }),
            ),
          }),
        );
        if (response.FunctionError) throw new Error("invoke");
        const result = JSON.parse(
          Buffer.from(response.Payload).toString("utf8"),
        );
        if (result.statusCode) {
          const error = JSON.parse(result.body ?? "{}").error;
          if (
            [400, 401, 403, 404, 409].includes(result.statusCode) &&
            typeof error?.code === "string"
          )
            throw new DomainError(result.statusCode, error.code, error.message);
          throw new Error("response");
        }
        return result;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(
          503,
          "IDENTITY_UNAVAILABLE",
          "El servicio de acceso no está disponible.",
        );
      }
    },
  });
  return runtime(request, requiredRoles, options);
}
