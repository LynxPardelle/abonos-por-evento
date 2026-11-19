import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyntheticPilot } from './pilot.mjs';
test('synthetic close reconciles two payments and reversal with ambiguity, duplicate and queue replay', async () => {
  const report = await runSyntheticPilot();
  assert.equal(report.paidMinor, '75000');
  assert.equal(report.movementCount, 3);
  assert.equal(report.ambiguousRows, 1);
  assert.equal(report.rejectedRows, 1);
  assert.equal(report.duplicateRows, 1);
  assert.deepEqual(report.discrepancies, []);
  assert.equal(report.retryCount, 1);
});
