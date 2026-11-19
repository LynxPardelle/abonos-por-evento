import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DomainError, validateId } from "../shared/http.mjs";
import {
  capabilitiesFor,
  getPlan,
  PLAN_CATALOG_VERSION,
} from "../shared/plans.mjs";

const error = (status, code, message) => {
  throw new DomainError(status, code, message);
};
const clone = (value) => structuredClone(value);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rolesAllowed = new Set([
  "admin",
  "operator",
  "importer",
  "confirmer",
  "auditor",
]);
const collaboratorRoles = new Set([
  "operator",
  "importer",
  "confirmer",
  "auditor",
]);
export const personalOrganizationId = (pool, subject) =>
  `org-${hash([pool, subject]).slice(0, 32)}`;
export const memberIdFor = (pool, subject) =>
  `member-${hash([pool, subject]).slice(0, 32)}`;
export const accountKeys = {
  legacy: (pool, subject) => ({
    pk: `POOL#${pool}#USER#${subject}`,
    sk: "MEMBERSHIP",
  }),
  membership: (pool, subject, org) => ({
    pk: `POOL#${pool}#USER#${subject}`,
    sk: `ORG#${org}`,
  }),
  plan: (org) => ({ pk: `ORG#${org}`, sk: "PLAN" }),
  member: (org, memberId) => ({ pk: `ORG#${org}`, sk: `MEMBER#${memberId}` }),
};
const snapshot = (key, data) => ({ key, data: data ?? null });
function scope(pool, subject) {
  if (
    typeof pool !== "string" ||
    !/^[a-z0-9-]+_[A-Za-z0-9]{1,64}$/.test(pool) ||
    typeof subject !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(subject)
  )
    error(401, "UNAUTHENTICATED", "La identidad no es válida.");
}
function validateRoles(roles, allowed = collaboratorRoles) {
  if (
    !Array.isArray(roles) ||
    !roles.length ||
    roles.length > 5 ||
    roles.some((role) => !allowed.has(role)) ||
    new Set(roles).size !== roles.length
  )
    error(
      400,
      "INVALID_ROLES",
      "Selecciona roles admitidos sin conceder propiedad.",
    );
  return [...roles].sort();
}
function eventScope(value) {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 50 ||
    new Set(value).size !== value.length
  )
    error(
      400,
      "INVALID_EVENT_SCOPE",
      "Selecciona entre uno y cincuenta eventos distintos.",
    );
  return value.map((id) => validateId(id, "eventId")).sort();
}
function homeValid(home, pool, subject) {
  if (
    !home ||
    home.userPoolId !== pool ||
    home.userSub !== subject ||
    home.tier !== "pilot" ||
    !Array.isArray(home.roles) ||
    !home.roles.length ||
    home.roles.some((role) => !rolesAllowed.has(role))
  )
    error(
      401,
      "MEMBERSHIP_INVALID",
      "La sesión no tiene una membresía válida.",
    );
  validateId(home.organizationId, "organizationId");
  if (home.status !== "active")
    error(
      403,
      "MEMBERSHIP_REVOKED",
      "Tu acceso a esta organización ya no está activo.",
    );
  return home;
}
const ownerOfHome = (home) =>
  home.source === "self-registration" &&
  home.organizationId ===
    personalOrganizationId(home.userPoolId, home.userSub) &&
  home.roles.includes("admin");
const dto = (member) => ({
  memberId: member.memberId,
  organizationId: member.organizationId,
  roles: clone(member.roles),
  eventIds: clone(member.eventIds ?? null),
  status: member.status,
  version: member.version,
  isOwner: !!member.isOwner,
});
const publicPlan = (plan) => ({
  code: plan.code,
  catalogVersion: plan.catalogVersion,
  assignmentVersion: plan.version,
  status: plan.status,
  source: plan.source,
  billingEnabled: false,
});
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
function rejectUnknown(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    error(400, "INVALID_FIELD", "La solicitud contiene campos no admitidos.");
}

export function createAccountsService({
  repository,
  usageReader,
  userPoolId: configuredPool,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repository) throw new Error("Account repository is required.");
  async function homeFor(pool, subject) {
    scope(pool, subject);
    if (configuredPool && pool !== configuredPool)
      error(401, "UNAUTHENTICATED", "La identidad pertenece a otro ambiente.");
    return homeValid(
      await repository.getItem(accountKeys.legacy(pool, subject)),
      pool,
      subject,
    );
  }
  async function planFor(org, home) {
    const stored = await repository.getItem(accountKeys.plan(org));
    if (stored) {
      if (
        stored.organizationId !== org ||
        stored.catalogVersion !== PLAN_CATALOG_VERSION ||
        !Number.isSafeInteger(stored.version) ||
        stored.version < 1 ||
        stored.status !== "active" ||
        !["manual", "default"].includes(stored.source) ||
        typeof stored.seatBaselineVerified !== "boolean" ||
        (stored.activeSeats !== null &&
          (!Number.isSafeInteger(stored.activeSeats) || stored.activeSeats < 1))
      )
        error(503, "PLAN_INVALID", "No se pudo verificar el plan actual.");
      if (
        stored.seatBaselineVerified &&
        (stored.activeSeats === null ||
          !stored.owner ||
          typeof stored.owner.subject !== "string" ||
          typeof stored.owner.userPoolId !== "string")
      )
        error(
          503,
          "PLAN_INVALID",
          "No se pudo comprobar la base de plazas del plan.",
        );
      getPlan(stored.code);
      return { stored, plan: stored };
    }
    const owner = home?.organizationId === org && ownerOfHome(home);
    return {
      stored: undefined,
      plan: {
        organizationId: org,
        code: "pilot",
        catalogVersion: PLAN_CATALOG_VERSION,
        version: 0,
        status: "active",
        source: "default",
        owner: owner
          ? { userPoolId: home.userPoolId, subject: home.userSub }
          : null,
        seatBaselineVerified: !!owner,
        activeSeats: owner ? 1 : null,
      },
    };
  }
  async function resolve(input) {
    const { userPoolId: pool, subject } = input;
    const home = await homeFor(pool, subject);
    const org =
      input.organizationHint === undefined
        ? home.organizationId
        : validateId(input.organizationHint, "organizationId");
    let membership;
    const guards = [snapshot(accountKeys.legacy(pool, subject), home)];
    if (org === home.organizationId)
      membership = {
        memberId: memberIdFor(pool, subject),
        organizationId: org,
        roles: home.roles,
        eventIds: null,
        status: home.status,
        version: 0,
        isOwner: ownerOfHome(home),
      };
    else {
      const key = accountKeys.membership(pool, subject, org);
      membership = await repository.getItem(key);
      if (!membership)
        error(404, "ORGANIZATION_NOT_FOUND", "No se encontró la organización.");
      if (
        membership.userPoolId !== pool ||
        membership.subject !== subject ||
        membership.organizationId !== org ||
        membership.memberId !== memberIdFor(pool, subject)
      )
        error(403, "MEMBERSHIP_INVALID", "La membresía no es válida.");
      if (membership.status !== "active")
        error(
          403,
          "MEMBERSHIP_REVOKED",
          "Tu acceso a esta organización ya no está activo.",
        );
      validateRoles(membership.roles);
      eventScope(membership.eventIds);
      if (!Number.isSafeInteger(membership.version) || membership.version < 1)
        error(403, "MEMBERSHIP_INVALID", "La membresía no es válida.");
      guards.push(snapshot(key, membership));
    }
    const { plan, stored } = await planFor(org, home);
    if (
      org !== home.organizationId &&
      (plan.code !== "team" || !plan.seatBaselineVerified || !stored)
    )
      error(
        403,
        "TEAM_PLAN_REQUIRED",
        "La organización ya no dispone del acceso de Equipo necesario.",
      );
    guards.push(snapshot(accountKeys.plan(org), stored));
    const isOwner =
      !!plan.owner &&
      plan.owner.userPoolId === pool &&
      plan.owner.subject === subject &&
      membership.isOwner === true;
    const actor = {
      userPoolId: pool,
      subject,
      organizationId: org,
      homeOrganizationId: home.organizationId,
      memberId: membership.memberId,
      roles: clone(membership.roles),
      isOwner,
      eventIds: clone(membership.eventIds ?? null),
      plan: publicPlan(plan),
      limits: clone(getPlan(plan.code).limits),
      usage: {
        activeSeats: plan.activeSeats,
        seatBaselineVerified: plan.seatBaselineVerified,
      },
      accessGuards: guards,
    };
    actor.capabilities = capabilitiesFor({
      ...actor,
      seatBaselineVerified: plan.seatBaselineVerified,
    });
    if (
      input.eventId &&
      Array.isArray(actor.eventIds) &&
      !actor.eventIds.includes(input.eventId)
    )
      error(404, "EVENT_NOT_FOUND", "No se encontró el evento.");
    return actor;
  }
  async function me(input) {
    const actor = await resolve(input);
    const home = await homeFor(input.userPoolId, input.subject);
    const organizations = [
      {
        organizationId: home.organizationId,
        isHome: true,
        isOwner: ownerOfHome(home),
        roles: clone(home.roles),
        status: home.status,
      },
    ];
    for (const item of await repository.queryItems(
      accountKeys.legacy(input.userPoolId, input.subject).pk,
      "ORG#",
    )) {
      const member = item.data;
      if (
        member?.status === "active" &&
        member.userPoolId === input.userPoolId &&
        member.subject === input.subject &&
        member.organizationId !== home.organizationId
      )
        organizations.push({
          organizationId: member.organizationId,
          isHome: false,
          isOwner: false,
          roles: clone(member.roles),
          status: member.status,
        });
    }
    return {
      homeOrganizationId: home.organizationId,
      activeOrganizationId: actor.organizationId,
      organizations,
      organization: {
        organizationId: actor.organizationId,
        plan: actor.plan,
        capabilities: actor.capabilities,
        limits: actor.limits,
        usage: actor.usage,
      },
    };
  }
  function teamOwner(actor) {
    if (!actor.isOwner || actor.capabilities.manageTeam !== true)
      error(
        403,
        "FORBIDDEN",
        "Sólo el propietario con acceso a Equipo puede gestionar colaboradores.",
      );
  }
  async function members(actor) {
    teamOwner(actor);
    const home = await homeFor(actor.userPoolId, actor.subject);
    const owner = {
      memberId: memberIdFor(actor.userPoolId, actor.subject),
      organizationId: actor.organizationId,
      roles: home.roles,
      eventIds: null,
      status: "active",
      version: 0,
      isOwner: true,
    };
    const items = await repository.queryItems(
      `ORG#${actor.organizationId}`,
      "MEMBER#",
    );
    return {
      members: [dto(owner), ...items.map((item) => dto(item.data))],
      version: actor.plan.assignmentVersion,
    };
  }
  async function mutateOperation(org, operationId, fingerprint, build) {
    validateId(operationId, "operationId");
    const key = { pk: `ORG#${org}`, sk: `OP#${operationId}` };
    const prior = await repository.getItem(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        error(
          409,
          "OPERATION_CONFLICT",
          "La operación ya se utilizó con otros datos.",
        );
      return prior.result;
    }
    const transaction = await build();
    const audit = {
      action: transaction.action,
      organizationId: org,
      occurredAt: now(),
      actor: transaction.actor,
      operationId,
      ...(transaction.target ? { target: transaction.target } : {}),
    };
    try {
      await repository.transact({
        guards: [...transaction.guards, snapshot(key, undefined)],
        puts: [
          ...transaction.puts,
          { key, data: { fingerprint, result: transaction.result } },
          {
            key: { pk: `ORG#${org}`, sk: `AUDIT#${operationId}` },
            data: audit,
          },
        ],
        externalConditions: transaction.externalConditions ?? [],
        usageGuard: transaction.usageGuard,
      });
      return transaction.result;
    } catch (failure) {
      if (failure.code !== "VERSION_CONFLICT") throw failure;
      const saved = await repository.getItem(key);
      if (saved?.fingerprint === fingerprint) return saved.result;
      throw failure;
    }
  }
  async function admin(input) {
    rejectUnknown(input, [
      "action",
      "userPoolId",
      "subject",
      "organizationId",
      "operationId",
      "expectedVersion",
      "code",
      "roles",
      "eventIds",
      "operatorReference",
    ]);
    if (!["grantPlan", "grantMember"].includes(input.action))
      error(
        400,
        "INVALID_ADMIN_ACTION",
        "La acción administrativa no está admitida.",
      );
    scope(input.userPoolId, input.subject);
    const org = validateId(input.organizationId, "organizationId");
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      error(400, "INVALID_VERSION", "Indica la versión actual del plan.");
    const fingerprint = hash(canonical(input));
    return mutateOperation(org, input.operationId, fingerprint, async () => {
      const targetHome = await homeFor(input.userPoolId, input.subject);
      const { stored, plan } = await planFor(org, targetHome);
      if (input.expectedVersion !== plan.version)
        error(
          409,
          "VERSION_CONFLICT",
          "El plan cambió. Actualiza antes de continuar.",
        );
      const guards = [
        snapshot(
          accountKeys.legacy(input.userPoolId, input.subject),
          targetHome,
        ),
        snapshot(accountKeys.plan(org), stored),
      ];
      const operator = {
        source: "iam",
        operatorReference:
          typeof input.operatorReference === "string"
            ? input.operatorReference.slice(0, 200)
            : "authorized-iam-operator",
      };
      if (input.action === "grantPlan") {
        const definition = getPlan(input.code);
        if (targetHome.organizationId !== org)
          error(
            404,
            "ORGANIZATION_NOT_FOUND",
            "El usuario no pertenece a esa organización base.",
          );
        if (input.code === "team" && !plan.seatBaselineVerified)
          error(
            409,
            "LEGACY_BASELINE_REQUIRED",
            "La organización administrativa necesita una migración IAM explícita de sus plazas antes de habilitar Equipo.",
          );
        if (
          plan.activeSeats !== null &&
          plan.activeSeats > definition.limits.maxSeats
        )
          error(
            409,
            "PLAN_SEATS_EXCEED_LIMIT",
            "Revoca colaboradores antes de reducir las plazas.",
          );
        if (typeof usageReader !== "function")
          error(
            503,
            "USAGE_UNAVAILABLE",
            "No se pudo comprobar el uso de eventos.",
          );
        const usage = await usageReader(org);
        if (
          !usage ||
          !Number.isSafeInteger(usage.nonArchivedCount) ||
          usage.nonArchivedCount < 0 ||
          (usage.version !== null &&
            (!Number.isSafeInteger(usage.version) || usage.version < 0))
        )
          error(
            503,
            "USAGE_UNAVAILABLE",
            "No se pudo comprobar el uso de eventos.",
          );
        if (
          definition.limits.maxActiveEvents !== null &&
          usage.nonArchivedCount > definition.limits.maxActiveEvents
        )
          error(
            409,
            "PLAN_USAGE_EXCEEDS_LIMIT",
            "El uso actual excede el límite del plan solicitado.",
          );
        const next = {
          ...plan,
          code: input.code,
          source: "manual",
          version: plan.version + 1,
          updatedAt: now(),
        };
        return {
          action: input.action,
          actor: operator,
          guards,
          puts: [{ key: accountKeys.plan(org), data: next }],
          externalConditions: usage.condition ? [usage.condition] : [],
          usageGuard: {
            organizationId: org,
            version: usage.version,
            nonArchivedCount: usage.nonArchivedCount,
          },
          result: { plan: publicPlan(next) },
        };
      }
      if (plan.code !== "team" || !plan.seatBaselineVerified || !plan.owner)
        error(
          403,
          "TEAM_PLAN_REQUIRED",
          "La organización necesita Equipo y una base de plazas verificada.",
        );
      if (targetHome.organizationId === org)
        error(
          409,
          "LEGACY_MEMBERSHIP_EXISTS",
          "La membresía base ya existe y debe conservarse.",
        );
      const roles = validateRoles(input.roles);
      const eventIds = eventScope(input.eventIds);
      const key = accountKeys.membership(input.userPoolId, input.subject, org);
      const previous = await repository.getItem(key);
      if (previous?.status === "active")
        error(
          409,
          "MEMBER_EXISTS",
          "La persona ya tiene acceso a la organización.",
        );
      if (plan.activeSeats >= getPlan(plan.code).limits.maxSeats)
        error(
          409,
          "SEAT_QUOTA_EXCEEDED",
          "Se alcanzó el límite de personas de Equipo.",
        );
      const member = {
        memberId: memberIdFor(input.userPoolId, input.subject),
        userPoolId: input.userPoolId,
        subject: input.subject,
        organizationId: org,
        roles,
        eventIds,
        status: "active",
        version: (previous?.version ?? 0) + 1,
        isOwner: false,
        source: "manual",
        updatedAt: now(),
      };
      const indexKey = accountKeys.member(org, member.memberId);
      const index = await repository.getItem(indexKey);
      const next = {
        ...plan,
        activeSeats: plan.activeSeats + 1,
        version: plan.version + 1,
        updatedAt: now(),
      };
      guards.push(snapshot(key, previous), snapshot(indexKey, index));
      return {
        action: input.action,
        actor: operator,
        target: member.memberId,
        guards,
        puts: [
          { key, data: member },
          { key: indexKey, data: member },
          { key: accountKeys.plan(org), data: next },
        ],
        result: { member: dto(member) },
      };
    });
  }
  async function changeMember(actor, memberId, input, revoke) {
    teamOwner(actor);
    validateId(memberId, "memberId");
    rejectUnknown(
      input,
      revoke
        ? ["operationId", "expectedVersion"]
        : ["operationId", "expectedVersion", "roles", "eventIds"],
    );
    if (memberId === memberIdFor(actor.userPoolId, actor.subject))
      error(
        403,
        "OWNER_MEMBERSHIP_PROTECTED",
        "La propiedad no puede modificarse desde esta operación.",
      );
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    )
      error(
        400,
        "INVALID_VERSION",
        "Indica la versión actual de la membresía.",
      );
    const action = revoke ? "revokeMember" : "changeRole";
    return mutateOperation(
      actor.organizationId,
      input.operationId,
      hash(
        canonical({
          ...input,
          memberId,
          action,
          actor: [actor.userPoolId, actor.subject],
        }),
      ),
      async () => {
        const indexKey = accountKeys.member(actor.organizationId, memberId);
        const index = await repository.getItem(indexKey);
        if (!index || index.isOwner)
          error(404, "MEMBER_NOT_FOUND", "No se encontró el colaborador.");
        const key = accountKeys.membership(
          index.userPoolId,
          index.subject,
          actor.organizationId,
        );
        const previous = await repository.getItem(key);
        if (!isDeepStrictEqual(previous, index))
          error(
            409,
            "VERSION_CONFLICT",
            "La membresía cambió. Actualiza antes de continuar.",
          );
        if (previous.version !== input.expectedVersion)
          error(
            409,
            "VERSION_CONFLICT",
            "La membresía cambió. Actualiza antes de continuar.",
          );
        const planGuard = actor.accessGuards.find(
          (guard) =>
            guard.key.pk === `ORG#${actor.organizationId}` &&
            guard.key.sk === "PLAN",
        );
        if (!planGuard?.data)
          error(503, "PLAN_INVALID", "No se pudo comprobar el plan actual.");
        const plan = planGuard.data;
        const member = {
          ...previous,
          ...(revoke
            ? { status: "revoked" }
            : {
                roles: validateRoles(input.roles),
                eventIds:
                  input.eventIds === undefined
                    ? previous.eventIds
                    : eventScope(input.eventIds),
              }),
          version: previous.version + 1,
          updatedAt: now(),
        };
        const activeSeats =
          plan.activeSeats - (revoke && previous.status === "active" ? 1 : 0);
        if (!Number.isSafeInteger(activeSeats) || activeSeats < 1)
          error(
            503,
            "SEAT_BASELINE_INVALID",
            "No se pudo comprobar el uso de plazas.",
          );
        const next = {
          ...plan,
          activeSeats,
          version: plan.version + 1,
          updatedAt: now(),
        };
        return {
          action,
          actor: { userPoolId: actor.userPoolId, subject: actor.subject },
          target: memberId,
          guards: [
            ...actor.accessGuards,
            snapshot(key, previous),
            snapshot(indexKey, index),
          ],
          puts: [
            { key, data: member },
            { key: indexKey, data: member },
            { key: accountKeys.plan(actor.organizationId), data: next },
          ],
          result: { member: dto(member) },
        };
      },
    );
  }
  return {
    resolve,
    me,
    members,
    admin,
    updateMember: (actor, memberId, input) =>
      changeMember(actor, memberId, input, false),
    revokeMember: (actor, memberId, input) =>
      changeMember(actor, memberId, input, true),
  };
}
