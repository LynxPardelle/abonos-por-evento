import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountsService,
  accountKeys,
  personalOrganizationId,
} from "./accounts.mjs";
import {
  MemoryAccountsRepository,
  DynamoAccountsRepository,
} from "./accounts-repository.mjs";
const httpModule = await import("./http.mjs").catch(() => ({}));
const resolverModule = await import("./resolver.mjs").catch(() => ({}));
const adminModule = await import("./admin.mjs").catch(() => ({}));
const runtimeModule = await import("./accounts-runtime.mjs").catch(() => ({}));
const pool = "us-east-1_Synthetic";
const subject = "11111111-1111-4111-8111-111111111111";
const org = personalOrganizationId(pool, subject);
const request = (method, path, body) => ({
  rawPath: path,
  requestContext: {
    http: { method },
    authorizer: {
      jwt: {
        claims: {
          sub: subject,
          token_use: "id",
          iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`,
        },
      },
    },
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("public account routes expose current context without a public grant-plan route", async () => {
  assert.equal(typeof httpModule.createAccountsHttpHandler, "function");
  const repository = new MemoryAccountsRepository();
  await repository.seed(accountKeys.legacy(pool, subject), {
    userPoolId: pool,
    userSub: subject,
    organizationId: org,
    roles: ["admin"],
    tier: "pilot",
    status: "active",
    source: "self-registration",
  });
  const service = createAccountsService({ repository });
  const handler = httpModule.createAccountsHttpHandler({
    service,
    userPoolId: pool,
  });
  const me = await handler(request("GET", "/api/v1/me"));
  assert.equal(me.statusCode, 200);
  assert.equal(JSON.parse(me.body).organization.plan.code, "pilot");
  assert.equal(me.headers["cache-control"], "no-store");
  const grant = await handler(
    request("POST", "/api/v1/organizations/current/plan", { code: "team" }),
  );
  assert.equal(grant.statusCode, 404);
  assert.equal(
    (await handler(request("GET", "/api/v1/organizations/current/members")))
      .statusCode,
    403,
  );
});

test("resolver and admin handlers reject HTTP envelopes and remain separated", async () => {
  assert.equal(typeof resolverModule.createResolverHandler, "function");
  assert.equal(typeof adminModule.createAdminHandler, "function");
  let writes = 0;
  let reads = 0;
  const service = {
    resolve: async (input) => {
      reads++;
      return { subject: input.subject };
    },
    admin: async () => {
      writes++;
      return { plan: { code: "team" } };
    },
  };
  const resolver = resolverModule.createResolverHandler({
    service,
    userPoolId: pool,
  });
  const admin = adminModule.createAdminHandler({ service, userPoolId: pool });
  assert.deepEqual(
    await resolver({
      internal: { action: "resolveAccess", userPoolId: pool, subject },
    }),
    { subject },
  );
  assert.equal(
    (
      await resolver({
        internal: { action: "grantPlan", userPoolId: pool, subject },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await admin({
        ...request("POST", "/api/v1/admin"),
        internal: { action: "grantPlan", userPoolId: pool, subject },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await resolver({
        ...request("GET", "/api/v1/me"),
        internal: { action: "resolveAccess", userPoolId: pool, subject },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await resolver({
        internal: {
          action: "resolveAccess",
          userPoolId: "us-east-1_Other",
          subject,
        },
      })
    ).statusCode,
    401,
  );
  assert.deepEqual(
    await admin({
      internal: { action: "grantPlan", userPoolId: pool, subject },
    }),
    { plan: { code: "team" } },
  );
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test("Dynamo repository keeps reads consistent and folds a plan guard into its write", async () => {
  const calls = [];
  const key = accountKeys.plan(org);
  const previous = { version: 1 };
  const client = {
    send: async (command) => {
      calls.push(command);
      return command.constructor.name === "GetCommand"
        ? { Item: { data: previous } }
        : { Items: [] };
    },
  };
  const repository = new DynamoAccountsRepository({
    tableName: "Identity",
    client,
  });
  assert.deepEqual(await repository.getItem(key), previous);
  await repository.queryItems(`ORG#${org}`, "MEMBER#");
  const external = {
    ConditionCheck: {
      TableName: "Events",
      Key: { pk: `ORG#${org}`, sk: "USAGE#EVENTS" },
      ConditionExpression: "#v = :v",
      ExpressionAttributeNames: { "#v": "version" },
      ExpressionAttributeValues: { ":v": 0 },
    },
  };
  await repository.transact({
    guards: [{ key, data: previous }],
    puts: [{ key, data: { version: 2 } }],
    externalConditions: [external],
  });
  assert.equal(calls[0].input.ConsistentRead, true);
  assert.equal(calls[1].input.ConsistentRead, true);
  const transaction = calls[2].input.TransactItems;
  assert.equal(transaction.length, 2);
  assert.equal(transaction[0].Put.ConditionExpression, "#data = :snapshot");
  assert.equal(transaction[0].Put.TableName, "Identity");
  assert.deepEqual(transaction[1], external);
  const rejected = new DynamoAccountsRepository({
    tableName: "Identity",
    client: {
      send: async () => {
        throw Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
        });
      },
    },
  });
  await assert.rejects(rejected.transact({ puts: [{ key, data: previous }] }), {
    code: "VERSION_CONFLICT",
  });
});

test("event usage RPC returns an exact missing-counter or version/count condition without writes", async () => {
  assert.equal(typeof runtimeModule.createEventUsageReader, "function");
  const calls = [];
  let reply = { version: null, nonArchivedEvents: 2 };
  const reader = runtimeModule.createEventUsageReader({
    functionName: "EventsFunction",
    eventsTable: "Events",
    client: {
      send: async (command) => {
        calls.push(command.input);
        return { Payload: Buffer.from(JSON.stringify(reply)) };
      },
    },
  });
  const missing = await reader(org);
  assert.equal(missing.nonArchivedCount, 2);
  assert.equal(
    missing.condition.ConditionCheck.ConditionExpression,
    "attribute_not_exists(pk)",
  );
  reply = { version: 5, nonArchivedEvents: 3 };
  const existing = await reader(org);
  assert.deepEqual(
    existing.condition.ConditionCheck.ExpressionAttributeValues,
    { ":version": 5, ":count": 3 },
  );
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].Payload).toString()), {
    internal: { action: "getUsage", organizationId: org },
  });
  assert.ok(calls.every((call) => call.FunctionName === "EventsFunction"));
});

test("memory adapter exposes a synchronous access guard check for atomic domain fixtures", async () => {
  const repository = new MemoryAccountsRepository();
  const key = accountKeys.plan(org);
  assert.equal(typeof repository.assertGuardsSync, "function");
  await repository.seed(key, { version: 1 });
  assert.equal(
    repository.assertGuardsSync([{ key, data: { version: 1 } }]),
    true,
  );
  assert.throws(
    () => repository.assertGuardsSync([{ key, data: { version: 0 } }]),
    { code: "ACCESS_CHANGED" },
  );
});
