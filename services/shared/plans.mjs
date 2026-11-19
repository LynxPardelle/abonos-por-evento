import { DomainError } from "./http.mjs";

export const PLAN_CATALOG_VERSION = "2026-11-19.v1";
const entry = (code, name, maxActiveEvents, maxSeats, features) =>
  Object.freeze({
    code,
    name,
    catalogVersion: PLAN_CATALOG_VERSION,
    billingEnabled: false,
    limits: Object.freeze({ maxActiveEvents, maxSeats }),
    features: Object.freeze(features),
  });
export const PLAN_CATALOG = Object.freeze({
  pilot: entry("pilot", "Piloto", null, 1, {
    closeEvent: false,
    exportEvent: false,
    manageTemplates: false,
    viewOverview: false,
    manageTeam: false,
  }),
  event: entry("event", "Por Evento", 1, 1, {
    closeEvent: true,
    exportEvent: true,
    manageTemplates: false,
    viewOverview: false,
    manageTeam: false,
  }),
  organizer: entry("organizer", "Organizador", 5, 1, {
    closeEvent: true,
    exportEvent: true,
    manageTemplates: true,
    viewOverview: true,
    manageTeam: false,
  }),
  team: entry("team", "Equipo", 20, 5, {
    closeEvent: true,
    exportEvent: true,
    manageTemplates: true,
    viewOverview: true,
    manageTeam: true,
  }),
});
export function getPlan(code) {
  if (!Object.hasOwn(PLAN_CATALOG, code ?? ""))
    throw new DomainError(
      400,
      "INVALID_PLAN",
      "El plan no pertenece al catálogo vigente.",
    );
  return PLAN_CATALOG[code];
}
export function hasRole(roles, required = []) {
  const effective = new Set(roles);
  if (effective.has("admin")) return true;
  if (effective.has("operator"))
    ["importer", "confirmer", "auditor"].forEach((role) => effective.add(role));
  if (effective.has("importer") || effective.has("confirmer"))
    effective.add("auditor");
  return required.length === 0 || required.some((role) => effective.has(role));
}
export function capabilitiesFor({
  roles,
  isOwner,
  eventIds,
  plan,
  seatBaselineVerified = false,
}) {
  const definition = getPlan(plan.code ?? plan);
  const scoped = Array.isArray(eventIds);
  const operate = hasRole(roles, ["operator"]);
  const read = hasRole(roles, ["auditor"]);
  return {
    createEvent: !scoped && operate,
    manageParticipants: operate,
    importPayments: hasRole(roles, ["importer"]),
    confirmPayments: hasRole(roles, ["confirmer"]),
    reversePayments: hasRole(roles, ["confirmer"]),
    closeEvent: definition.features.closeEvent && operate,
    exportEvent: definition.features.exportEvent && read,
    manageTemplates: definition.features.manageTemplates && !scoped && operate,
    viewOverview: definition.features.viewOverview && !scoped && read,
    manageTeam:
      definition.features.manageTeam &&
      isOwner &&
      seatBaselineVerified &&
      !scoped,
  };
}
