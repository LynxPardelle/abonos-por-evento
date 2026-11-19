import assert from 'node:assert/strict';
import test from 'node:test';
import { authorize } from './auth.mjs';

const request = (roles = '["operator"]', organizationId = 'org-a') => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'user-1', 'custom:organizationId': organizationId, 'custom:roles': roles } } } } });

test('authorization derives tenant only from validated Gateway JWT claims', () => {
  const event = { ...request(), headers: { 'x-organization-id': 'org-b' }, body: '{"organizationId":"org-b"}' };
  assert.deepEqual(authorize(event, ['auditor']), { subject: 'user-1', organizationId: 'org-a', roles: ['operator'] });
  assert.throws(() => authorize({ headers: { authorization: 'Bearer ignored' } }, ['auditor']), (error) => error.status === 401);
  assert.throws(() => authorize(request('["admin"]', 'org-a#org-b')), (error) => error.status === 401);
});

test('authorization evaluates requested roles as OR and keeps importer/confirmers isolated', () => {
  assert.equal(authorize(request('importer'), ['importer', 'confirmer']).subject, 'user-1');
  assert.equal(authorize(request('admin'), ['confirmer']).subject, 'user-1');
  assert.equal(authorize(request('operator'), ['importer']).subject, 'user-1');
  assert.equal(authorize(request('confirmer'), ['auditor']).subject, 'user-1');
  assert.throws(() => authorize(request('importer'), ['confirmer']), (error) => error.status === 403);
  assert.throws(() => authorize(request('auditor'), ['importer']), (error) => error.status === 403);
});

test('malformed roles and untrusted claim shapes cannot create an authenticated identity', () => {
  for (const roles of [undefined, '', '["admin"', '{"role":"admin"}', '["admin",1]', 'administrator', 'operator,admin,unknown']) {
    const event = request();
    event.requestContext.authorizer.jwt.claims['custom:roles'] = roles;
    assert.throws(() => authorize(event), (error) => error.status === 401);
  }
  const event = request('admin');
  event.requestContext.authorizer.jwt.claims.sub = '';
  assert.throws(() => authorize(event), (error) => error.status === 401);
});

test('Cognito token_use accepts ID tokens and rejects an access token when present', () => {
  const event = request('admin');
  event.requestContext.authorizer.jwt.claims.token_use = 'id';
  assert.equal(authorize(event).subject, 'user-1');
  event.requestContext.authorizer.jwt.claims.token_use = 'access';
  assert.throws(() => authorize(event), (error) => error.status === 401);
});
