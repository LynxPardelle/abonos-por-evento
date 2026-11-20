import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryEventsRepository } from './repository.mjs';
import { MemoryAccountsRepository } from '../identity/accounts-repository.mjs';
import {
  accountKeys,
  createAccountsService,
  personalOrganizationId,
} from '../identity/accounts.mjs';

const pool = 'us-east-1_EventsIntegration';
const subject = '11111111-1111-4111-8111-111111111111';
const collaborator = '22222222-2222-4222-8222-222222222222';
const organizationId = personalOrganizationId(pool, subject);
const event = (id) => ({ organizationId, eventId: id, name: id, currency: 'MXN' });
const grant = (code, expectedVersion, operationId) => ({
  action: 'grantPlan',
  userPoolId: pool,
  subject,
  organizationId,
  code,
  expectedVersion,
  operationId,
});
async function fixture(Repository = MemoryEventsRepository) {
  let events;
  const accounts = new MemoryAccountsRepository({
    validateUsage: (guard) => events.assertUsageGuardSync(guard),
  });
  events = new Repository({ validateAccess: (actor) => accounts.assertGuardsSync(actor) });
  for (const person of [subject, collaborator])
    await accounts.seed(accountKeys.legacy(pool, person), {
      userPoolId: pool,
      userSub: person,
      organizationId: personalOrganizationId(pool, person),
      roles: ['admin'],
      tier: 'pilot',
      status: 'active',
      source: 'self-registration',
      schemaVersion: 1,
    });
  const service = createAccountsService({
    repository: accounts,
    usageReader: async (org) => events.getUsageSync({ organizationId: org }),
  });
  await service.admin(grant('organizer', 0, 'organizer-plan'));
  return { events, accounts, service };
}

test('real Accounts downgrade invalidates an Events actor already resolved before the transaction', async () => {
  let entered, release;
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  const releasePromise = new Promise((resolve) => (release = resolve));
  class PausedEvents extends MemoryEventsRepository {
    async _usageWrite(...arguments_) {
      const result = await super._usageWrite(...arguments_);
      entered();
      await releasePromise;
      return result;
    }
  }
  const { events, service } = await fixture(PausedEvents);
  const oldActor = await service.resolve({ userPoolId: pool, subject });
  const pending = events.insertEvent(event('after-downgrade'), { actor: oldActor });
  await enteredPromise;
  await service.admin(grant('event', oldActor.plan.assignmentVersion, 'downgrade-plan'));
  release();
  await assert.rejects(pending, { code: 'ACCESS_CHANGED' });
  assert.equal(events.getUsageSync({ organizationId }).nonArchivedEvents, 0);
  assert.equal((await events.listEvents({ organizationId })).length, 0);
});

test('real Events creation invalidates an Accounts quota snapshot before downgrade commits', async () => {
  const { events, accounts, service } = await fixture();
  const actor = await service.resolve({ userPoolId: pool, subject });
  await events.insertEvent(event('one'), { actor });
  let entered, release;
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  const releasePromise = new Promise((resolve) => (release = resolve));
  const pausedAdmin = createAccountsService({
    repository: accounts,
    usageReader: async (org) => {
      const snapshot = events.getUsageSync({ organizationId: org });
      entered();
      await releasePromise;
      return snapshot;
    },
  });
  const pending = pausedAdmin.admin(grant('event', actor.plan.assignmentVersion, 'downgrade-race'));
  await enteredPromise;
  await events.insertEvent(event('two'), { actor });
  release();
  await assert.rejects(pending, { code: 'USAGE_CHANGED' });
  assert.equal((await service.resolve({ userPoolId: pool, subject })).plan.code, 'organizer');
  assert.equal(events.getUsageSync({ organizationId }).nonArchivedEvents, 2);
});

test('revoking a real collaborator prevents Events writes with its old actor and preserves existing events', async () => {
  const { events, service } = await fixture();
  const organizer = await service.resolve({ userPoolId: pool, subject });
  await service.admin(grant('team', organizer.plan.assignmentVersion, 'team-plan'));
  const owner = await service.resolve({ userPoolId: pool, subject });
  const { member } = await service.admin({
    action: 'grantMember',
    userPoolId: pool,
    subject: collaborator,
    organizationId,
    roles: ['operator'],
    eventIds: null,
    expectedVersion: owner.plan.assignmentVersion,
    operationId: 'collaborator',
  });
  const stale = await service.resolve({
    userPoolId: pool,
    subject: collaborator,
    organizationHint: organizationId,
  });
  await events.insertEvent(event('existing'), { actor: stale });
  await service.revokeMember(
    await service.resolve({ userPoolId: pool, subject }),
    member.memberId,
    { operationId: 'revoke', expectedVersion: member.version },
  );
  await assert.rejects(events.insertEvent(event('blocked'), { actor: stale }), {
    code: 'ACCESS_CHANGED',
  });
  assert.equal((await events.listEvents({ organizationId })).length, 1);
  assert.equal(events.getUsageSync({ organizationId }).nonArchivedEvents, 1);
});
