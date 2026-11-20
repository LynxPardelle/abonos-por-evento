import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DomainError } from '../shared/http.mjs';
const eventKey = (org, id) => ({ pk: `ORG#${org}`, sk: `EVENT#${id}` });
const participantKey = (org, event, id) => ({
  pk: `ORG#${org}#EVENT#${event}`,
  sk: `PARTICIPANT#${id}`,
});
const usageKey = (org) => ({ pk: `ORG#${org}`, sk: 'USAGE#EVENTS' });
const templateKey = (org, id) => ({ pk: `ORG#${org}`, sk: `TEMPLATE#${id}` });
const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = (event) => event.revision ?? 0;
const fail = (code, message, status = 409) => {
  throw new DomainError(status, code, message);
};
class Retry extends Error {}
const put = (key, data, expected) => ({
  key,
  item: { ...key, data, ...(data.revision !== undefined ? { version: data.revision } : {}) },
  expected,
});
const matches = (item, expected) =>
  expected === null ? item === undefined : item !== undefined && (item.version ?? 0) === expected;
const active = (event) => {
  if (event.archivedAt)
    fail('EVENT_ARCHIVED', 'El evento está archivado. Desarchívalo antes de modificarlo.');
  if (event.reopening)
    fail('EVENT_TRANSITION_PENDING', 'La reapertura está pendiente. Reintenta la misma operación.');
};
const assertActor = (scope, actor) => {
  if (
    actor &&
    (actor.organizationId !== scope.organizationId ||
      (Array.isArray(actor.eventIds) && scope.eventId && !actor.eventIds.includes(scope.eventId)))
  )
    fail('EVENT_NOT_FOUND', 'No se encontró el evento.', 404);
};
class EventsRepository {
  async getEvent({ organizationId, eventId }) {
    return (await this._get(eventKey(organizationId, eventId)))?.data ?? null;
  }
  async listEvents({ organizationId }) {
    return (await this._query(`ORG#${organizationId}`, 'EVENT#'))
      .map((item) => copy(item.data))
      .sort((a, b) => a.eventId.localeCompare(b.eventId));
  }
  async listParticipants({ organizationId, eventId }) {
    return (await this._query(`ORG#${organizationId}#EVENT#${eventId}`, 'PARTICIPANT#'))
      .map((item) => copy(item.data))
      .sort((a, b) => a.participantId.localeCompare(b.participantId));
  }
  async getContext(scope) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.getEvent(scope);
      if (!before) fail('EVENT_NOT_FOUND', 'No se encontró el evento.', 404);
      const participants = await this.listParticipants(scope);
      const after = await this.getEvent(scope);
      if (after && revision(before) === revision(after))
        return { event: { ...after, revision: revision(after) }, participants };
    }
    fail(
      'EVENT_VERSION_CONFLICT',
      'La lista de participantes cambió. Actualiza e intenta otra vez.',
    );
  }
  async getUsage({ organizationId }) {
    const item = await this._get(usageKey(organizationId));
    const count =
      item?.nonArchivedCount ??
      (await this.listEvents({ organizationId })).filter((event) => !event.archivedAt).length;
    return { nonArchivedEvents: count, nonArchivedCount: count, version: item?.version ?? null };
  }
  async _usageWrite(org, delta, actor) {
    const usage = await this.getUsage({ organizationId: org });
    const next = usage.nonArchivedCount + delta;
    const limit = actor?.limits?.maxActiveEvents ?? null;
    if (delta > 0 && limit !== null && next > limit)
      fail(
        'EVENT_LIMIT_REACHED',
        'Alcanzaste el cupo de eventos no archivados. Archiva un cierre o solicita otro plan.',
      );
    if (next < 0) fail('USAGE_CONFLICT', 'El uso de eventos necesita actualizarse.');
    return {
      key: usageKey(org),
      expected: usage.version,
      item: { ...usageKey(org), version: (usage.version ?? 0) + 1, nonArchivedCount: next },
    };
  }
  async _retry(action) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof Retry)) throw error;
      }
    }
    fail('EVENT_VERSION_CONFLICT', 'El evento o su cupo cambió. Actualiza e intenta otra vez.');
  }
  async insertEvent(event, options = {}) {
    if (!options.actor)
      return this._legacyInsert(eventKey(event.organizationId, event.eventId), event);
    const { actor, participants = [], template, operationId } = options;
    assertActor(event, actor);
    const semantic = (value) => ({
      eventId: value.eventId,
      name: value.name,
      currency: value.currency,
      templateId: value.templateId,
      templateVersion: value.templateVersion,
    });
    const signature = hash(semantic(event));
    const operationKey = operationId
      ? { pk: `ORG#${event.organizationId}`, sk: `CREATE_EVENT#${hash(operationId)}` }
      : null;
    return this._retry(async () => {
      if (operationKey) {
        const prior = (await this._get(operationKey))?.data;
        if (prior) {
          if (prior.signature !== signature)
            fail('IDEMPOTENCY_CONFLICT', 'La operación ya pertenece a otra solicitud.');
          return { created: false, value: copy(prior.event) };
        }
      }
      const existing = await this.getEvent(event);
      if (existing) {
        if (operationKey && hash(semantic(existing)) === signature)
          await this._commit([put(operationKey, { signature, event: existing }, null)], actor, [
            { key: eventKey(event.organizationId, event.eventId), expected: revision(existing) },
          ]);
        return { created: false, value: existing };
      }
      const value = { ...event, revision: 1 };
      const writes = [
        put(eventKey(event.organizationId, event.eventId), value, null),
        await this._usageWrite(event.organizationId, 1, actor),
      ];
      for (const person of participants)
        writes.push(
          put(
            participantKey(event.organizationId, event.eventId, person.participantId),
            person,
            null,
          ),
        );
      if (operationKey) writes.push(put(operationKey, { signature, event: value }, null));
      const checks = template
        ? [
            {
              key: templateKey(event.organizationId, template.templateId),
              expected: template.version,
            },
          ]
        : [];
      await this._commit(writes, actor, checks);
      return { created: true, value };
    });
  }
  async insertParticipant(participant, options = {}) {
    if (!options.actor)
      return this._legacyInsert(
        participantKey(participant.organizationId, participant.eventId, participant.participantId),
        participant,
      );
    const { actor } = options;
    assertActor(participant, actor);
    return this._retry(async () => {
      const key = participantKey(
        participant.organizationId,
        participant.eventId,
        participant.participantId,
      );
      const previous = await this._get(key);
      if (previous) return { created: false, value: copy(previous.data) };
      const event = await this.getEvent(participant);
      if (!event) fail('EVENT_NOT_FOUND', 'No se encontró el evento.', 404);
      active(event);
      const next = { ...event, revision: revision(event) + 1 };
      await this._commit(
        [
          put(key, participant, null),
          put(eventKey(event.organizationId, event.eventId), next, revision(event)),
        ],
        actor,
      );
      return { created: true, value: participant };
    });
  }
  async _transition(scope, kind, input, { actor } = {}) {
    assertActor(scope, actor);
    const key = {
      pk: `ORG#${scope.organizationId}#EVENT#${scope.eventId}`,
      sk: `OP#${kind}#${hash(input.operationId)}`,
    };
    const signature = hash(input);
    return this._retry(async () => {
      const prior = (await this._get(key))?.data;
      if (prior) {
        if (prior.signature !== signature)
          fail('IDEMPOTENCY_CONFLICT', 'La operación ya pertenece a otra solicitud.');
        return copy(prior.event);
      }
      const event = await this.getEvent(scope);
      if (!event) fail('EVENT_NOT_FOUND', 'No se encontró el evento.', 404);
      const next = { ...event, revision: revision(event) + 1 };
      const writes = [];
      if (kind === 'FINALIZE_REOPEN') {
        if (!event.reopening || event.reopening.operationId !== input.operationId)
          fail('EVENT_TRANSITION_CONFLICT', 'No existe esa reserva de reapertura.');
        delete next.reopening;
        next.lastReopenLifecycleVersion = input.lifecycleVersion;
      } else {
        if (event.reopening)
          fail(
            'EVENT_TRANSITION_PENDING',
            'La reapertura está pendiente. Reintenta la misma operación.',
          );
        if (revision(event) !== input.expectedEventRevision)
          fail('EVENT_VERSION_CONFLICT', 'El evento cambió. Actualiza antes de continuar.');
        if (kind === 'ARCHIVE') {
          if (event.archivedAt) fail('EVENT_ALREADY_ARCHIVED', 'El evento ya está archivado.');
          next.archivedAt = new Date().toISOString();
          next.archiveClosureId = input.closureId;
          next.archiveClosureVersion = input.closureVersion;
          writes.push(await this._usageWrite(scope.organizationId, -1, actor));
        } else {
          if (event.archivedAt && event.archiveClosureId !== input.closureId)
            fail('CLOSURE_CONFLICT', 'El cierre no corresponde al archivo.');
          if (event.archivedAt) writes.push(await this._usageWrite(scope.organizationId, 1, actor));
          delete next.archivedAt;
          delete next.archiveClosureId;
          delete next.archiveClosureVersion;
          next.reopening = {
            kind: 'reopening',
            operationId: input.operationId,
            closureId: input.closureId,
          };
        }
      }
      writes.push(
        put(eventKey(scope.organizationId, scope.eventId), next, revision(event)),
        put(key, { signature, event: next }, null),
      );
      await this._commit(writes, actor);
      return next;
    });
  }
  async archiveEvent(scope, input, options) {
    return this._transition(scope, 'ARCHIVE', input, options);
  }
  async beginReopen(scope, input, options) {
    return this._transition(scope, 'BEGIN_REOPEN', input, options);
  }
  async finalizeReopen(scope, input, options) {
    return this._transition(scope, 'FINALIZE_REOPEN', input, options);
  }
  async listTemplates({ organizationId }) {
    return (await this._query(`ORG#${organizationId}`, 'TEMPLATE#')).map((item) => copy(item.data));
  }
  async getTemplate({ organizationId, templateId }) {
    return (await this._get(templateKey(organizationId, templateId)))?.data ?? null;
  }
  async createTemplate(template, { actor } = {}) {
    return this._retry(async () => {
      const key = templateKey(template.organizationId, template.templateId);
      const prior = (await this._get(key))?.data;
      if (prior) {
        if (prior.name !== template.name || prior.sourceEventId !== template.sourceEventId)
          fail('IDEMPOTENCY_CONFLICT', 'La operación ya pertenece a otra plantilla.');
        return { created: false, value: prior };
      }
      if (Buffer.byteLength(JSON.stringify(template)) > 300000)
        fail(
          'TEMPLATE_TOO_LARGE',
          'La plantilla supera el límite técnico. Usa una lista más pequeña.',
          413,
        );
      await this._commit(
        [{ key, expected: null, item: { ...key, version: template.version, data: template } }],
        actor,
      );
      return { created: true, value: template };
    });
  }
}
export class MemoryEventsRepository extends EventsRepository {
  #items = new Map();
  constructor({ validateAccess } = {}) {
    super();
    this.validateAccess = validateAccess;
  }
  _key(key) {
    return JSON.stringify([key.pk, key.sk]);
  }
  async _get(key) {
    return copy(this.#items.get(this._key(key)));
  }
  async _query(pk, prefix) {
    return copy(
      [...this.#items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix)),
    );
  }
  async _legacyInsert(key, data) {
    const prior = await this._get(key);
    if (prior) return { created: false, value: prior.data };
    this.#items.set(this._key(key), { ...key, data: copy(data) });
    return { created: true, value: copy(data) };
  }
  getUsageSync({ organizationId }) {
    const usage = this.#items.get(this._key(usageKey(organizationId)));
    const count =
      usage?.nonArchivedCount ??
      [...this.#items.values()].filter(
        (item) =>
          item.pk === `ORG#${organizationId}` &&
          item.sk.startsWith('EVENT#') &&
          !item.data.archivedAt,
      ).length;
    return { nonArchivedEvents: count, nonArchivedCount: count, version: usage?.version ?? null };
  }
  assertUsageGuardSync({ organizationId, version, nonArchivedCount, nonArchivedEvents }) {
    const current = this.getUsageSync({ organizationId });
    if (
      current.version !== version ||
      current.nonArchivedCount !== (nonArchivedCount ?? nonArchivedEvents)
    )
      fail('USAGE_CHANGED', 'El uso de eventos cambió. Vuelve a revisar el plan.');
  }
  async _commit(writes, actor, checks = []) {
    if (this.validateAccess) {
      const validated = this.validateAccess(actor);
      if (validated?.then) throw new Error('Memory validateAccess must be synchronous.');
    } else if (actor?.accessGuards?.length)
      fail('ACCESS_CHANGED', 'No se pueden comprobar los permisos vigentes.');
    // No await between compare and apply: this memory transaction is atomic.
    for (const entry of [...checks, ...writes])
      if (!matches(this.#items.get(this._key(entry.key)), entry.expected)) throw new Retry();
    for (const entry of writes) this.#items.set(this._key(entry.key), copy(entry.item));
  }
}
function condition(expected) {
  if (expected === null) return { ConditionExpression: 'attribute_not_exists(pk)' };
  return {
    ConditionExpression:
      expected === 0
        ? 'attribute_exists(pk) AND (attribute_not_exists(#version) OR #version = :version)'
        : '#version = :version',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':version': expected },
  };
}
export class DynamoEventsRepository extends EventsRepository {
  constructor({
    tableName,
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    accessConditions,
  } = {}) {
    super();
    if (!tableName) throw new Error('EVENTS_TABLE is required');
    this.tableName = tableName;
    this.client = client;
    this.accessConditions = accessConditions;
  }
  async _get(key) {
    return (
      await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
      )
    ).Item;
  }
  async _query(pk, prefix) {
    const items = [];
    let cursor;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...(response.Items ?? []));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async _legacyInsert(key, data) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, data },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { created: true, value: data };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const prior = await this._get(key);
      if (!prior?.data) throw error;
      return { created: false, value: prior.data };
    }
  }
  async _commit(writes, actor, checks = []) {
    if (actor?.accessGuards?.length && !this.accessConditions)
      fail('ACCESS_CHANGED', 'No se pueden comprobar los permisos vigentes.');
    const guards = this.accessConditions ? this.accessConditions(actor) : [];
    const entries = [
      ...guards,
      ...checks.map((entry) => ({
        ConditionCheck: { TableName: this.tableName, Key: entry.key, ...condition(entry.expected) },
      })),
      ...writes.map((entry) => ({
        Put: { TableName: this.tableName, Item: entry.item, ...condition(entry.expected) },
      })),
    ];
    if (entries.length > 100)
      fail('TEMPLATE_TOO_LARGE', 'La operación supera el límite técnico de la transacción.', 413);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: entries }));
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      if (
        error.CancellationReasons?.slice(0, guards.length).some(
          (reason) => reason.Code === 'ConditionalCheckFailed',
        )
      )
        fail('ACCESS_CHANGED', 'Los permisos o el plan cambiaron. Actualiza antes de continuar.');
      throw new Retry();
    }
  }
}
