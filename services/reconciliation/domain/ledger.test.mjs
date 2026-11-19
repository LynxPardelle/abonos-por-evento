import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, applyPayment, reversePayment } from './ledger.mjs';

const payment = { operationId: 'op-1', participantId: 'ana', itemId: 'registration', provider: 'bank', externalMovementId: 'bank-1', amountMinor: '100000000000000000001', currency: 'MXN', expectedVersion: 0 };
test('stores exact integer money and immutable movements', () => {
  const original = createLedger('MXN');
  const next = applyPayment(original, payment);
  assert.equal(next.movements[0].amountMinor, payment.amountMinor);
  assert.equal(original.movements.length, 0);
  assert.equal(next.version, 1);
});
test('retries return original and changed requests conflict', () => {
  const state = applyPayment(createLedger('MXN'), payment);
  assert.deepEqual(applyPayment(state, payment), state);
  assert.throws(() => applyPayment(state, { ...payment, amountMinor: '2' }), { code: 'OPERATION_CONFLICT' });
  assert.throws(() => applyPayment(state, { ...payment, operationId: 'another', expectedVersion: 1 }), { code: 'DUPLICATE_MOVEMENT' });
});
test('rejects decimals, mismatched currency, stale writes and invalid versions', () => {
  for (const change of [{ amountMinor: '1.2' }, { amountMinor: '-1' }, { currency: 'USD' }, { expectedVersion: 1 }, { expectedVersion: -1 }]) {
    assert.throws(() => applyPayment(createLedger('MXN'), { ...payment, ...change }));
  }
});
test('reversal appends its own identity and cannot reverse twice', () => {
  const paid = applyPayment(createLedger('MXN'), { ...payment, amountMinor: '50000' });
  const reversed = reversePayment(paid, { operationId: 'reverse-1', movementId: paid.movements[0].movementId, expectedVersion: 1 });
  assert.equal(reversed.movements[1].amountMinor, '-50000');
  assert.equal(reversed.movements[1].reversalOf, paid.movements[0].movementId);
  assert.equal(reversed.movements[0].amountMinor, '50000');
  assert.deepEqual(reversePayment(reversed, { operationId: 'reverse-1', movementId: paid.movements[0].movementId, expectedVersion: 1 }), reversed);
  assert.throws(() => reversePayment(reversed, { operationId: 'reverse-2', movementId: paid.movements[0].movementId, expectedVersion: 2 }), { code: 'ALREADY_REVERSED' });
});
