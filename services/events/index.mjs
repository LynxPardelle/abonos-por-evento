import { createHash, randomUUID } from 'node:crypto';
import { authorize } from '../shared/auth.mjs';
import {
  DomainError,
  handleError,
  json,
  parseBody,
  requestPath,
  validateId,
} from '../shared/http.mjs';
import { DynamoEventsRepository } from './repository.mjs';

const currencyCodes = new Set(['MXN', 'USD', 'EUR']);

function text(value, field, maximum) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DomainError(400, 'INVALID_FIELD', `${field} no es válido.`);
  }
  return value.trim();
}

function rejectUnknown(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new DomainError(400, 'INVALID_FIELD', 'La solicitud contiene campos no admitidos.');
  }
}

function identifier(body, field, organizationId, scope = '') {
  if (body.operationId !== undefined) validateId(body.operationId, 'operationId');
  if (body[field] !== undefined) return validateId(body[field], field);
  if (body.operationId)
    return `${field === 'eventId' ? 'evt' : 'person'}-${createHash('sha256')
      .update(JSON.stringify([organizationId, scope, body.operationId]))
      .digest('hex')
      .slice(0, 32)}`;
  return randomUUID();
}

function conflictIfChanged(result, candidate, fields) {
  if (!result.created && fields.some((field) => result.value[field] !== candidate[field])) {
    throw new DomainError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'El identificador ya pertenece a una solicitud diferente.',
    );
  }
}

const pilotAccess = async (request, roles) => ({
  ...authorize(request, roles),
  eventIds: null,
  plan: { code: 'pilot' },
  limits: { maxActiveEvents: null },
  capabilities: { manageTemplates: false },
  accessGuards: [],
});
const visible = (actor, eventId) =>
  !Array.isArray(actor?.eventIds) || actor.eventIds.includes(eventId);
const requireRevision = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new DomainError(
      400,
      'INVALID_VERSION',
      `${label} debe ser un entero mayor o igual a ${minimum}.`,
    );
  return value;
};
const templatesAllowed = (actor) => {
  if (!actor.capabilities?.manageTemplates)
    throw new DomainError(
      403,
      'CAPABILITY_REQUIRED',
      'Tu plan no permite crear o aplicar plantillas. El historial sigue disponible.',
    );
};

export function createEventsHandler({ repository, accessResolver = pilotAccess }) {
  if (!repository) throw new Error('repository is required');

  async function getEvent(organizationId, eventId, actor) {
    if (!visible(actor, eventId))
      throw new DomainError(404, 'EVENT_NOT_FOUND', 'No se encontró el evento.');
    const event = await repository.getEvent({ organizationId, eventId });
    if (!event) throw new DomainError(404, 'EVENT_NOT_FOUND', 'No se encontró el evento.');
    return { ...event, revision: event.revision ?? 0 };
  }

  return async function eventsHandler(request) {
    try {
      if (request?.internal !== undefined) {
        if (
          request.requestContext !== undefined ||
          request.rawPath !== undefined ||
          request.body !== undefined ||
          request.headers !== undefined
        ) {
          throw new DomainError(
            400,
            'INVALID_INTERNAL_REQUEST',
            'La solicitud interna no es válida.',
          );
        }
        const internal = request.internal;
        if (
          !internal ||
          ![
            'getEvent',
            'getUsage',
            'listEventsforOverview',
            'archiveEvent',
            'beginReopen',
            'finalizeReopen',
          ].includes(internal.action)
        )
          throw new DomainError(400, 'INVALID_INTERNAL_REQUEST', 'La acción interna no es válida.');
        const organizationId = validateId(internal.organizationId, 'organizationId');
        if (internal.action === 'getUsage') return repository.getUsage({ organizationId });
        if (internal.actor && internal.actor.organizationId !== organizationId)
          throw new DomainError(
            403,
            'FORBIDDEN',
            'La organización de la operación no corresponde al acceso.',
          );
        if (internal.action === 'listEventsforOverview') {
          if (!internal.actor)
            throw new DomainError(403, 'FORBIDDEN', 'La operación necesita un acceso resuelto.');
          return {
            events: (await repository.listEvents({ organizationId }))
              .filter((event) => visible(internal.actor, event.eventId))
              .map((event) => ({ ...event, revision: event.revision ?? 0 })),
            usage: await repository.getUsage({ organizationId }),
          };
        }
        const eventId = validateId(internal.eventId, 'eventId');
        await getEvent(organizationId, eventId, internal.actor);
        if (internal.action === 'getEvent')
          return repository.getContext({ organizationId, eventId });
        const actor = internal.actor;
        if (
          !actor ||
          !Array.isArray(actor.roles) ||
          !actor.roles.some((role) => ['admin', 'operator', 'confirmer'].includes(role))
        )
          throw new DomainError(
            403,
            'FORBIDDEN',
            'La operación necesita permisos para gestionar el cierre.',
          );
        const input = { operationId: validateId(internal.operationId, 'operationId') };
        if (internal.action === 'finalizeReopen')
          input.lifecycleVersion = requireRevision(
            internal.lifecycleVersion,
            'lifecycleVersion',
            1,
          );
        else {
          input.expectedEventRevision = requireRevision(
            internal.expectedEventRevision,
            'expectedEventRevision',
          );
          input.closureId = validateId(internal.closureId, 'closureId');
          if (internal.action === 'archiveEvent')
            input.closureVersion = requireRevision(internal.closureVersion, 'closureVersion', 1);
        }
        return {
          event: await repository[internal.action]({ organizationId, eventId }, input, { actor }),
        };
      }

      const method = request?.requestContext?.http?.method;
      const path = requestPath(request);
      const routeEvent = /^\/api\/v1\/events\/([^/]+)/.exec(path);
      const identity = await accessResolver(
        request,
        method === 'GET' ? ['auditor'] : ['operator'],
        { ...(routeEvent ? { eventId: routeEvent[1] } : {}) },
      );
      const { organizationId } = identity;
      if (path === '/api/v1/events') {
        if (method === 'GET')
          return json(200, {
            events: (await repository.listEvents({ organizationId }))
              .filter((event) => visible(identity, event.eventId))
              .map((event) => ({ ...event, revision: event.revision ?? 0 })),
            usage: {
              ...(await repository.getUsage({ organizationId })),
              limit: identity.limits?.maxActiveEvents ?? null,
            },
          });
        if (method === 'POST') {
          const body = parseBody(request);
          rejectUnknown(body, ['eventId', 'operationId', 'name', 'currency']);
          const currency = body.currency;
          if (
            typeof currency !== 'string' ||
            !/^[A-Z]{3}$/.test(currency) ||
            !currencyCodes.has(currency)
          ) {
            throw new DomainError(
              400,
              'INVALID_CURRENCY',
              'La primera versión admite MXN, USD o EUR, con dos decimales.',
            );
          }
          const event = {
            eventId: identifier(body, 'eventId', organizationId),
            organizationId,
            name: text(body.name, 'name', 160),
            currency,
            createdAt: new Date().toISOString(),
          };
          const result = await repository.insertEvent(event, {
            actor: identity,
            operationId: body.operationId,
          });
          conflictIfChanged(result, event, ['name', 'currency']);
          return json(result.created ? 201 : 200, { event: result.value });
        }
      }

      const templateRoute = /^\/api\/v1\/templates(?:\/([^/]+))?(\/events)?$/.exec(path);
      if (templateRoute) {
        const templateId = templateRoute[1] && validateId(templateRoute[1], 'templateId');
        if (method === 'GET' && !templateId)
          return json(200, {
            templates: (await repository.listTemplates({ organizationId })).filter((template) =>
              visible(identity, template.sourceEventId),
            ),
          });
        let template;
        if (templateId) {
          template = await repository.getTemplate({ organizationId, templateId });
          if (!template || !visible(identity, template.sourceEventId))
            throw new DomainError(404, 'TEMPLATE_NOT_FOUND', 'No se encontró la plantilla.');
        }
        if (method === 'GET' && templateId && !templateRoute[2]) return json(200, { template });
        if (method === 'POST' && !templateId) {
          templatesAllowed(identity);
          const input = parseBody(request);
          rejectUnknown(input, ['operationId', 'name', 'sourceEventId']);
          validateId(input.operationId, 'operationId');
          const sourceEventId = validateId(input.sourceEventId, 'sourceEventId');
          await getEvent(organizationId, sourceEventId, identity);
          const context = await repository.getContext({ organizationId, eventId: sourceEventId });
          if (context.participants.length > 90)
            throw new DomainError(
              413,
              'TEMPLATE_TOO_LARGE',
              'Una plantilla admite hasta 90 participantes por su límite técnico de transacción.',
            );
          const candidate = {
            templateId: `tpl-${createHash('sha256')
              .update(JSON.stringify([organizationId, input.operationId]))
              .digest('hex')
              .slice(0, 32)}`,
            organizationId,
            name: text(input.name, 'name', 160),
            currency: context.event.currency,
            version: 1,
            participantCount: context.participants.length,
            participants: context.participants.map((person) => ({
              name: person.name,
              reference: person.reference,
              agreedMinor: person.agreedMinor,
            })),
            sourceEventId,
            sourceEventRevision: context.event.revision,
            createdAt: new Date().toISOString(),
            createdBy: identity.subject,
          };
          const result = await repository.createTemplate(candidate, { actor: identity });
          return json(result.created ? 201 : 200, { template: result.value });
        }
        if (method === 'POST' && templateId && templateRoute[2]) {
          templatesAllowed(identity);
          const input = parseBody(request);
          rejectUnknown(input, ['operationId', 'name', 'expectedTemplateVersion']);
          validateId(input.operationId, 'operationId');
          if (
            requireRevision(input.expectedTemplateVersion, 'expectedTemplateVersion') !==
            template.version
          )
            throw new DomainError(
              409,
              'TEMPLATE_VERSION_CONFLICT',
              'La plantilla cambió. Actualiza antes de aplicarla.',
            );
          if (template.participants.length > 90)
            throw new DomainError(
              413,
              'TEMPLATE_TOO_LARGE',
              'Una plantilla admite hasta 90 participantes.',
            );
          const event = {
            eventId: identifier(input, 'eventId', organizationId, templateId),
            organizationId,
            name: text(input.name, 'name', 160),
            currency: template.currency,
            createdAt: new Date().toISOString(),
            templateId,
            templateVersion: template.version,
          };
          const participants = template.participants.map((person, index) => ({
            ...person,
            participantId: `person-${createHash('sha256')
              .update(JSON.stringify([event.eventId, index]))
              .digest('hex')
              .slice(0, 32)}`,
            organizationId,
            eventId: event.eventId,
            currency: event.currency,
            createdAt: event.createdAt,
          }));
          const result = await repository.insertEvent(event, {
            actor: identity,
            participants,
            template,
            operationId: input.operationId,
          });
          conflictIfChanged(result, event, ['name', 'currency', 'templateId', 'templateVersion']);
          return json(result.created ? 201 : 200, { event: result.value });
        }
      }

      const match = /^\/api\/v1\/events\/([^/]+)(\/participants)?$/.exec(path ?? '');
      if (match) {
        const eventId = validateId(match[1], 'eventId');
        const event = await getEvent(organizationId, eventId, identity);
        if (!match[2] && method === 'GET') return json(200, { event });
        if (match[2] && method === 'GET')
          return json(200, {
            participants: await repository.listParticipants({ organizationId, eventId }),
          });
        if (match[2] && method === 'POST') {
          const body = parseBody(request);
          rejectUnknown(body, ['participantId', 'operationId', 'name', 'reference', 'agreedMinor']);
          if (
            typeof body.agreedMinor !== 'string' ||
            !/^[1-9][0-9]{0,29}$/.test(body.agreedMinor)
          ) {
            throw new DomainError(
              400,
              'INVALID_AMOUNT',
              'agreedMinor debe ser una cadena de entero positivo en unidades menores.',
            );
          }
          const participant = {
            participantId: identifier(body, 'participantId', organizationId, eventId),
            organizationId,
            eventId,
            name: text(body.name, 'name', 160),
            reference: text(body.reference, 'reference', 120),
            agreedMinor: body.agreedMinor,
            currency: event.currency,
            createdAt: new Date().toISOString(),
          };
          const result = await repository.insertParticipant(participant, { actor: identity });
          conflictIfChanged(result, participant, ['name', 'reference', 'agreedMinor', 'currency']);
          return json(result.created ? 201 : 200, { participant: result.value });
        }
      }
      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No se encontró la ruta.');
    } catch (error) {
      return handleError(error);
    }
  };
}

let defaultHandler;
export async function handler(event) {
  try {
    if (!defaultHandler) {
      const { resolveAccess, buildAccessConditions } = await import('../shared/access.mjs');
      defaultHandler = createEventsHandler({
        repository: new DynamoEventsRepository({
          tableName: process.env.EVENTS_TABLE,
          accessConditions: buildAccessConditions,
        }),
        accessResolver: resolveAccess,
      });
    }
    return await defaultHandler(event);
  } catch (error) {
    return handleError(error);
  }
}
