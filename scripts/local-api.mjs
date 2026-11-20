import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createEventsHandler } from '../services/events/index.mjs';
import { MemoryEventsRepository } from '../services/events/repository.mjs';
import { createReconciliationService } from '../services/reconciliation/application.mjs';
import { createReconciliationHandler } from '../services/reconciliation/index.mjs';
import { MemoryReconciliationRepository } from '../services/reconciliation/repository.mjs';
import { DomainError, handleError, json } from '../services/shared/http.mjs';
import { MemoryAccountsRepository } from '../services/identity/accounts-repository.mjs';
import { accountKeys, createAccountsService, personalOrganizationId } from '../services/identity/accounts.mjs';
import { createAccountsHttpHandler } from '../services/identity/http.mjs';
import { createAccessResolver } from '../services/shared/access.mjs';

const pool = 'us-east-1_LocalDemo'; const subject = '11111111-1111-4111-8111-111111111111';
const claims = Object.freeze({ sub: subject, iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`, 'custom:organizationId': personalOrganizationId(pool, subject), 'custom:roles': 'admin', token_use: 'id' });
const eventFor = (method, path, body, headers = {}) => ({ rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims } } }, body, headers });

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new DomainError(413, 'BODY_TOO_LARGE', 'El archivo puede tener hasta 1 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// This adapter is a synthetic development tool. It is outside every Lambda CodeUri.
export async function createLocalServer({ seed = true } = {}) {
  let accountsRepository;
  const eventsRepository = new MemoryEventsRepository({ validateAccess: actor => accountsRepository.assertGuardsSync(actor) });
  accountsRepository = new MemoryAccountsRepository({ validateUsage: guard => eventsRepository.assertUsageGuardSync(guard) });
  await accountsRepository.seed(accountKeys.legacy(pool, subject), { userPoolId: pool, userSub: subject, organizationId: claims['custom:organizationId'], roles: ['admin'], tier: 'pilot', status: 'active', source: 'self-registration' });
  const accountsService = createAccountsService({ repository: accountsRepository, usageReader: async organizationId => eventsRepository.getUsageSync({ organizationId }), userPoolId: pool });
  await accountsService.admin({ action: 'grantPlan', userPoolId: pool, subject, organizationId: claims['custom:organizationId'], code: 'team', expectedVersion: 0, operationId: 'local-team' });
  const viewer = '22222222-2222-4222-8222-222222222222';
  await accountsRepository.seed(accountKeys.legacy(pool, viewer), { userPoolId: pool, userSub: viewer, organizationId: personalOrganizationId(pool, viewer), roles: ['admin'], tier: 'pilot', status: 'active', source: 'self-registration' });
  await accountsService.admin({ action: 'grantMember', userPoolId: pool, subject: viewer, organizationId: claims['custom:organizationId'], roles: ['auditor'], expectedVersion: 1, operationId: 'local-viewer' });
  const accessResolver = createAccessResolver({ identityReader: accountsService, userPoolId: pool });
  const accounts = createAccountsHttpHandler({ service: accountsService, userPoolId: pool });
  const events = createEventsHandler({ repository: eventsRepository, accessResolver });
  async function invokeEvent(internal) { const result = await events({ internal }); if (result.statusCode) { const error = JSON.parse(result.body).error; throw new DomainError(result.statusCode, error.code, error.message); } return result; }
  const uploads = new Map();
  const service = createReconciliationService({
    repository: new MemoryReconciliationRepository({ validateAccess: actor => accountsRepository.assertGuardsSync(actor) }),
    eventReader: scope => invokeEvent({ action: 'getEvent', ...scope }),
    eventCommand: (action, scope, input, actor) => invokeEvent({ action, ...scope, ...input, actor }),
    eventLister: actor => invokeEvent({ action: 'listEventsforOverview', organizationId: actor.organizationId, actor }),
    uploadSigner: async ({ key }) => {
      const token = randomUUID();
      uploads.set(token, { key, expiresAt: Date.now() + 600_000 });
      return { url: `http://127.0.0.1:${server.address().port}/__local/upload?token=${token}`, method: 'PUT', headers: { 'content-type': 'text/csv' } };
    },
  });
  const reconciliation = createReconciliationHandler({ service, accessResolver });
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const host = request.headers.host ?? '';
    const port = server.address().port;
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://localhost:4310', 'http://127.0.0.1:4310']);
    const send = result => { response.writeHead(result.statusCode, { ...result.headers, ...(origin && allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) }); response.end(result.body); };
    try {
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (origin && !allowedOrigins.has(origin))) { send(json(403, { error: { code: 'LOCAL_ONLY', message: 'Este servidor sólo admite el entorno local.' } })); return; }
      if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': origin ?? '', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-saldoevento-organization', vary: 'Origin' }); response.end(); return; }
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/runtime-config.json') { send(json(200, { mode: 'local', cognitoDomain: '', clientId: '' })); return; }
      if (url.pathname === '/health') { send(json(200, { status: 'ok', service: 'saldoevento-local-synthetic' })); return; }
      if (request.method === 'PUT' && url.pathname === '/__local/upload') {
        const upload = uploads.get(url.searchParams.get('token'));
        if (!upload || upload.expiresAt < Date.now()) throw new DomainError(403, 'UPLOAD_EXPIRED', 'La carga caducó. Vuelve a importar el archivo.');
        const match = /^tenants\/([^/]+)\/events\/([^/]+)\/imports\/([^/]+)\/input\.csv$/.exec(upload.key);
        if (!match) throw new DomainError(403, 'INVALID_UPLOAD', 'La carga no pertenece a este entorno.');
        const csv = (await readBody(request)).toString('utf8');
        const result = await service.processImport({ organizationId: match[1], eventId: match[2], batchId: match[3], csv });
        send(json(200, result)); return;
      }
      const body = ['POST', 'PUT'].includes(request.method) ? (await readBody(request)).toString('utf8') : undefined;
      const handler = /^\/api\/v1\/(?:me|organizations\/)/.test(url.pathname) ? accounts : /^\/api\/v1\/(?:templates(?:\/|$)|events(?:\/[^/]+(?:\/participants)?)?$)/.test(url.pathname) ? events : reconciliation;
      send(await handler(eventFor(request.method, url.pathname, body, request.headers)));
    } catch (error) { send(handleError(error)); }
  });
  if (seed) {
    await events(eventFor('POST', '/api/v1/events', JSON.stringify({ eventId: 'encuentro-demo', name: 'Encuentro de noviembre · ejemplo', currency: 'MXN' })));
    for (const person of [
      { participantId: 'ana-demo', name: 'Ana · ejemplo', reference: 'ANA-01', agreedMinor: '100000' },
      { participantId: 'bruno-demo', name: 'Bruno · ejemplo', reference: 'BRUNO-02', agreedMinor: '100000' },
    ]) await events(eventFor('POST', '/api/v1/events/encuentro-demo/participants', JSON.stringify(person)));
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createLocalServer();
  server.listen(4311, '127.0.0.1', () => console.log('SaldoEvento: API sintética en http://127.0.0.1:4311 (memoria, sólo loopback).'));
}
