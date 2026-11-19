import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const scriptUrl = new URL('./package-frontend.mjs', import.meta.url);

async function loadPackager() {
  await assert.doesNotReject(access(scriptUrl), 'Frontend Lambda packager must exist');
  return import(scriptUrl.href);
}

test('missing build fails before replacing the last reviewable artifact', async () => {
  const { packageFrontend } = await loadPackager();
  const rootDir = await mkdtemp(path.join(tmpdir(), 'saldoevento-package-'));
  try {
    await mkdir(path.join(rootDir, 'artifacts/frontend'), { recursive: true });
    await writeFile(path.join(rootDir, 'artifacts/frontend/keep.txt'), 'previous artifact');
    await assert.rejects(packageFrontend({ rootDir }), /Angular SSR build/);
    assert.equal(await readFile(path.join(rootDir, 'artifacts/frontend/keep.txt'), 'utf8'), 'previous artifact');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('SSR package copies only deployable inputs and produces deterministic source checksums', async () => {
  const { packageFrontend } = await loadPackager();
  const rootDir = await mkdtemp(path.join(tmpdir(), 'saldoevento-package-'));
  try {
    const build = path.join(rootDir, 'web/dist/saldoevento-web');
    await mkdir(path.join(build, 'browser'), { recursive: true });
    await mkdir(path.join(build, 'server'), { recursive: true });
    await writeFile(path.join(build, 'browser/index.html'), '<title>SaldoEvento</title>');
    await writeFile(path.join(build, 'server/server.mjs'), 'export const app = () => {};');
    const adapter = path.join(rootDir, 'web/node_modules/serverless-http');
    await mkdir(adapter, { recursive: true });
    await writeFile(path.join(adapter, 'package.json'), '{"name":"serverless-http","version":"4.0.0","main":"index.js"}');
    await writeFile(path.join(adapter, 'index.js'), 'module.exports = () => async (event) => event;');
    await writeFile(path.join(rootDir, '.env'), 'this fixture must never be copied');

    const first = await packageFrontend({ rootDir, sourceCommit: 'a'.repeat(40) });
    const second = await packageFrontend({ rootDir, sourceCommit: 'a'.repeat(40) });
    assert.deepEqual(first.manifest, second.manifest);
    const output = first.outputDir;
    assert.equal(await readFile(path.join(output, 'browser/index.html'), 'utf8'), '<title>SaldoEvento</title>');
    await assert.rejects(access(path.join(output, '.env')));
    const handler = await readFile(path.join(output, 'index.mjs'), 'utf8');
    assert.match(handler, /import \{ app \} from '\.\/server\/server\.mjs'/);
    assert.match(handler, /serverless\(app/);
    const actualHash = createHash('sha256').update(await readFile(path.join(output, 'server/server.mjs'))).digest('hex');
    assert.equal(first.manifest.files['server/server.mjs'], actualHash);
    assert.equal(first.manifest.product, 'SaldoEvento');
    assert.equal(first.manifest.nodeRuntime, 'nodejs24.x');

    const previousOrigin = process.env.PUBLIC_ORIGIN;
    try {
      const { handler } = await import(pathToFileURL(path.join(output, 'index.mjs')).href);
      delete process.env.PUBLIC_ORIGIN;
      await assert.rejects(handler({ headers: {} }), /PUBLIC_ORIGIN is required/);
      process.env.PUBLIC_ORIGIN = 'https://saldoevento-test.lynxpardelle.com';
      const event = await handler({ headers: { host: 'forged.example', 'x-forwarded-host': 'forged.example' } });
      assert.equal(event.headers.host, 'saldoevento-test.lynxpardelle.com');
      assert.equal(event.headers['x-forwarded-host'], 'saldoevento-test.lynxpardelle.com');
      assert.equal(event.headers['x-forwarded-proto'], 'https');
    } finally {
      if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = previousOrigin;
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
