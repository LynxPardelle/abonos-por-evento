import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function main() {
process.env.PUBLIC_ORIGIN = 'https://saldoevento-dev.lynxpardelle.com';
const { handler } = await import(pathToFileURL(path.resolve('artifacts/frontend/index.mjs')));
const eventFor = path => ({
  version: '2.0', routeKey: '$default', rawPath: path, rawQueryString: '',
  headers: { host: 'function.lambda-url.us-east-1.on.aws', 'x-forwarded-host': 'untrusted.invalid', 'x-forwarded-proto': 'https' },
  requestContext: { accountId: 'anonymous', apiId: 'local-smoke', domainName: 'function.lambda-url.us-east-1.on.aws', domainPrefix: 'function', http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'SaldoEvento synthetic SSR smoke' }, requestId: 'synthetic', routeKey: '$default', stage: '$default', timeEpoch: Date.now() },
  isBase64Encoded: false,
});
for (const route of ['/', '/registro', '/app', '/eventos/synthetic/asistentes', '/auth/callback']) {
  const response = await handler(eventFor(route), {});
  const body = response.isBase64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
  assert.equal(response.statusCode, 200, `${route}: ${body.slice(0, 200)}`);
  assert.match(body, /SaldoEvento/);
  assert.match(response.headers['cache-control'] ?? response.headers['Cache-Control'], /no-store/);
  assert.doesNotMatch(body, /untrusted\.invalid/);
}
const config = await handler(eventFor('/runtime-config.json'), {});
assert.equal(config.statusCode, 200);
assert.equal(JSON.parse(config.body).mode, 'cloud');
const api = await handler(eventFor('/api/v1/events'), {});
assert.equal(api.statusCode, 404);
console.log(JSON.stringify({ product: 'SaldoEvento', frontendLambda: 'passed', htmlRoutes: 5, configuration: 'cloud', hostOverride: 'rejected', cache: 'no-store' }, null, 2));

}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
