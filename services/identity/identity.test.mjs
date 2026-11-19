import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdentityService } from './service.mjs';
import { MemoryIdentityRepository, DynamoIdentityRepository } from './repository.mjs';
import { createPostConfirmationHandler } from './post-confirmation.mjs';
import { createPreTokenHandler } from './pre-token.mjs';

const subjectA = '11111111-1111-4111-8111-111111111111';
const subjectB = '22222222-2222-4222-8222-222222222222';
const pool = 'us-east-1_Synthetic';
const eventFor = (subject = subjectA, triggerSource = 'TokenGeneration_Authentication', extra = {}) => ({
  version: '1', userPoolId: pool, triggerSource, userName: subject,
  callerContext: { clientId: 'synthetic-client' },
  request: { userAttributes: { sub: subject, email_verified: 'true', email: 'synthetic@example.test', ...extra }, clientMetadata: { organizationId: 'victim-org', roles: 'admin' } },
  response: {},
});

test('confirmed registration provisions one isolated organization and retry preserves membership', async () => {
  const repository = new MemoryIdentityRepository();
  const service = createIdentityService({ repository, selfRegistrationEnabled: true, now: () => '2026-11-19T00:00:00Z' });
  const first = await service.ensureMembership(eventFor());
  const retry = await service.ensureMembership(eventFor());
  const other = await service.ensureMembership(eventFor(subjectB));
  assert.equal(first.organizationId, retry.organizationId);
  assert.notEqual(first.organizationId, other.organizationId);
  assert.notEqual(first.organizationId, 'victim-org');
  assert.deepEqual(first.roles, ['admin']);
  assert.equal(first.tier, 'pilot');
  assert.equal(first.source, 'self-registration');
  assert.equal(first.userSub, subjectA);
  assert.equal(Object.hasOwn(first, 'email'), false, 'Identity membership need not duplicate personal email');
});

test('unverified identities, malformed legacy authorization and closed self-registration fail closed', async () => {
  const service = createIdentityService({ repository: new MemoryIdentityRepository(), selfRegistrationEnabled: true });
  await assert.rejects(service.ensureMembership(eventFor(subjectA, undefined, { email_verified: 'false' })), { code: 'EMAIL_NOT_VERIFIED' });
  await assert.rejects(service.ensureMembership(eventFor(subjectA, undefined, { 'custom:organizationId': 'victim-org' })), { code: 'INVALID_ADMIN_MEMBERSHIP' });
  await assert.rejects(service.ensureMembership(eventFor(subjectA, undefined, { 'custom:organizationId': '../victim', 'custom:roles': 'admin' })), { code: 'INVALID_ADMIN_MEMBERSHIP' });
  const closed = createIdentityService({ repository: new MemoryIdentityRepository(), selfRegistrationEnabled: false });
  await assert.rejects(closed.ensureMembership(eventFor()), { code: 'REGISTRATION_CLOSED' });
});

test('administratively assigned legacy organizations and roles remain available without allowing metadata overrides', async () => {
  const service = createIdentityService({ repository: new MemoryIdentityRepository(), selfRegistrationEnabled: false });
  const membership = await service.ensureMembership(eventFor(subjectA, undefined, { 'custom:organizationId': 'existing-org', 'custom:roles': 'importer' }));
  assert.equal(membership.organizationId, 'existing-org');
  assert.deepEqual(membership.roles, ['importer']);
  assert.equal(membership.source, 'administrative');
});

test('persisted membership is authoritative and a suspended or corrupt record cannot issue a token', async () => {
  const repository = new MemoryIdentityRepository();
  const service = createIdentityService({ repository, selfRegistrationEnabled: true });
  const first = await service.ensureMembership(eventFor());
  const changedAttributes = await service.ensureMembership(eventFor(subjectA, undefined, { 'custom:organizationId': 'other-org', 'custom:roles': 'auditor' }));
  assert.deepEqual(changedAttributes, first);
  const suspended = createIdentityService({ repository: { get: async () => ({ ...first, status: 'suspended' }) }, selfRegistrationEnabled: true });
  await assert.rejects(suspended.ensureMembership(eventFor()), { code: 'MEMBERSHIP_DISABLED' });
  const corrupt = createIdentityService({ repository: { get: async () => ({ ...first, userSub: subjectB }) }, selfRegistrationEnabled: true });
  await assert.rejects(corrupt.ensureMembership(eventFor()), { code: 'INVALID_MEMBERSHIP' });
});

test('post-confirmation and pre-token v1 integrate server-owned claims without suppressing existing response fields', async () => {
  const service = createIdentityService({ repository: new MemoryIdentityRepository(), selfRegistrationEnabled: true });
  const confirm = createPostConfirmationHandler({ service });
  const confirmation = eventFor(subjectA, 'PostConfirmation_ConfirmSignUp');
  assert.equal(await confirm(confirmation), confirmation);
  const preToken = createPreTokenHandler({ service });
  const event = eventFor();
  event.response.claimsOverrideDetails = { claimsToAddOrOverride: { unrelated: 'preserved' }, claimsToSuppress: ['phone_number'] };
  const result = await preToken(event);
  const claims = result.response.claimsOverrideDetails.claimsToAddOrOverride;
  assert.match(claims['custom:organizationId'], /^org-[a-f0-9]{32}$/);
  assert.equal(claims['custom:roles'], 'admin');
  assert.equal(claims['custom:tier'], 'pilot');
  assert.equal(claims.unrelated, 'preserved');
  assert.deepEqual(result.response.claimsOverrideDetails.claimsToSuppress, ['phone_number']);
  await assert.rejects(preToken({ ...eventFor(), triggerSource: 'UntrustedRequest' }), { code: 'INVALID_TRIGGER' });
  await assert.rejects(confirm({ ...confirmation, triggerSource: 'TokenGeneration_Authentication' }), { code: 'INVALID_TRIGGER' });
});

test('Dynamo membership uses consistent subject-scoped reads and a conditional create for concurrent retries', async () => {
  const commands = [];
  let stored;
  const client = { send: async command => {
    commands.push(command);
    if (command.constructor.name === 'GetCommand') return { Item: stored };
    if (stored) throw Object.assign(new Error('duplicate'), { name: 'ConditionalCheckFailedException' });
    stored = structuredClone(command.input.Item); return {};
  } };
  const repository = new DynamoIdentityRepository({ tableName: 'Identity', client });
  const scope = { userPoolId: pool, userSub: subjectA };
  const membership = { ...scope, organizationId: 'org-test', roles: ['admin'], status: 'active', tier: 'pilot' };
  assert.equal(await repository.get(scope), undefined);
  assert.deepEqual(await repository.createIfAbsent(membership), membership);
  assert.deepEqual(await repository.createIfAbsent({ ...membership, organizationId: 'changed-org' }), membership);
  assert.equal(commands[0].input.ConsistentRead, true);
  assert.ok(commands[0].input.Key.pk.includes(subjectA));
  assert.equal(commands[1].input.ConditionExpression, 'attribute_not_exists(pk)');
  assert.ok(commands.every(command => command.input.TableName === 'Identity'));
});
