import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DomainError, validateId } from "../shared/http.mjs";

export function createEventUsageReader({
  functionName = process.env.EVENTS_FUNCTION_NAME,
  eventsTable = process.env.EVENTS_TABLE,
  client = new LambdaClient({}),
} = {}) {
  if (!functionName || !eventsTable)
    throw new Error(
      "Events function and table are required for a guarded plan grant.",
    );
  return async (organizationId) => {
    validateId(organizationId, "organizationId");
    try {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          Payload: Buffer.from(
            JSON.stringify({
              internal: { action: "getUsage", organizationId },
            }),
          ),
        }),
      );
      if (response.FunctionError) throw new Error("invoke");
      const usage = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
      if (
        usage.statusCode ||
        !Number.isSafeInteger(usage.nonArchivedEvents) ||
        usage.nonArchivedEvents < 0 ||
        (usage.version !== null &&
          (!Number.isSafeInteger(usage.version) || usage.version < 0))
      )
        throw new Error("invalid-usage");
      const condition = {
        ConditionCheck: {
          TableName: eventsTable,
          Key: { pk: `ORG#${organizationId}`, sk: "USAGE#EVENTS" },
          ...(usage.version === null
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : {
                ConditionExpression: "#version = :version AND #count = :count",
                ExpressionAttributeNames: {
                  "#version": "version",
                  "#count": "nonArchivedCount",
                },
                ExpressionAttributeValues: {
                  ":version": usage.version,
                  ":count": usage.nonArchivedEvents,
                },
              }),
        },
      };
      return {
        version: usage.version,
        nonArchivedCount: usage.nonArchivedEvents,
        condition,
      };
    } catch {
      throw new DomainError(
        503,
        "USAGE_UNAVAILABLE",
        "No se pudo comprobar el uso actual de eventos.",
      );
    }
  };
}

export function internalCommand(event, allowedActions, userPoolId) {
  if (
    !event ||
    event.requestContext !== undefined ||
    event.rawPath !== undefined ||
    event.body !== undefined ||
    event.headers !== undefined ||
    Object.keys(event).some((key) => key !== "internal") ||
    !event.internal ||
    typeof event.internal !== "object" ||
    Array.isArray(event.internal) ||
    !allowedActions.includes(event.internal.action)
  )
    throw new DomainError(
      400,
      "INVALID_INTERNAL_REQUEST",
      "La solicitud interna no es válida.",
    );
  if (!userPoolId || event.internal.userPoolId !== userPoolId)
    throw new DomainError(
      401,
      "UNAUTHENTICATED",
      "La identidad pertenece a otro ambiente.",
    );
  return event.internal;
}
