import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const keyFor = ({ userPoolId, userSub }) => ({ pk: `POOL#${userPoolId}#USER#${userSub}`, sk: 'MEMBERSHIP' });
const clone = value => value === undefined ? undefined : structuredClone(value);

export class MemoryIdentityRepository {
  #memberships = new Map();
  async get(scope) { return clone(this.#memberships.get(keyFor(scope).pk)); }
  async createIfAbsent(membership) {
    const key = keyFor(membership).pk;
    if (!this.#memberships.has(key)) this.#memberships.set(key, clone(membership));
    return clone(this.#memberships.get(key));
  }
}

export class DynamoIdentityRepository {
  constructor({ tableName = process.env.IDENTITY_TABLE, client = DynamoDBDocumentClient.from(new DynamoDBClient({})) } = {}) {
    if (!tableName) throw new Error('Identity table is required.');
    this.tableName = tableName; this.client = client;
  }
  async get(scope) {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: keyFor(scope), ConsistentRead: true }));
    return response.Item?.data;
  }
  async createIfAbsent(membership) {
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: { ...keyFor(membership), data: membership }, ConditionExpression: 'attribute_not_exists(pk)' }));
      return membership;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.get(membership);
      if (!existing) throw new Error('Identity could not be loaded after a concurrent create.');
      return existing;
    }
  }
}
