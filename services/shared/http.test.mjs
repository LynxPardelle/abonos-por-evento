import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, handleError, json, parseBody, validateId } from './http.mjs';

test('HTTP errors preserve domain messages and hide unexpected details', () => {
  const expected = handleError(new DomainError(409, 'CONFLICT', 'La operación ya existe.'));
  assert.equal(expected.statusCode, 409);
  assert.deepEqual(JSON.parse(expected.body), { error: { code: 'CONFLICT', message: 'La operación ya existe.' } });
  const unexpected = handleError(new Error('secret table name'));
  assert.equal(unexpected.statusCode, 500);
  assert.doesNotMatch(unexpected.body, /secret/);
  assert.equal(json(200, { ok: true }).headers['cache-control'], 'no-store');
});

test('HTTP body accepts JSON objects and base64 but rejects malformed shapes', () => {
  assert.deepEqual(parseBody({ body: '{"name":"Encuentro"}' }), { name: 'Encuentro' });
  assert.deepEqual(parseBody({ body: Buffer.from('{"name":"Encuentro"}').toString('base64'), isBase64Encoded: true }), { name: 'Encuentro' });
  for (const body of ['', '[]', 'null', '{bad']) {
    assert.throws(() => parseBody({ body }), (error) => error.status === 400);
  }
});

test('resource IDs reject delimiters and path traversal', () => {
  assert.equal(validateId('evt-123'), 'evt-123');
  for (const value of ['org#another', '../event', 'one/two', '', 'a'.repeat(81), undefined]) {
    assert.throws(() => validateId(value), (error) => error.status === 400);
  }
});

test('HTTP body size limit counts UTF-8 bytes before accepting a payload', () => {
  assert.throws(() => parseBody({ body: JSON.stringify({ csv: 'é'.repeat(600_000) }) }), (error) => error.status === 400);
});
