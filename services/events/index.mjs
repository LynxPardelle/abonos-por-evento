import { createHash, randomUUID } from 'node:crypto';
import { authorize } from '../shared/auth.mjs';
import { DomainError, handleError, json, parseBody, requestPath, validateId } from '../shared/http.mjs';
import { DynamoEventsRepository } from './repository.mjs';

const currencyCodes = new Set(['MXN', 'USD', 'EUR']);

function text(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
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
  if (body.operationId) return `${field === 'eventId' ? 'evt' : 'person'}-${createHash('sha256').update(JSON.stringify([organizationId, scope, body.operationId])).digest('hex').slice(0, 32)}`;
  return randomUUID();
}

function conflictIfChanged(result, candidate, fields) {
  if (!result.created && fields.some((field) => result.value[field] !== candidate[field])) {
    throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'El identificador ya pertenece a una solicitud diferente.');
  }
}

export function createEventsHandler({ repository }) {
  if (!repository) throw new Error('repository is required');

  async function getEvent(organizationId, eventId) {
    const event = await repository.getEvent({ organizationId, eventId });
    if (!event) throw new DomainError(404, 'EVENT_NOT_FOUND', 'No se encontró el evento.');
    return event;
  }

  return async function eventsHandler(request) {
    try {
      if (request?.internal !== undefined) {
        if (request.requestContext !== undefined || request.rawPath !== undefined || request.body !== undefined || request.headers !== undefined) {
          throw new DomainError(400, 'INVALID_INTERNAL_REQUEST', 'La solicitud interna no es válida.');
        }
        const internal = request.internal;
        if (!internal || internal.action !== 'getEvent') throw new DomainError(400, 'INVALID_INTERNAL_REQUEST', 'La acción interna no es válida.');
        const organizationId = validateId(internal.organizationId, 'organizationId');
        const eventId = validateId(internal.eventId, 'eventId');
        const event = await getEvent(organizationId, eventId);
        const participants = await repository.listParticipants({ organizationId, eventId });
        return { event, participants };
      }

      const method = request?.requestContext?.http?.method;
      const path = requestPath(request);
      const identity = authorize(request, method === 'GET' ? ['auditor'] : ['operator']);
      const { organizationId } = identity;
      if (path === '/api/v1/events') {
        if (method === 'GET') return json(200, { events: await repository.listEvents({ organizationId }) });
        if (method === 'POST') {
          const body = parseBody(request);
          rejectUnknown(body, ['eventId', 'operationId', 'name', 'currency']);
          const currency = body.currency;
          if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !currencyCodes.has(currency)) {
            throw new DomainError(400, 'INVALID_CURRENCY', 'La primera versión admite MXN, USD o EUR, con dos decimales.');
          }
          const event = { eventId: identifier(body, 'eventId', organizationId), organizationId, name: text(body.name, 'name', 160), currency, createdAt: new Date().toISOString() };
          const result = await repository.insertEvent(event);
          conflictIfChanged(result, event, ['name', 'currency']);
          return json(result.created ? 201 : 200, { event: result.value });
        }
      }

      const match = /^\/api\/v1\/events\/([^/]+)(\/participants)?$/.exec(path ?? '');
      if (match) {
        const eventId = validateId(match[1], 'eventId');
        const event = await getEvent(organizationId, eventId);
        if (!match[2] && method === 'GET') return json(200, { event });
        if (match[2] && method === 'GET') return json(200, { participants: await repository.listParticipants({ organizationId, eventId }) });
        if (match[2] && method === 'POST') {
          const body = parseBody(request);
          rejectUnknown(body, ['participantId', 'operationId', 'name', 'reference', 'agreedMinor']);
          if (typeof body.agreedMinor !== 'string' || !/^[1-9][0-9]{0,29}$/.test(body.agreedMinor)) {
            throw new DomainError(400, 'INVALID_AMOUNT', 'agreedMinor debe ser una cadena de entero positivo en unidades menores.');
          }
          const participant = {
            participantId: identifier(body, 'participantId', organizationId, eventId), organizationId, eventId,
            name: text(body.name, 'name', 160), reference: text(body.reference, 'reference', 120),
            agreedMinor: body.agreedMinor, currency: event.currency, createdAt: new Date().toISOString(),
          };
          const result = await repository.insertParticipant(participant);
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
    defaultHandler ??= createEventsHandler({ repository: new DynamoEventsRepository({ tableName: process.env.EVENTS_TABLE }) });
    return await defaultHandler(event);
  } catch (error) {
    return handleError(error);
  }
}
