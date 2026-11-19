import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImport } from './csv.mjs';
const header = 'provider,movement_id,participant_reference,amount,currency';
test('parses quoted references and exact decimal amounts without floating point', () => {
  const result = parseImport(`${header}\r\nbank,id-1,"ANA, A",1250.01,MXN\r\n`, 'MXN', [{ participantId: 'ana', reference: 'ANA, A' }]);
  assert.equal(result[0].amountMinor, '125001');
  assert.equal(result[0].suggestedParticipantId, 'ana');
});
test('ambiguous references need review and bad rows stay visible', () => {
  const rows = parseImport(`${header}\nbank,id-1,A,10.00,MXN\nbank,id-2,A,1.234,MXN\nbank,id-3,A,1.00,USD`, 'MXN', [{ participantId: 'a', reference: 'A' }, { participantId: 'b', reference: 'A' }]);
  assert.deepEqual(rows.map((row) => row.status), ['ambiguous', 'rejected', 'rejected']);
});
test('rejects invalid headers, oversize imports and broken quotes', () => {
  assert.throws(() => parseImport('amount\n1', 'MXN', []));
  assert.throws(() => parseImport(`${header}\nbank,id,"broken,1,MXN`, 'MXN', []));
  assert.throws(() => parseImport('a'.repeat(1048577), 'MXN', []));
});
