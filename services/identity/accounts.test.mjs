import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
const accounts = await import("./accounts.mjs").catch(() => ({}));
const repositories = await import("./accounts-repository.mjs").catch(
  () => ({}),
);
const access = await import("../shared/access.mjs").catch(() => ({}));
const plans = await import("../shared/plans.mjs").catch(() => ({}));
const pool = "us-east-1_Synthetic";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";
const orgFor = (subject) =>
  `org-${createHash("sha256")
    .update(JSON.stringify([pool, subject]))
    .digest("hex")
    .slice(0, 32)}`;
const legacyKey = (subject) => ({
  pk: `POOL#${pool}#USER#${subject}`,
  sk: "MEMBERSHIP",
});
const legacy = (subject, extra = {}) => ({
  userPoolId: pool,
  userSub: subject,
  organizationId: orgFor(subject),
  roles: ["admin"],
  tier: "pilot",
  status: "active",
  source: "self-registration",
  schemaVersion: 1,
  ...extra,
});
const command = (action, extra = {}) => ({
  action,
  userPoolId: pool,
  subject: owner,
  organizationId: orgFor(owner),
  operationId: `operation-${action}`,
  ...extra,
});
const request = (subject = owner, organizationHint) => ({
  headers: organizationHint
    ? { "X-SaldoEvento-Organization": organizationHint }
    : {},
  requestContext: {
    authorizer: {
      jwt: {
        claims: {
          sub: subject,
          iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`,
          token_use: "id",
          "custom:organizationId": "forged-org",
          "custom:roles": "admin",
          "custom:tier": "team",
        },
      },
    },
  },
});

async function fixture() {
  assert.equal(
    typeof accounts.createAccountsService,
    "function",
    "account service must exist",
  );
  assert.equal(typeof repositories.MemoryAccountsRepository, "function");
  const repository = new repositories.MemoryAccountsRepository({
    validateUsage: (guard) => {
      assert.equal(guard.version, 0);
      assert.equal(guard.nonArchivedCount, 0);
    },
  });
  for (const subject of [owner, other, third])
    await repository.seed(legacyKey(subject), legacy(subject));
  const service = accounts.createAccountsService({
    repository,
    usageReader: async () => ({ version: 0, nonArchivedCount: 0 }),
    now: () => "2026-11-19T00:00:00Z",
  });
  return { repository, service };
}

test("catalog preserves pilot without an event quota and separates plan capabilities", () => {
  assert.equal(typeof plans.getPlan, "function", "plan catalog must exist");
  assert.equal(plans.getPlan("pilot").limits.maxActiveEvents, null);
  assert.deepEqual(
    ["event", "organizer", "team"].map(
      (code) => plans.getPlan(code).limits.maxActiveEvents,
    ),
    [1, 5, 20],
  );
  assert.deepEqual(
    ["pilot", "event", "organizer", "team"].map(
      (code) => plans.getPlan(code).limits.maxSeats,
    ),
    [1, 1, 1, 5],
  );
  assert.throws(() => plans.getPlan("unlimited"), { code: "INVALID_PLAN" });
});

test("fresh resolution ignores mutable claims and never overwrites a legacy membership", async () => {
  const { repository, service } = await fixture();
  const before = await repository.getItem(legacyKey(owner));
  const actor = await service.resolve({ userPoolId: pool, subject: owner });
  assert.equal(actor.organizationId, orgFor(owner));
  assert.equal(actor.isOwner, true);
  assert.equal(actor.plan.code, "pilot");
  assert.equal(actor.limits.maxActiveEvents, null);
  assert.equal(actor.capabilities.manageTeam, false);
  assert.equal(actor.capabilities.confirmPayments, true);
  assert.deepEqual(await repository.getItem(legacyKey(owner)), before);
  const current = await service.me({ userPoolId: pool, subject: owner });
  assert.equal(current.homeOrganizationId, orgFor(owner));
  assert.equal(current.activeOrganizationId, orgFor(owner));
  assert.equal(current.organization.usage.activeSeats, 1);
  await assert.rejects(
    service.resolve({
      userPoolId: pool,
      subject: owner,
      organizationHint: "victim-org",
    }),
    { status: 404 },
  );
  const resolve = access.createAccessResolver({
    identityReader: service,
    userPoolId: pool,
  });
  assert.equal(
    (await resolve(request(), ["confirmer"])).organizationId,
    orgFor(owner),
  );
});

test("manual plan grant is versioned, idempotent and checks current event usage before downgrade", async () => {
  const { repository, service } = await fixture();
  const before = await repository.getItem(legacyKey(owner));
  const input = command("grantPlan", { code: "team", expectedVersion: 0 });
  const first = await service.admin(input);
  const retry = await service.admin(input);
  assert.deepEqual(retry, first);
  assert.equal(first.plan.code, "team");
  await assert.rejects(service.admin({ ...input, code: "event" }), {
    code: "OPERATION_CONFLICT",
  });
  assert.deepEqual(await repository.getItem(legacyKey(owner)), before);
  const overloaded = accounts.createAccountsService({
    repository,
    usageReader: async () => ({ version: 3, nonArchivedCount: 3 }),
  });
  await assert.rejects(
    overloaded.admin(
      command("grantPlan", {
        operationId: "downgrade",
        code: "event",
        expectedVersion: first.plan.assignmentVersion,
      }),
    ),
    { code: "PLAN_USAGE_EXCEEDS_LIMIT" },
  );
});

test("manual team grant preserves home, restricts scopes, and revocation invalidates an old actor", async () => {
  const { repository, service } = await fixture();
  await service.admin(
    command("grantPlan", { code: "team", expectedVersion: 0 }),
  );
  const member = (
    await service.admin(
      command("grantMember", {
        subject: other,
        roles: ["importer"],
        eventIds: ["event-a"],
        expectedVersion: 1,
      }),
    )
  ).member;
  const actor = await service.resolve({
    userPoolId: pool,
    subject: other,
    organizationHint: orgFor(owner),
    eventId: "event-a",
  });
  assert.deepEqual(actor.roles, ["importer"]);
  assert.equal(actor.isOwner, false);
  assert.equal(actor.capabilities.confirmPayments, false);
  assert.equal(actor.capabilities.createEvent, false);
  assert.equal(actor.capabilities.manageTemplates, false);
  assert.equal(actor.capabilities.viewOverview, false);
  assert.equal(
    (await service.me({ userPoolId: pool, subject: other })).homeOrganizationId,
    orgFor(other),
  );
  assert.equal(
    (await repository.getItem(legacyKey(other))).organizationId,
    orgFor(other),
  );
  await assert.rejects(
    service.resolve({
      userPoolId: pool,
      subject: other,
      organizationHint: orgFor(owner),
      eventId: "event-b",
    }),
    { status: 404 },
  );
  await assert.rejects(
    service.updateMember(actor, member.memberId, {
      operationId: "self-elevate",
      expectedVersion: member.version,
      roles: ["operator"],
    }),
    { status: 403 },
  );
  const ownerActor = await service.resolve({
    userPoolId: pool,
    subject: owner,
  });
  assert.equal((await service.members(ownerActor)).members.length, 2);
  await service.revokeMember(ownerActor, member.memberId, {
    operationId: "revoke-other",
    expectedVersion: member.version,
  });
  await assert.rejects(
    service.resolve({
      userPoolId: pool,
      subject: other,
      organizationHint: orgFor(owner),
    }),
    { code: "MEMBERSHIP_REVOKED" },
  );
  await assert.rejects(access.validateMemoryAccess(actor, repository), {
    code: "ACCESS_CHANGED",
  });
});

test("concurrent grants count owner plus all collaborators and never exceed five seats", async () => {
  const { repository, service } = await fixture();
  await service.admin(
    command("grantPlan", { code: "team", expectedVersion: 0 }),
  );
  const subjects = Array.from(
    { length: 5 },
    (_, i) => `0000000${i}-0000-4000-8000-000000000000`,
  );
  for (const subject of subjects)
    await repository.seed(legacyKey(subject), legacy(subject));
  // Refresh plan version after conflicts, as independent operators would do.
  const results = await Promise.all(
    subjects
      .map(async (subject, i) => {
        for (let attempt = 0; attempt < 7; attempt++) {
          const actor = await service.resolve({
            userPoolId: pool,
            subject: owner,
          });
          try {
            return await service.admin(
              command("grantMember", {
                operationId: `seat-${i}`,
                subject,
                roles: ["auditor"],
                expectedVersion: actor.plan.assignmentVersion,
              }),
            );
          } catch (error) {
            if (error.code !== "VERSION_CONFLICT") throw error;
          }
        }
      })
      .map((promise) =>
        promise.then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        ),
      ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    4,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "SEAT_QUOTA_EXCEEDED",
  );
  assert.equal(
    (await service.me({ userPoolId: pool, subject: owner })).organization.usage
      .activeSeats,
    5,
  );
});

test("legacy administrative org keeps roles but cannot claim owner or a strict team baseline", async () => {
  const { repository, service } = await fixture();
  await repository.seed(
    legacyKey(owner),
    legacy(owner, { organizationId: "legacy-org", source: "administrative" }),
  );
  const actor = await service.resolve({ userPoolId: pool, subject: owner });
  assert.equal(actor.isOwner, false);
  assert.equal(actor.capabilities.confirmPayments, true);
  assert.equal(
    (await service.me({ userPoolId: pool, subject: owner })).organization.usage
      .seatBaselineVerified,
    false,
  );
  await assert.rejects(
    service.admin(
      command("grantPlan", {
        organizationId: "legacy-org",
        code: "team",
        expectedVersion: 0,
      }),
    ),
    { code: "LEGACY_BASELINE_REQUIRED" },
  );
});

test("Dynamo access conditions compare current metadata and memory checks fail closed", async () => {
  const { repository, service } = await fixture();
  const actor = await service.resolve({ userPoolId: pool, subject: owner });
  const conditions = access.buildAccessConditions(actor, {
    tableName: "Identity",
  });
  assert.ok(conditions.length >= 2);
  assert.ok(
    conditions.every((item) => item.ConditionCheck.TableName === "Identity"),
  );
  assert.ok(
    conditions.some(
      (item) =>
        item.ConditionCheck.ConditionExpression === "attribute_not_exists(pk)",
    ),
  );
  await access.validateMemoryAccess(actor, repository);
  await repository.seed(legacyKey(owner), {
    ...legacy(owner),
    roles: ["auditor"],
  });
  await assert.rejects(access.validateMemoryAccess(actor, repository), {
    code: "ACCESS_CHANGED",
  });
  assert.throws(
    () =>
      access.buildAccessConditions(
        { ...actor, accessGuards: [] },
        { tableName: "Identity" },
      ),
    { code: "ACCESS_GUARDS_REQUIRED" },
  );
});

test("plan grant checks usage synchronously at the commit boundary", async () => {
  let usageVersion = 0;
  const repository = new repositories.MemoryAccountsRepository({
    validateUsage: (guard) => {
      if (guard.version !== usageVersion)
        throw Object.assign(new Error("changed"), {
          code: "USAGE_CHANGED",
          status: 409,
        });
    },
  });
  await repository.seed(legacyKey(owner), legacy(owner));
  const service = accounts.createAccountsService({
    repository,
    usageReader: async () => {
      const observed = usageVersion;
      queueMicrotask(() => usageVersion++);
      return { version: observed, nonArchivedCount: 0 };
    },
  });
  await assert.rejects(
    service.admin(command("grantPlan", { code: "event", expectedVersion: 0 })),
    { code: "USAGE_CHANGED" },
  );
  assert.equal(
    (await service.resolve({ userPoolId: pool, subject: owner })).plan.code,
    "pilot",
  );
});

test("corrupt verified seats and a forged resolver response fail closed", async () => {
  const { repository, service } = await fixture();
  await service.admin(
    command("grantPlan", { code: "team", expectedVersion: 0 }),
  );
  const key = { pk: `ORG#${orgFor(owner)}`, sk: "PLAN" };
  await repository.seed(key, {
    ...(await repository.getItem(key)),
    activeSeats: null,
  });
  await assert.rejects(service.resolve({ userPoolId: pool, subject: owner }), {
    code: "PLAN_INVALID",
  });
  const resolver = access.createAccessResolver({
    userPoolId: pool,
    identityReader: async () => ({
      subject: other,
      userPoolId: pool,
      organizationId: "victim",
      roles: ["admin"],
    }),
  });
  await assert.rejects(resolver(request()), {
    code: "IDENTITY_RESPONSE_INVALID",
  });
});

test("an additional membership cannot keep operating after its team entitlement disappears", async () => {
  const { repository, service } = await fixture();
  await service.admin(
    command("grantPlan", { code: "team", expectedVersion: 0 }),
  );
  await service.admin(
    command("grantMember", {
      subject: other,
      roles: ["operator"],
      expectedVersion: 1,
    }),
  );
  const key = { pk: `ORG#${orgFor(owner)}`, sk: "PLAN" };
  await repository.seed(key, {
    ...(await repository.getItem(key)),
    code: "organizer",
    version: 3,
  });
  await assert.rejects(
    service.resolve({
      userPoolId: pool,
      subject: other,
      organizationHint: orgFor(owner),
    }),
    { code: "TEAM_PLAN_REQUIRED" },
  );
  assert.equal(
    (await service.resolve({ userPoolId: pool, subject: other }))
      .organizationId,
    orgFor(other),
  );
});

test("owner role edits preserve omitted scopes, require explicit null to broaden, and protect ownership", async () => {
  const { repository, service } = await fixture();
  const originalHome = await repository.getItem(legacyKey(other));
  await service.admin(
    command("grantPlan", { code: "team", expectedVersion: 0 }),
  );
  const { member } = await service.admin(
    command("grantMember", {
      subject: other,
      roles: ["importer"],
      eventIds: ["event-a"],
      expectedVersion: 1,
    }),
  );
  let ownerActor = await service.resolve({ userPoolId: pool, subject: owner });
  const changed = await service.updateMember(ownerActor, member.memberId, {
    operationId: "role-confirmer",
    expectedVersion: member.version,
    roles: ["confirmer"],
  });
  assert.deepEqual(changed.member.eventIds, ["event-a"]);
  const scoped = await service.resolve({
    userPoolId: pool,
    subject: other,
    organizationHint: orgFor(owner),
  });
  assert.equal(scoped.capabilities.confirmPayments, true);
  assert.equal(scoped.capabilities.createEvent, false);
  ownerActor = await service.resolve({ userPoolId: pool, subject: owner });
  await assert.rejects(
    service.updateMember(ownerActor, member.memberId, {
      operationId: "forbidden-admin",
      expectedVersion: changed.member.version,
      roles: ["admin"],
    }),
    { code: "INVALID_ROLES" },
  );
  await assert.rejects(
    service.revokeMember(ownerActor, ownerActor.memberId, {
      operationId: "remove-owner",
      expectedVersion: 0,
    }),
    { code: "OWNER_MEMBERSHIP_PROTECTED" },
  );
  const global = await service.updateMember(ownerActor, member.memberId, {
    operationId: "broaden-scope",
    expectedVersion: changed.member.version,
    roles: ["operator"],
    eventIds: null,
  });
  assert.equal(global.member.eventIds, null);
  assert.equal(
    (
      await service.resolve({
        userPoolId: pool,
        subject: other,
        organizationHint: orgFor(owner),
      })
    ).capabilities.createEvent,
    true,
  );
  await assert.rejects(
    service.admin(
      command("grantPlan", {
        operationId: "too-many-seats",
        code: "organizer",
        expectedVersion: (
          await service.resolve({ userPoolId: pool, subject: owner })
        ).plan.assignmentVersion,
      }),
    ),
    { code: "PLAN_SEATS_EXCEED_LIMIT" },
  );
  assert.deepEqual(await repository.getItem(legacyKey(other)), originalHome);
});
