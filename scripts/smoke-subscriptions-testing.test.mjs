import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityService } from "../services/identity/service.mjs";
import { createPreTokenHandler } from "../services/identity/pre-token.mjs";
import {
  createAccountsService,
  accountKeys,
} from "../services/identity/accounts.mjs";
import { MemoryAccountsRepository } from "../services/identity/accounts-repository.mjs";
import { createAccountsHttpHandler } from "../services/identity/http.mjs";
import { createAdminHandler } from "../services/identity/admin.mjs";
import { createAccessResolver } from "../services/shared/access.mjs";
import { DomainError } from "../services/shared/http.mjs";
import { MemoryEventsRepository } from "../services/events/repository.mjs";
import { createEventsHandler } from "../services/events/index.mjs";
import { MemoryReconciliationRepository } from "../services/reconciliation/repository.mjs";
import { createReconciliationService } from "../services/reconciliation/application.mjs";
import { createReconciliationHandler } from "../services/reconciliation/index.mjs";
const smoke = await import("./smoke-subscriptions-testing.mjs").catch(
  () => ({}),
);
const origin = "https://saldoevento-test.lynxpardelle.com";
const pool = "us-east-1_Subscriptions";
const stack = () => ({
  StackName: "saldoevento-test",
  StackId:
    "arn:aws:cloudformation:us-east-1:765932874577:stack/saldoevento-test/11111111-1111-4111-8111-111111111111",
  StackStatus: "UPDATE_COMPLETE",
  Parameters: [
    { ParameterKey: "Stage", ParameterValue: "test" },
    { ParameterKey: "PublicOrigin", ParameterValue: origin },
    { ParameterKey: "SelfRegistrationEnabled", ParameterValue: "true" },
  ],
  Outputs: [
    { OutputKey: "UserPoolId", OutputValue: pool },
    { OutputKey: "UserPoolClientId", OutputValue: "testclient" },
    {
      OutputKey: "ProductDomain",
      OutputValue: "saldoevento-test.lynxpardelle.com",
    },
    {
      OutputKey: "IdentityAdminFunctionName",
      OutputValue: "saldoevento-test-identity-admin",
    },
    {
      OutputKey: "CognitoDomain",
      OutputValue:
        "https://saldoevento-test-765932874577.auth.us-east-1.amazoncognito.com",
    },
  ],
});

test("subscriptions smoke rejects production, account, origin and admin target before any mutation", async () => {
  assert.equal(typeof smoke.runSubscriptionsSmoke, "function");
  assert.equal(smoke.parseSubscriptionArgs([]).stack, "saldoevento-test");
  assert.throws(() =>
    smoke.parseSubscriptionArgs(["--stack", "saldoevento-prod"]),
  );
  assert.throws(() => smoke.parseSubscriptionArgs(["--region", "eu-west-1"]));
  let mutations = 0;
  const base = {
    stackName: "saldoevento-test",
    stackDescription: stack(),
    accountId: "765932874577",
    cognito: {
      createUser: async () => {
        mutations++;
      },
    },
    admin: {
      invoke: async () => {
        mutations++;
      },
    },
  };
  for (const override of [
    { stackName: "saldoevento-prod" },
    { accountId: "000000000000" },
    {
      stackDescription: {
        ...stack(),
        Parameters: stack().Parameters.map((item) =>
          item.ParameterKey === "PublicOrigin"
            ? { ...item, ParameterValue: "https://foreign.invalid" }
            : item,
        ),
      },
    },
    {
      stackDescription: {
        ...stack(),
        Outputs: stack().Outputs.map((item) =>
          item.OutputKey === "IdentityAdminFunctionName"
            ? { ...item, OutputValue: "saldoevento-prod-identity-admin" }
            : item,
        ),
      },
    },
  ])
    await assert.rejects(smoke.runSubscriptionsSmoke({ ...base, ...override }));
  assert.equal(mutations, 0);
});

function syntheticEnvironment({
  failSecondUser = false,
  failHttp = false,
  cleanupFails = false,
} = {}) {
  let events;
  const identity = new MemoryAccountsRepository({
    validateUsage: (guard) => events.assertUsageGuardSync(guard),
  });
  events = new MemoryEventsRepository({
    validateAccess: (actor) => identity.assertGuardsSync(actor),
  });
  const accounts = createAccountsService({
    repository: identity,
    usageReader: async (organizationId) =>
      events.getUsageSync({ organizationId }),
    userPoolId: pool,
  });
  const accessResolver = createAccessResolver({
    identityReader: accounts,
    userPoolId: pool,
  });
  const eventsHandler = createEventsHandler({
    repository: events,
    accessResolver,
  });
  const accountHandler = createAccountsHttpHandler({
    service: accounts,
    userPoolId: pool,
  });
  const adminHandler = createAdminHandler({
    service: accounts,
    userPoolId: pool,
  });
  const invokeEvents = async (internal) => {
    const result = await eventsHandler({ internal });
    if (result.statusCode) {
      const error = JSON.parse(result.body).error;
      throw new DomainError(result.statusCode, error.code, error.message);
    }
    return result;
  };
  const repository = new MemoryReconciliationRepository({
    validateAccess: (actor) => identity.assertGuardsSync(actor),
  });
  const service = createReconciliationService({
    repository,
    eventReader: (scope) => invokeEvents({ action: "getEvent", ...scope }),
    eventCommand: (action, scope, input, actor) =>
      invokeEvents({ action, ...scope, ...input, actor }),
    eventLister: (actor) =>
      invokeEvents({
        action: "listEventsforOverview",
        organizationId: actor.organizationId,
        actor,
      }),
    uploadSigner: async () => ({}),
  });
  const reconciliationHandler = createReconciliationHandler({
    service,
    accessResolver,
  });
  const provision = createIdentityService({
    selfRegistrationEnabled: true,
    repository: {
      get: (scope) =>
        identity.getItem(accountKeys.legacy(scope.userPoolId, scope.userSub)),
      createIfAbsent: async (member) => {
        const key = accountKeys.legacy(member.userPoolId, member.userSub);
        const existing = await identity.getItem(key);
        if (existing) return existing;
        await identity.seed(key, member);
        return member;
      },
    },
  });
  const preToken = createPreTokenHandler({ service: provision });
  const created = [];
  const deleted = [];
  const secrets = [];
  const tokens = new Map();
  const users = new Map();
  const paths = [];
  const iamActions = [];
  const cognito = {
    createUser: async (input) => {
      created.push(input);
      assert.equal(input.organizationId, undefined);
      assert.equal(input.roles, undefined);
      if (failSecondUser && created.length === 2)
        throw new Error("private-provider-diagnostic");
      users.set(input.username, {
        subject: `${String(created.length).repeat(8)}-${String(created.length).repeat(4)}-4${String(created.length).repeat(3)}-8${String(created.length).repeat(3)}-${String(created.length).repeat(12)}`,
      });
    },
    setPassword: async ({ password }) => {
      secrets.push(password);
    },
    authenticate: async ({ username, userPoolId }) => {
      const subject = users.get(username).subject;
      const event = await preToken({
        version: "1",
        triggerSource: "TokenGeneration_Authentication",
        userPoolId,
        request: {
          userAttributes: {
            sub: subject,
            email: username,
            email_verified: "true",
          },
        },
        response: {},
      });
      const claims = {
        sub: subject,
        iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`,
        aud: "testclient",
        token_use: "id",
        ...event.response.claimsOverrideDetails.claimsToAddOrOverride,
      };
      const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.private-signature`;
      tokens.set(token, claims);
      secrets.push(token);
      return token;
    },
    deleteUser: async ({ username }) => {
      deleted.push(username);
      if (cleanupFails) throw new Error("private-cleanup-diagnostic");
    },
  };
  const admin = {
    invoke: async (input) => {
      iamActions.push(input.action);
      return adminHandler({ internal: input });
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    paths.push(`${options.method} ${new URL(url).pathname}`);
    if (failHttp)
      throw new Error("private transport diagnostic signed-url token");
    const token = options.headers.Authorization?.replace(/^Bearer /, "");
    const claims = tokens.get(token);
    const event = {
      rawPath: new URL(url).pathname,
      headers: options.headers,
      requestContext: {
        http: { method: options.method },
        authorizer: { jwt: { claims } },
      },
      ...(options.body ? { body: options.body } : {}),
    };
    const path = event.rawPath;
    const handler =
      path === "/api/v1/me" || path.startsWith("/api/v1/organizations/")
        ? accountHandler
        : path === "/api/v1/events" ||
            /^\/api\/v1\/events\/[^/]+(?:\/participants)?$/.test(path) ||
            path.startsWith("/api/v1/templates")
          ? eventsHandler
          : reconciliationHandler;
    const result = await handler(event);
    return new Response(result.body, {
      status: result.statusCode,
      headers: result.headers,
    });
  };
  return {
    cognito,
    admin,
    fetchImpl,
    created,
    deleted,
    secrets,
    paths,
    iamActions,
    identity,
    events,
    tokens,
  };
}

test("real in-memory services pass the testing tier workflow with the same JWT and a sanitized report", async () => {
  assert.equal(typeof smoke.runSubscriptionsSmoke, "function");
  const environment = syntheticEnvironment();
  const report = await smoke.runSubscriptionsSmoke({
    stackName: "saldoevento-test",
    stackDescription: stack(),
    accountId: "765932874577",
    ...environment,
  });
  assert.equal(report.status, "passed", JSON.stringify(report.checks));
  assert.equal(environment.created.length, 2);
  assert.equal(environment.deleted.length, 2);
  assert.equal(report.cleanup.failures, 0);
  for (const group of [
    "self_service_pilot",
    "event_quota_and_lifecycle",
    "organizer_templates_and_quota",
    "team_current_roles_and_revocation",
    "downgrade_preserves_history",
  ])
    assert.ok(
      report.checks.some(
        (check) => check.name === group && check.status === "passed",
      ),
    );
  assert.ok(
    environment.paths.some((path) =>
      /^GET \/api\/v1\/events\/[^/]+$/.test(path),
    ),
    "Verify the deployed single-event route used by the closing UI",
  );
  assert.equal(
    environment.iamActions.filter((action) => action === "grantMember").length,
    1,
  );
  const serialized = JSON.stringify(report);
  for (const secret of [
    ...environment.secrets,
    ...environment.created.map((user) => user.username),
    ...environment.tokens.values(),
  ].flatMap((value) =>
    typeof value === "string"
      ? [value]
      : [value.sub, value["custom:organizationId"]],
  ))
    assert.equal(
      serialized.includes(secret),
      false,
      "Report must not contain private identifiers or credentials",
    );
  assert.doesNotMatch(
    serialized,
    /private-signature|private-provider|signed-url/,
  );
});

test("provisioning or HTTP failure cleans up every attempted account without leaking diagnostics", async () => {
  assert.equal(typeof smoke.runSubscriptionsSmoke, "function");
  for (const failure of [{ failSecondUser: true }, { failHttp: true }]) {
    const environment = syntheticEnvironment(failure);
    const report = await smoke.runSubscriptionsSmoke({
      stackName: "saldoevento-test",
      stackDescription: stack(),
      accountId: "765932874577",
      ...environment,
    });
    assert.equal(report.status, "failed");
    assert.equal(environment.deleted.length, 2);
    assert.doesNotMatch(
      JSON.stringify(report),
      /private|diagnostic|signed-url/,
    );
  }
});

test("cleanup failure makes an otherwise successful tier smoke fail", async () => {
  assert.equal(typeof smoke.runSubscriptionsSmoke, "function");
  const environment = syntheticEnvironment({ cleanupFails: true });
  const report = await smoke.runSubscriptionsSmoke({
    stackName: "saldoevento-test",
    stackDescription: stack(),
    accountId: "765932874577",
    ...environment,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup.failures, 2);
  assert.ok(
    report.checks.some((check) => check.code === "COGNITO_CLEANUP_FAILED"),
  );
  assert.doesNotMatch(JSON.stringify(report), /private-cleanup/);
});

test("testing IAM adapter invokes only its allowlisted writer and rejects another pool", async () => {
  assert.equal(typeof smoke.createTestingAdminAdapter, "function");
  const calls = [];
  const commands = {
    InvokeCommand: class {
      constructor(input) {
        this.input = input;
      }
    },
  };
  const client = {
    send: async (command) => {
      calls.push(command.input);
      return {
        Payload: Buffer.from(
          '{"plan":{"code":"event","billingEnabled":false}}',
        ),
      };
    },
  };
  await assert.rejects(
    smoke.createTestingAdminAdapter({
      functionName: "saldoevento-prod-identity-admin",
      userPoolId: pool,
      client,
      commands,
    }),
  );
  assert.equal(calls.length, 0);
  const adapter = await smoke.createTestingAdminAdapter({
    functionName: "saldoevento-test-identity-admin",
    userPoolId: pool,
    client,
    commands,
  });
  await assert.rejects(
    adapter.invoke({ action: "grantPlan", userPoolId: "us-east-1_Foreign" }),
  );
  assert.equal(calls.length, 0);
  const input = { action: "grantPlan", userPoolId: pool, code: "event" };
  assert.equal((await adapter.invoke(input)).plan.code, "event");
  assert.equal(calls[0].FunctionName, "saldoevento-test-identity-admin");
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].Payload).toString("utf8")), {
    internal: input,
  });
});
