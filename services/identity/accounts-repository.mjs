import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../shared/http.mjs";

const encode = (key) => JSON.stringify([key.pk, key.sk]);
const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
const conflict = () =>
  new DomainError(
    409,
    "VERSION_CONFLICT",
    "El acceso o el plan cambió. Actualiza antes de continuar.",
  );

export class MemoryAccountsRepository {
  #items = new Map();
  constructor({ validateUsage } = {}) {
    this.validateUsage = validateUsage;
  }
  async seed(key, data) {
    this.#items.set(encode(key), { ...clone(key), data: clone(data) });
  }
  async getItem(key) {
    return clone(this.#items.get(encode(key))?.data);
  }
  async queryItems(pk, prefix) {
    return [...this.#items.values()]
      .filter((item) => item.pk === pk && item.sk.startsWith(prefix))
      .map(clone);
  }
  assertGuardsSync(actorOrGuards) {
    const guards = Array.isArray(actorOrGuards)
      ? actorOrGuards
      : actorOrGuards?.accessGuards;
    if (!Array.isArray(guards) || !guards.length)
      throw new DomainError(
        503,
        "ACCESS_GUARDS_REQUIRED",
        "No se pudo verificar el acceso actual.",
      );
    for (const guard of guards)
      if (
        !isDeepStrictEqual(
          this.#items.get(encode(guard.key))?.data ?? null,
          guard.data,
        )
      )
        throw new DomainError(
          409,
          "ACCESS_CHANGED",
          "Tu acceso cambió. Actualiza y vuelve a revisar.",
        );
    return true;
  }
  async transact({
    guards = [],
    puts = [],
    externalConditions = [],
    usageGuard,
  }) {
    if (
      (externalConditions.length || usageGuard) &&
      typeof this.validateUsage !== "function"
    )
      throw new DomainError(
        503,
        "USAGE_GUARDS_REQUIRED",
        "No se pudo comprobar el uso actual al confirmar el plan.",
      );
    if (usageGuard) {
      const outcome = this.validateUsage(usageGuard);
      if (outcome && typeof outcome.then === "function")
        throw new Error("The memory usage validator must be synchronous.");
    }
    for (const guard of guards)
      if (
        !isDeepStrictEqual(
          this.#items.get(encode(guard.key))?.data ?? null,
          guard.data,
        )
      )
        throw conflict();
    for (const put of puts)
      this.#items.set(encode(put.key), {
        ...clone(put.key),
        data: clone(put.data),
      });
  }
}

export class DynamoAccountsRepository {
  constructor({
    tableName = process.env.IDENTITY_TABLE,
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  } = {}) {
    if (!tableName) throw new Error("Identity table is required.");
    this.tableName = tableName;
    this.client = client;
  }
  async getItem(key) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item?.data;
  }
  async queryItems(pk, prefix) {
    const items = [];
    let cursor;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      items.push(...(response.Items ?? []));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async transact({
    guards = [],
    puts = [],
    externalConditions = [],
    usageGuard,
  }) {
    if (usageGuard && externalConditions.length !== 1)
      throw new DomainError(
        503,
        "USAGE_GUARDS_REQUIRED",
        "No se pudo comprobar el uso actual al confirmar el plan.",
      );
    const conditions = new Map();
    for (const guard of guards) {
      const id = encode(guard.key);
      if (
        conditions.has(id) &&
        !isDeepStrictEqual(conditions.get(id).data, guard.data)
      )
        throw conflict();
      conditions.set(id, guard);
    }
    const expression = (guard) =>
      guard.data === null
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : {
            ConditionExpression: "#data = :snapshot",
            ExpressionAttributeNames: { "#data": "data" },
            ExpressionAttributeValues: { ":snapshot": guard.data },
          };
    const TransactItems = puts.map((put) => {
      const id = encode(put.key);
      const guard = conditions.get(id);
      conditions.delete(id);
      return {
        Put: {
          TableName: this.tableName,
          Item: { ...put.key, data: put.data },
          ...(guard
            ? expression(guard)
            : { ConditionExpression: "attribute_not_exists(pk)" }),
        },
      };
    });
    for (const guard of conditions.values())
      TransactItems.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: guard.key,
          ...expression(guard),
        },
      });
    TransactItems.push(...externalConditions);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems }));
    } catch (error) {
      if (
        [
          "TransactionCanceledException",
          "ConditionalCheckFailedException",
        ].includes(error.name)
      )
        throw conflict();
      throw error;
    }
  }
}
