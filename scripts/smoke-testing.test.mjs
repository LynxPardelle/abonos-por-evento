import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestingArgs, runTestingSmoke } from './smoke-testing.mjs';

test('testing smoke defaults to the testing stack and refuses every other lane', async () => {
  assert.deepEqual(parseTestingArgs([]), { stack:'saldoevento-test', region:'us-east-1' });
  let calls=0;
  for(const stack of ['saldoevento-dev','saldoevento-prod','main']) await assert.rejects(runTestingSmoke(['--stack',stack],async()=>{calls++;return 0;}));
  assert.equal(calls,0);
});

test('testing smoke delegates the verified target without executing AWS in tests', async () => {
  let forwarded;
  const result=await runTestingSmoke(['--region','us-east-1'],async args=>{forwarded=args;return 0;});
  assert.equal(result,0);
  assert.deepEqual(forwarded,['--stack','saldoevento-test','--region','us-east-1']);
});
