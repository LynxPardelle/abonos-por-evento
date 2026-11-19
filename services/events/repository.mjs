import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const eventKey = (organizationId, eventId) => ({ pk: `ORG#${organizationId}`, sk: `EVENT#${eventId}` });
const participantKey = (organizationId, eventId, participantId) => ({ pk: `ORG#${organizationId}#EVENT#${eventId}`, sk: `PARTICIPANT#${participantId}` });
const memoryKey = (key) => JSON.stringify([key.pk, key.sk]);

export class MemoryEventsRepository {
  #items = new Map();

  async getEvent({ organizationId, eventId }) {
    return structuredClone(this.#items.get(memoryKey(eventKey(organizationId, eventId)))) ?? null;
  }

  async listEvents({ organizationId }) {
    return structuredClone([...this.#items.values()].filter((item) => item.organizationId === organizationId && item.participantId === undefined).sort((a, b) => a.eventId.localeCompare(b.eventId)));
  }

  async insertEvent(event) {
    return this.#insert(eventKey(event.organizationId, event.eventId), event);
  }

  async listParticipants({ organizationId, eventId }) {
    return structuredClone([...this.#items.values()].filter((item) => item.organizationId === organizationId && item.eventId === eventId && item.participantId !== undefined).sort((a, b) => a.participantId.localeCompare(b.participantId)));
  }

  async insertParticipant(participant) {
    return this.#insert(participantKey(participant.organizationId, participant.eventId, participant.participantId), participant);
  }

  #insert(key, item) {
    const encoded = memoryKey(key);
    if (this.#items.has(encoded)) return { created: false, value: structuredClone(this.#items.get(encoded)) };
    this.#items.set(encoded, structuredClone(item));
    return { created: true, value: structuredClone(item) };
  }
}

export class DynamoEventsRepository {
  constructor({ tableName, client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }) }) {
    if (!tableName) throw new Error('EVENTS_TABLE is required');
    this.tableName = tableName;
    this.client = client;
  }

  async getEvent({ organizationId, eventId }) {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: eventKey(organizationId, eventId), ConsistentRead: true }));
    return response.Item?.data ?? null;
  }

  async listEvents({ organizationId }) {
    return this.#query(`ORG#${organizationId}`, 'EVENT#');
  }

  async insertEvent(event) {
    return this.#insert(eventKey(event.organizationId, event.eventId), event);
  }

  async listParticipants({ organizationId, eventId }) {
    return this.#query(`ORG#${organizationId}#EVENT#${eventId}`, 'PARTICIPANT#');
  }

  async insertParticipant(participant) {
    return this.#insert(participantKey(participant.organizationId, participant.eventId, participant.participantId), participant);
  }

  async #query(pk, prefix) {
    const items = [];
    let cursor;
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      items.push(...(response.Items ?? []).map((item) => item.data));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }

  async #insert(key, data) {
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: { ...key, data }, ConditionExpression: 'attribute_not_exists(pk)' }));
      return { created: true, value: data };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
      if (!response.Item?.data) throw error;
      return { created: false, value: response.Item.data };
    }
  }
}
