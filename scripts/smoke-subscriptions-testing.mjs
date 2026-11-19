// Testing-only acceptance smoke. Creates two SUPPRESS accounts, grants evaluation
// plans through IAM, and keeps synthetic history for audit. Finally removes every
// attempted Cognito user, including a create call that may have timed out.
// Usage: node scripts/smoke-subscriptions-testing.mjs --stack saldoevento-test
// Never run before the testing stack UPDATE_COMPLETE and asset sync finish.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCognitoAdapter, describeStack } from "./smoke-cloud.mjs";

const STACK = "saldoevento-test";
const REGION = "us-east-1";
const ACCOUNT = "765932874577";
const ORIGIN = "https://saldoevento-test.lynxpardelle.com";
const ADMIN = "saldoevento-test-identity-admin";
const root = fileURLToPath(new URL("../", import.meta.url));
class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const check = (ok, code) => {
  if (!ok) throw new SmokeFailure(code);
};
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);

export function parseSubscriptionArgs(argv) {
  const result = { stack: STACK, region: REGION };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    check(
      ["--stack", "--region"].includes(key) &&
        !seen.has(key) &&
        typeof value === "string" &&
        !value.startsWith("--"),
      "INVALID_ARGUMENTS",
    );
    seen.add(key);
    result[key.slice(2)] = value;
  }
  check(
    result.stack === STACK && result.region === REGION,
    "TESTING_TARGET_REQUIRED",
  );
  return result;
}

export function validateTestingTarget(
  stackName,
  stack,
  accountId,
  region = REGION,
) {
  check(
    stackName === STACK &&
      stack?.StackName === STACK &&
      accountId === ACCOUNT &&
      region === REGION,
    "TESTING_ACCOUNT_REQUIRED",
  );
  check(
    /^arn:aws:cloudformation:us-east-1:765932874577:stack\/saldoevento-test\/[a-f0-9-]+$/.test(
      stack.StackId ?? "",
    ),
    "TESTING_STACK_ARN_REQUIRED",
  );
  check(
    ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus),
    "TESTING_STACK_NOT_READY",
  );
  const parameters = Object.fromEntries(
    (stack.Parameters ?? []).map((item) => [
      item.ParameterKey,
      item.ParameterValue,
    ]),
  );
  const outputs = Object.fromEntries(
    (stack.Outputs ?? []).map((item) => [item.OutputKey, item.OutputValue]),
  );
  check(
    parameters.Stage === "test" &&
      parameters.PublicOrigin === ORIGIN &&
      parameters.SelfRegistrationEnabled === "true" &&
      outputs.ProductDomain === new URL(ORIGIN).hostname,
    "TESTING_PARAMETERS_REQUIRED",
  );
  check(
    outputs.IdentityAdminFunctionName === ADMIN &&
      outputs.CognitoDomain ===
        "https://saldoevento-test-765932874577.auth.us-east-1.amazoncognito.com",
    "TESTING_ADMIN_TARGET_REQUIRED",
  );
  check(
    /^us-east-1_[A-Za-z0-9]+$/.test(outputs.UserPoolId ?? "") &&
      /^[A-Za-z0-9]+$/.test(outputs.UserPoolClientId ?? ""),
    "TESTING_IDENTITY_OUTPUTS_REQUIRED",
  );
  return {
    userPoolId: outputs.UserPoolId,
    clientId: outputs.UserPoolClientId,
    functionName: ADMIN,
    origin: ORIGIN,
  };
}

export async function createTestingAdminAdapter({
  functionName,
  userPoolId,
  region = REGION,
  client,
  commands,
} = {}) {
  check(
    functionName === ADMIN &&
      region === REGION &&
      /^us-east-1_[A-Za-z0-9]+$/.test(userPoolId ?? ""),
    "TESTING_ADMIN_TARGET_REQUIRED",
  );
  const sdk =
    commands ??
    createRequire(new URL("../services/package.json", import.meta.url))(
      "@aws-sdk/client-lambda",
    );
  const lambda = client ?? new sdk.LambdaClient({ region });
  return {
    invoke: async (input) => {
      check(
        ["grantPlan", "grantMember"].includes(input.action) &&
          input.userPoolId === userPoolId,
        "TESTING_ADMIN_COMMAND_REQUIRED",
      );
      const result = await lambda.send(
        new sdk.InvokeCommand({
          FunctionName: functionName,
          Payload: Buffer.from(JSON.stringify({ internal: input })),
        }),
      );
      check(!result.FunctionError, "ADMIN_FUNCTION_FAILED");
      try {
        return JSON.parse(Buffer.from(result.Payload).toString("utf8"));
      } catch {
        throw new SmokeFailure("ADMIN_RESPONSE_INVALID");
      }
    },
  };
}

function claimsFor(token, target) {
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    throw new SmokeFailure("ID_TOKEN_INVALID");
  }
  check(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(claims.sub ?? "") &&
      claims.iss ===
        `https://cognito-idp.${REGION}.amazonaws.com/${target.userPoolId}` &&
      claims.aud === target.clientId &&
      claims.token_use === "id",
    "ID_TOKEN_ENVIRONMENT_MISMATCH",
  );
  const home = `org-${createHash("sha256")
    .update(JSON.stringify([target.userPoolId, claims.sub]))
    .digest("hex")
    .slice(0, 32)}`;
  check(
    claims["custom:organizationId"] === home &&
      claims["custom:roles"] === "admin" &&
      claims["custom:tier"] === "pilot",
    "SELF_SERVICE_PROVISIONING_MISMATCH",
  );
  return { subject: claims.sub, home };
}

export async function runSubscriptionsSmoke({
  stackName = STACK,
  stackDescription,
  accountId,
  region = REGION,
  cognito,
  admin,
  fetchImpl = fetch,
  clock = () => Date.now(),
}) {
  // Guards execute before ANY Cognito, Lambda-admin or business-data mutation.
  const target = validateTestingTarget(
    stackName,
    stackDescription,
    accountId,
    region,
  );
  check(
    cognito &&
      ["createUser", "setPassword", "authenticate", "deleteUser"].every(
        (name) => typeof cognito[name] === "function",
      ) &&
      typeof admin?.invoke === "function",
    "SMOKE_ADAPTERS_REQUIRED",
  );
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const attempted = [];
  const identities = [];
  const report = {
    schemaVersion: 1,
    product: "SaldoEvento",
    environment: "testing",
    stack: STACK,
    origin: ORIGIN,
    startedAt: new Date(clock()).toISOString(),
    status: "running",
    billingEnabled: false,
    runId,
    checks: [],
    metrics: {
      temporaryAccounts: 2,
      createdEvents: 0,
      eventQuotaRejections: 0,
      manualPlanAssignments: 0,
    },
    cleanup: {
      attemptedUsers: 0,
      createdUsers: 0,
      deletedUsers: 0,
      failures: 0,
    },
  };
  let active = "temporary_identities";
  const passed = (name) => report.checks.push({ name, status: "passed" });
  const operation = (suffix) => `tiers-${runId}-${suffix}`;
  async function request(
    method,
    endpoint,
    user,
    body,
    { organizationId, status = 200, code } = {},
  ) {
    check(
      endpoint.startsWith("/api/v1/") &&
        !endpoint.includes("?") &&
        !endpoint.includes("..") &&
        !endpoint.includes("://"),
      "HTTP_PATH_NOT_ALLOWED",
    );
    const response = await fetchImpl(`${ORIGIN}${endpoint}`, {
      method,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${user.token}`,
        ...(organizationId
          ? { "X-SaldoEvento-Organization": organizationId }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    check(
      response.status === status,
      `HTTP_${response.status}_EXPECTED_${status}`,
    );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new SmokeFailure("HTTP_RESPONSE_INVALID");
    }
    if (code) check(data.error?.code === code, "HTTP_ERROR_CODE_MISMATCH");
    return data;
  }
  const me = (user, organizationId) =>
    request("GET", "/api/v1/me", user, undefined, { organizationId });
  async function grant(user, code) {
    const current = await me(user);
    const result = await admin.invoke({
      action: "grantPlan",
      userPoolId: target.userPoolId,
      subject: user.subject,
      organizationId: user.home,
      code,
      expectedVersion: current.organization.plan.assignmentVersion,
      operationId: operation(`plan-${code}`),
      operatorReference: "testing-subscriptions-smoke",
    });
    check(
      !result.statusCode &&
        result.plan?.code === code &&
        result.plan.billingEnabled === false,
      "MANUAL_PLAN_GRANT_FAILED",
    );
    const fresh = await me(user);
    check(
      fresh.organization.plan.code === code &&
        fresh.organization.plan.billingEnabled === false,
      "FRESH_PLAN_NOT_APPLIED",
    );
    report.metrics.manualPlanAssignments++;
    return fresh;
  }
  async function createEvent(user, suffix, currency = "MXN") {
    const result = await request(
      "POST",
      "/api/v1/events",
      user,
      {
        operationId: operation(suffix),
        name: `[SYNTHETIC TIERS ${runId}] ${suffix}`,
        currency,
      },
      { status: 201 },
    );
    check(identifier(result.event?.eventId), "EVENT_ID_INVALID");
    report.metrics.createdEvents++;
    return result.event.eventId;
  }
  const closing = (user, eventId) =>
    request("GET", `/api/v1/events/${eventId}/closing`, user);
  try {
    for (let index = 0; index < 2; index++) {
      const username = `tiers-${runId}-${index}@example.test`;
      const password = `S!a9${randomBytes(30).toString("base64url")}`;
      attempted.push(username);
      report.cleanup.attemptedUsers++;
      await cognito.createUser({ userPoolId: target.userPoolId, username });
      report.cleanup.createdUsers++;
      await cognito.setPassword({
        userPoolId: target.userPoolId,
        username,
        password,
      });
      const token = await cognito.authenticate({
        userPoolId: target.userPoolId,
        clientId: target.clientId,
        username,
        password,
      });
      identities.push({ token, ...claimsFor(token, target) });
    }
    passed(active);
    const [owner, collaborator] = identities;
    active = "self_service_pilot";
    const initial = await me(owner);
    const otherHome = await me(collaborator);
    check(
      initial.homeOrganizationId === owner.home &&
        otherHome.homeOrganizationId === collaborator.home &&
        owner.home !== collaborator.home &&
        initial.organization.plan.code === "pilot" &&
        initial.organization.limits.maxActiveEvents === null &&
        initial.organization.limits.maxSeats === 1 &&
        initial.organization.capabilities.closeEvent === false,
      "PILOT_CONTEXT_MISMATCH",
    );
    passed(active);

    active = "event_quota_and_lifecycle";
    const eventPlan = await grant(owner, "event");
    check(
      eventPlan.organization.limits.maxActiveEvents === 1 &&
        eventPlan.organization.capabilities.closeEvent === true,
      "EVENT_PLAN_MISMATCH",
    );
    const first = await createEvent(owner, "first");
    const single = await request("GET", `/api/v1/events/${first}`, owner);
    check(single.event?.eventId === first, "SINGLE_EVENT_ROUTE_MISMATCH");
    await request(
      "POST",
      "/api/v1/events",
      owner,
      {
        operationId: operation("quota-rejected"),
        name: `[SYNTHETIC TIERS ${runId}] denied`,
        currency: "MXN",
      },
      { status: 409, code: "EVENT_LIMIT_REACHED" },
    );
    report.metrics.eventQuotaRejections++;
    const person = await request(
      "POST",
      `/api/v1/events/${first}/participants`,
      owner,
      {
        operationId: operation("participant"),
        name: `=SYNTHETIC-${runId}`,
        reference: "TIERS-ANA",
        agreedMinor: "100000",
      },
      { status: 201 },
    );
    check(
      identifier(person.participant?.participantId),
      "PARTICIPANT_ID_INVALID",
    );
    const participantId = person.participant.participantId;
    await request("POST", `/api/v1/events/${first}/payments`, owner, {
      operationId: operation("pay"),
      participantId,
      reference: operation("receipt"),
      amountMinor: "50000",
      currency: "MXN",
      expectedVersion: 0,
    });
    let state = await closing(owner, first);
    state = await request("POST", `/api/v1/events/${first}/closing`, owner, {
      operationId: operation("close"),
      expectedLedgerVersion: state.ledgerVersion,
      expectedLifecycleVersion: state.lifecycleVersion,
    });
    check(
      state.financialStatus === "closed" &&
        state.latestClosure?.totals?.paidMinor === "50000" &&
        identifier(state.latestClosure.closureId),
      "CLOSED_SNAPSHOT_MISMATCH",
    );
    const closureId = state.latestClosure.closureId;
    const originalReport = await request(
      "GET",
      `/api/v1/events/${first}/report`,
      owner,
    );
    check(
      originalReport.contentType === "text/csv; charset=utf-8" &&
        originalReport.content.startsWith("\uFEFF") &&
        originalReport.content.includes(`'=SYNTHETIC-${runId}`),
      "CSV_REPORT_MISMATCH",
    );
    state = await request("POST", `/api/v1/events/${first}/archive`, owner, {
      operationId: operation("archive"),
      expectedEventRevision: state.eventRevision,
      expectedLifecycleVersion: state.lifecycleVersion,
    });
    check(!!state.archivedAt, "ARCHIVE_NOT_APPLIED");
    const second = await createEvent(owner, "second", "USD");
    await request(
      "POST",
      `/api/v1/events/${first}/reopen`,
      owner,
      {
        operationId: operation("reopen-denied"),
        expectedEventRevision: state.eventRevision,
        expectedLifecycleVersion: state.lifecycleVersion,
      },
      { status: 409, code: "EVENT_LIMIT_REACHED" },
    );
    report.metrics.eventQuotaRejections++;
    check(
      (await closing(owner, first)).financialStatus === "closed",
      "REOPEN_QUOTA_PARTIAL_WRITE",
    );
    passed(active);

    active = "organizer_templates_and_quota";
    const organizer = await grant(owner, "organizer");
    check(
      organizer.organization.limits.maxActiveEvents === 5 &&
        organizer.organization.capabilities.manageTemplates &&
        organizer.organization.capabilities.viewOverview,
      "ORGANIZER_PLAN_MISMATCH",
    );
    state = await closing(owner, first);
    state = await request("POST", `/api/v1/events/${first}/reopen`, owner, {
      operationId: operation("reopen"),
      expectedEventRevision: state.eventRevision,
      expectedLifecycleVersion: state.lifecycleVersion,
    });
    check(
      state.financialStatus === "open" &&
        !state.transition &&
        !state.archivedAt,
      "REOPEN_NOT_FINALIZED",
    );
    check(
      !(await request("GET", `/api/v1/events/${first}`, owner)).event
        .archivedAt,
      "SINGLE_EVENT_REOPEN_STATE_MISMATCH",
    );
    const template = await request(
      "POST",
      "/api/v1/templates",
      owner,
      {
        operationId: operation("template"),
        name: `[SYNTHETIC TIERS ${runId}] template`,
        sourceEventId: first,
      },
      { status: 201 },
    );
    check(identifier(template.template?.templateId), "TEMPLATE_ID_INVALID");
    const applied = await request(
      "POST",
      `/api/v1/templates/${template.template.templateId}/events`,
      owner,
      {
        operationId: operation("apply-template"),
        name: `[SYNTHETIC TIERS ${runId}] copied roster`,
        expectedTemplateVersion: template.template.version,
      },
      { status: 201 },
    );
    check(identifier(applied.event?.eventId), "TEMPLATE_EVENT_ID_INVALID");
    report.metrics.createdEvents++;
    const copied = await request(
      "GET",
      `/api/v1/events/${applied.event.eventId}/balances`,
      owner,
    );
    check(
      copied.balances.length === 1 && copied.balances[0].paidMinor === "0",
      "TEMPLATE_COPIED_PAYMENTS",
    );
    const overview = await request("GET", "/api/v1/overview", owner);
    check(
      overview.events.length === 3 &&
        new Set(overview.totalsByCurrency.map((group) => group.currency))
          .size === 2 &&
        overview.totalsByCurrency.every(
          (group) => typeof group.paidMinor === "string",
        ),
      "OVERVIEW_CURRENCY_MISMATCH",
    );
    passed(active);

    active = "team_current_roles_and_revocation";
    const team = await grant(owner, "team");
    check(
      team.organization.limits.maxActiveEvents === 20 &&
        team.organization.limits.maxSeats === 5 &&
        team.organization.capabilities.manageTeam,
      "TEAM_PLAN_MISMATCH",
    );
    const membership = await admin.invoke({
      action: "grantMember",
      userPoolId: target.userPoolId,
      subject: collaborator.subject,
      organizationId: owner.home,
      roles: ["auditor"],
      eventIds: [first],
      operationId: operation("member"),
      expectedVersion: team.organization.plan.assignmentVersion,
      operatorReference: "testing-subscriptions-smoke",
    });
    check(
      !membership.statusCode && identifier(membership.member?.memberId),
      "MEMBER_GRANT_FAILED",
    );
    let member = membership.member;
    let selected = await me(collaborator, owner.home);
    check(
      selected.homeOrganizationId === collaborator.home &&
        selected.activeOrganizationId === owner.home &&
        selected.organization.capabilities.confirmPayments === false &&
        selected.organization.capabilities.createEvent === false &&
        selected.organization.capabilities.viewOverview === false,
      "SCOPED_MEMBER_CONTEXT_MISMATCH",
    );
    await request(
      "GET",
      `/api/v1/events/${first}/participants`,
      collaborator,
      undefined,
      { organizationId: owner.home },
    );
    await request(
      "GET",
      `/api/v1/events/${second}/participants`,
      collaborator,
      undefined,
      { organizationId: owner.home, status: 404 },
    );
    await request(
      "POST",
      `/api/v1/events/${first}/payments`,
      collaborator,
      {
        operationId: operation("forbidden-pay"),
        participantId,
        reference: operation("denied-receipt"),
        amountMinor: "10000",
        currency: "MXN",
        expectedVersion: 1,
      },
      { organizationId: owner.home, status: 403 },
    );
    await request("GET", "/api/v1/overview", collaborator, undefined, {
      organizationId: owner.home,
      status: 403,
    });
    const members = await request(
      "GET",
      "/api/v1/organizations/current/members",
      owner,
    );
    check(members.members.length === 2, "MEMBER_LIST_MISMATCH");
    member = (
      await request(
        "POST",
        `/api/v1/organizations/current/members/${member.memberId}/role`,
        owner,
        {
          operationId: operation("role"),
          expectedVersion: member.version,
          roles: ["confirmer"],
        },
      )
    ).member;
    selected = await me(collaborator, owner.home);
    check(
      selected.organization.capabilities.confirmPayments === true &&
        selected.organization.capabilities.importPayments === false,
      "FRESH_ROLE_NOT_APPLIED",
    );
    const balances = await request(
      "GET",
      `/api/v1/events/${first}/balances`,
      collaborator,
      undefined,
      { organizationId: owner.home },
    );
    await request(
      "POST",
      `/api/v1/events/${first}/payments`,
      collaborator,
      {
        operationId: operation("collaborator-pay"),
        participantId,
        reference: operation("collaborator-receipt"),
        amountMinor: "10000",
        currency: "MXN",
        expectedVersion: balances.version,
      },
      { organizationId: owner.home },
    );
    await request(
      "POST",
      `/api/v1/organizations/current/members/${member.memberId}/revoke`,
      owner,
      { operationId: operation("revoke"), expectedVersion: member.version },
    );
    await request("GET", "/api/v1/me", collaborator, undefined, {
      organizationId: owner.home,
      status: 403,
      code: "MEMBERSHIP_REVOKED",
    });
    check(
      (await me(collaborator)).homeOrganizationId === collaborator.home &&
        (await me(owner)).organization.usage.activeSeats === 1,
      "PERSONAL_ORGANIZATION_NOT_PRESERVED",
    );
    passed(active);

    active = "downgrade_preserves_history";
    await grant(owner, "pilot");
    const historical = await request(
      "GET",
      `/api/v1/events/${first}/report/${closureId}`,
      owner,
    );
    check(
      historical.content === originalReport.content,
      "HISTORICAL_REPORT_CHANGED",
    );
    await request("GET", `/api/v1/events/${first}/report`, owner, undefined, {
      status: 403,
      code: "PLAN_CAPABILITY_REQUIRED",
    });
    passed(active);
    report.metrics.closedSnapshots = 1;
    report.metrics.roleChanges = 1;
    report.metrics.revokedCollaborators = 1;
    report.metrics.currencyGroups = 2;
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.checks.push({
      name: active,
      status: "failed",
      code:
        error instanceof SmokeFailure
          ? error.code
          : "PROVIDER_OR_TRANSPORT_FAILURE",
    });
  } finally {
    for (const username of attempted.reverse()) {
      try {
        await cognito.deleteUser({ userPoolId: target.userPoolId, username });
        report.cleanup.deletedUsers++;
      } catch {
        report.cleanup.failures++;
      }
    }
    if (report.cleanup.failures) {
      report.status = "failed";
      report.checks.push({
        name: "temporary_identity_cleanup",
        status: "failed",
        code: "COGNITO_CLEANUP_FAILED",
      });
    } else passed("temporary_identity_cleanup");
    report.finishedAt = new Date(clock()).toISOString();
    report.limitations = [
      "Only temporary Cognito accounts are removed; synthetic event, identity and financial history is retained.",
      "No email delivery or browser OAuth was tested; messages were suppressed.",
      "Team 20-event/5-person boundaries and organizer concurrent limits remain covered by unit tests, not exhausted here.",
      "CSV upload and worker delivery belong to the separate cloud smoke.",
    ];
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSubscriptionArgs(argv);
  let accountId;
  try {
    accountId = JSON.parse(
      execFileSync(
        "aws",
        [
          "sts",
          "get-caller-identity",
          "--query",
          "Account",
          "--output",
          "json",
          "--region",
          REGION,
          "--no-cli-pager",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      ),
    );
  } catch {
    throw new SmokeFailure("ACCOUNT_READ_FAILED");
  }
  const stackDescription = describeStack(options);
  const target = validateTestingTarget(
    options.stack,
    stackDescription,
    accountId,
    options.region,
  );
  const report = await runSubscriptionsSmoke({
    stackName: options.stack,
    stackDescription,
    accountId,
    region: options.region,
    cognito: await createCognitoAdapter({ region: REGION }),
    admin: await createTestingAdminAdapter({
      functionName: target.functionName,
      userPoolId: target.userPoolId,
    }),
  });
  const directory = path.join(root, "artifacts/deployments/test");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "subscriptions-smoke.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  return report.status === "passed" ? 0 : 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        code: error instanceof SmokeFailure ? error.code : "PREFLIGHT_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
