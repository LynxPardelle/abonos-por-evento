import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createLocalServer } from './local-api.mjs';

test('synthetic HTTP pilot imports, confirms, survives reload and reverses without duplicate payments', async (t) => {
  const server = await createLocalServer({ seed: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    assert.ok(response.ok, JSON.stringify(json)); return json;
  };
  const { event } = await request('POST', '/api/v1/events', { eventId: 'pilot', name: 'Piloto sintético', currency: 'MXN' });
  const { participant } = await request('POST', `/api/v1/events/${event.eventId}/participants`, { participantId: 'ana', name: 'Ana sintética', reference: 'ANA-01', agreedMinor: '100000' });
  const csv = 'provider,movement_id,participant_reference,amount,currency\ntransferencia,pago-001,ANA-01,500.00,MXN\n';
  const sha256 = createHash('sha256').update(csv).digest('hex');
  const initial = await request('POST', '/api/v1/events/pilot/imports', { operationId: 'upload-pilot', fileName: 'piloto.csv', sha256 });
  const upload = await fetch(initial.upload.url, { method: 'PUT', headers: initial.upload.headers, body: csv });
  assert.equal(upload.status, 200);
  const { batch } = await request('GET', `/api/v1/events/pilot/imports/${sha256}`);
  assert.equal(batch.rows[0].status, 'suggested');
  assert.equal(batch.rows[0].suggestedParticipantId, participant.participantId);
  let balances = await request('GET', '/api/v1/events/pilot/balances');
  assert.equal(balances.balances[0].paidMinor, '0');
  const operation = { operationId: 'confirm-pilot', batchId: sha256, rowId: batch.rows[0].rowId, participantId: 'ana', expectedVersion: balances.version };
  const applied = await request('POST', '/api/v1/events/pilot/allocations', operation);
  await request('POST', '/api/v1/events/pilot/allocations', operation);
  await request('POST', '/api/v1/events/pilot/imports', { operationId: 'upload-pilot-again', fileName: 'mismo.csv', sha256 });
  assert.equal((await request('GET', '/api/v1/events/pilot/imports')).batches.length, 1);
  balances = await request('GET', '/api/v1/events/pilot/balances');
  assert.equal(balances.balances[0].paidMinor, '50000');
  await request('POST', `/api/v1/events/pilot/movements/${applied.movement.movementId}/reversals`, { operationId: 'reverse-pilot', expectedVersion: balances.version });
  balances = await request('GET', '/api/v1/events/pilot/balances');
  assert.equal(balances.balances[0].paidMinor, '0');
  assert.equal((await request('GET', '/api/v1/events/pilot/movements')).movements.length, 2);
});

test('synthetic local API refuses cross-site callers and forged hosts', async (t) => {
  const server = await createLocalServer({ seed: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/v1/events`, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/v1/events`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(forgedHostStatus, 403);
});
