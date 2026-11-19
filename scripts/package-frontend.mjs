import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// SAM packages this directory itself; a platform-specific ZIP utility is unnecessary.
export async function packageFrontend({ rootDir = repositoryRoot, sourceCommit } = {}) {
  const root = path.resolve(rootDir);
  const build = path.join(root, 'web/dist/saldoevento-web');
  const adapter = path.join(root, 'web/node_modules/serverless-http');
  const outputDir = path.join(root, 'artifacts/frontend');
  const stagingDir = path.join(root, 'artifacts/.frontend-staging');

  await requireDirectory(path.join(build, 'browser'), 'Angular SSR build missing; run npm --prefix web run build first.');
  await requireDirectory(path.join(build, 'server'), 'Angular SSR build missing its server directory.');
  await access(path.join(build, 'server/server.mjs'));
  await requireDirectory(adapter, 'serverless-http missing; install the web lockfile dependencies first.');

  // Both deletion targets are fixed children of the supplied repository root.
  assertChild(root, outputDir);
  assertChild(root, stagingDir);
  await rm(stagingDir, { force: true, recursive: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await cp(path.join(build, 'browser'), path.join(stagingDir, 'browser'), { recursive: true, filter: deployableFile });
    await cp(path.join(build, 'server'), path.join(stagingDir, 'server'), { recursive: true, filter: deployableFile });
    await cp(adapter, path.join(stagingDir, 'node_modules/serverless-http'), { recursive: true, filter: deployableFile });
    await writeFile(path.join(stagingDir, 'package.json'), JSON.stringify({ name: 'saldoevento-frontend-lambda', private: true, type: 'module' }, null, 2) + '\n');
    await writeFile(path.join(stagingDir, 'index.mjs'), handlerSource);

    const files = await checksums(stagingDir);
    const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const manifest = {
      schemaVersion: 1,
      product: 'SaldoEvento',
      nodeRuntime: 'nodejs24.x',
      architecture: 'arm64',
      handler: 'index.handler',
      sourceCommit: sourceCommit ?? gitCommit(root),
      contentSha256: fingerprint,
      files,
    };
    await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(outputDir, { force: true, recursive: true });
    await rename(stagingDir, outputDir);
    return { outputDir, manifest };
  } catch (error) {
    await rm(stagingDir, { force: true, recursive: true });
    throw error;
  }
}

function deployableFile(source) {
  const basename = path.basename(source);
  return !basename.startsWith('.env') && basename !== '.git' && !basename.endsWith('.map');
}

function assertChild(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact target must remain inside its repository.');
}

async function requireDirectory(candidate, message) {
  try {
    if ((await stat(candidate)).isDirectory()) return;
  } catch {
    // Use the actionable error below for absent build inputs.
  }
  throw new Error(message);
}

async function checksums(directory, prefix = '') {
  const files = {};
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const filename = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await checksums(path.join(directory, entry.name), filename));
    else if (entry.isFile()) files[filename] = createHash('sha256').update(await readFile(path.join(directory, entry.name))).digest('hex');
    else throw new Error('Frontend artifacts cannot contain symbolic links.');
  }
  return files;
}

function gitCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'uncommitted';
  }
}

const handlerSource = `import serverless from 'serverless-http';
import { app } from './server/server.mjs';

const angularHandler = serverless(app, { provider: 'aws' });

export const handler = async (event, context) => {
  const configuredOrigin = process.env.PUBLIC_ORIGIN;
  if (!configuredOrigin) throw new Error('PUBLIC_ORIGIN is required for the frontend Lambda.');
  const origin = new URL(configuredOrigin);
  if (origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  // The origin is deployment configuration, never a viewer-supplied forwarded host.
  return angularHandler({ ...event, headers: { ...event.headers,
    host: origin.host, 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https'
  } }, context);
};
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageFrontend();
  console.log(JSON.stringify({ outputDir: result.outputDir, contentSha256: result.manifest.contentSha256 }, null, 2));
}
