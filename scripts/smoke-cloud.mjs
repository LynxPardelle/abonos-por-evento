import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedStack = 'saldoevento-dev';
const targets = Object.freeze({
  'saldoevento-dev': { stage:'dev', environment:'development', origin:'https://saldoevento-dev.lynxpardelle.com' },
  'saldoevento-test': { stage:'test', environment:'testing', origin:'https://saldoevento-test.lynxpardelle.com' },
});
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

class SmokeFailure extends Error {
  constructor(code) { super(code); this.name = 'SmokeFailure'; this.code = code; }
}
const requireCheck = (condition, code) => { if (!condition) throw new SmokeFailure(code); };

export function parseArgs(argv) {
  const options = { stack: expectedStack, region: 'us-east-1' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    requireCheck(['--stack', '--region'].includes(key) && typeof value === 'string' && !value.startsWith('--'), 'INVALID_ARGUMENTS');
    options[key.slice(2)] = value;
  }
  requireCheck(Object.hasOwn(targets, options.stack), 'NON_PRODUCTION_STACK_REQUIRED');
  requireCheck(/^[a-z]{2}-[a-z]+-[0-9]$/.test(options.region), 'INVALID_REGION');
  return options;
}

export function validateCloudTarget(stackName, stack) {
  requireCheck(Object.hasOwn(targets, stackName) && stack?.StackName === stackName, 'NON_PRODUCTION_STACK_REQUIRED');
  const target = targets[stackName];
  const parameters = Object.fromEntries((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey, parameter.ParameterValue]));
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));
  requireCheck(parameters.Stage === target.stage, 'TARGET_STAGE_REQUIRED');
  requireCheck(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'].includes(stack.StackStatus), 'STACK_NOT_READY');
  const origin = parameters.PublicOrigin || `https://${outputs.ProductDomain ?? ''}`;
  requireCheck(origin === target.origin && outputs.ProductDomain === new URL(target.origin).hostname, 'TARGET_ORIGIN_REQUIRED');
  requireCheck(typeof outputs.UserPoolId === 'string' && /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/.test(outputs.UserPoolId), 'USER_POOL_OUTPUT_REQUIRED');
  requireCheck(typeof outputs.UserPoolClientId === 'string' && /^[A-Za-z0-9-]+$/.test(outputs.UserPoolClientId), 'USER_POOL_CLIENT_OUTPUT_REQUIRED');
  return { ...target, origin, userPoolId: outputs.UserPoolId, clientId: outputs.UserPoolClientId };
}

export function describeStack({ stack: stackName, region }) {
  requireCheck(Object.hasOwn(targets, stackName), 'NON_PRODUCTION_STACK_REQUIRED');
  try {
    const source = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const description = JSON.parse(source);
    requireCheck(description.Stacks?.length === 1, 'STACK_DESCRIPTION_INVALID');
    return description.Stacks[0];
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure('STACK_DESCRIPTION_FAILED');
  }
}

export async function createCognitoAdapter({ region, client, commands } = {}) {
  const sdk = commands ?? await import('@aws-sdk/client-cognito-identity-provider');
  const cognito = client ?? new sdk.CognitoIdentityProviderClient({ region });
  return {
    async createUser({ userPoolId, username, organizationId, roles }) {
      await cognito.send(new sdk.AdminCreateUserCommand({
        UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' },
          ...(organizationId !== undefined ? [{ Name: 'custom:organizationId', Value: organizationId }] : []),
          ...(roles !== undefined ? [{ Name: 'custom:roles', Value: roles }] : []),
        ],
      }));
    },
    async setPassword({ userPoolId, username, password }) {
      await cognito.send(new sdk.AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));
    },
    async authenticate({ userPoolId, clientId, username, password }) {
      const result = await cognito.send(new sdk.AdminInitiateAuthCommand({ UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } }));
      requireCheck(typeof result.AuthenticationResult?.IdToken === 'string', 'ID_TOKEN_REQUIRED');
      return result.AuthenticationResult.IdToken;
    },
    async deleteUser({ userPoolId, username }) {
      try { await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })); }
      catch (error) { if (error.name !== 'UserNotFoundException') throw error; }
    },
  };
}

export async function runCloudSmoke({ stackName, stackDescription, region = 'us-east-1', cognito, fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), clock = () => Date.now() }) {
  // All guards precede the first identity mutation. Only this named dev origin is allowed.
  const target = validateCloudTarget(stackName, stackDescription);
  requireCheck(target.userPoolId.startsWith(`${region}_`), 'USER_POOL_REGION_MISMATCH');
  requireCheck(cognito && typeof cognito.createUser === 'function', 'COGNITO_ADAPTER_REQUIRED');
  const runId = randomUUID().replaceAll('-', '').slice(0, 16);
  const organizationA = `smoke-a-${runId}`; const organizationB = `smoke-b-${runId}`;
  const eventId = `smoke-${runId}`; const participantId = `smoke-ana-${runId}`;
  const attemptedUsers = []; const tokens = new Map();
  const report = {
    schemaVersion: 2, product: 'SaldoEvento', environment: target.environment, stack: stackName, region, origin: target.origin,
    startedAt: new Date(clock()).toISOString(), status: 'running', checks: [], metrics: {},
    synthetic: { runId, eventId, organizationA, organizationB },
    cleanup: { attemptedUsers: 0, createdUsers: 0, deletedUsers: 0, failures: 0 },
  };
  let activeCheck = 'temporary_identities';
  const passed = (name, evidence) => report.checks.push({ name, status: 'passed', ...(evidence ? { evidence } : {}) });
  const fetchSafe = (url, options = {}) => fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  async function request(method, endpoint, token, body, expectedStatus = 200) {
    const response = await fetchSafe(`${target.origin}${endpoint}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    requireCheck(response.status === expectedStatus, `HTTP_${response.status}_EXPECTED_${expectedStatus}`);
    if (expectedStatus >= 400) return undefined;
    try { return await response.json(); } catch { throw new SmokeFailure('INVALID_JSON_RESPONSE'); }
  }
  async function upload(upload, csv) {
    requireCheck(typeof upload?.url === 'string' && new URL(upload.url).protocol === 'https:', 'SIGNED_UPLOAD_REQUIRED');
    const response = await fetchSafe(upload.url, { method: 'PUT', headers: upload.headers, body: csv });
    requireCheck(response.ok, `UPLOAD_HTTP_${response.status}`);
  }

  try {
    for (const user of [
      { label: 'operator', organizationId: organizationA, roles: 'operator' },
      { label: 'otherTenant', organizationId: organizationB, roles: 'auditor' },
      { label: 'importer', organizationId: organizationA, roles: 'importer' },
      // No custom tenant or role is supplied: the trusted PreToken trigger must provision it.
      { label: 'selfService' },
    ]) {
      const username = `smoke-${runId}-${user.label.toLowerCase()}@example.test`;
      // Passwords, ID tokens and signed URLs are never placed in the report or logs.
      const password = `S!a9${randomBytes(32).toString('base64url')}`;
      attemptedUsers.push(username); report.cleanup.attemptedUsers++;
      await cognito.createUser({ ...target, username, organizationId: user.organizationId, roles: user.roles });
      report.cleanup.createdUsers++;
      await cognito.setPassword({ ...target, username, password });
      tokens.set(user.label, await cognito.authenticate({ ...target, username, password }));
    }
    passed(activeCheck, { count: 4, notificationsSuppressed: true });
    const operatorToken = tokens.get('operator');

    activeCheck = 'cloud_frontend';
    const html = await fetchSafe(`${target.origin}/`);
    requireCheck(html.ok && (await html.text()).includes('SaldoEvento'), 'FRONTEND_HTML_MISSING');
    const config = await request('GET', '/runtime-config.json');
    requireCheck(config.mode === 'cloud' && config.clientId === target.clientId, 'CLOUD_RUNTIME_CONFIG_MISMATCH');
    passed(activeCheck);

    activeCheck = 'unauthenticated_rejected';
    await request('GET', '/api/v1/events', undefined, undefined, 401); passed(activeCheck);

    activeCheck = 'event_and_participants';
    const created = await request('POST', '/api/v1/events', operatorToken, { eventId, operationId: `create-${runId}`, name: `[SINTÉTICO SMOKE ${runId}] SaldoEvento development`, currency: 'MXN' }, 201);
    requireCheck(created.event?.eventId === eventId, 'EVENT_ID_MISMATCH');
    const base = `/api/v1/events/${eventId}`;
    const primaryReference = `ANA-${runId}`; const sharedReference = `SHARED-${runId}`;
    for (const person of [
      { participantId, name: 'Ana Sintética', reference: primaryReference },
      { participantId: `smoke-bruno-${runId}`, name: 'Bruno Sintético', reference: sharedReference },
      { participantId: `smoke-carla-${runId}`, name: 'Carla Sintética', reference: sharedReference },
    ]) await request('POST', `${base}/participants`, operatorToken, { ...person, agreedMinor: '100000' }, 201);
    passed(activeCheck, { participants: 3 });

    activeCheck = 'tenant_isolation';
    const otherEvents = await request('GET', '/api/v1/events', tokens.get('otherTenant'));
    requireCheck(Array.isArray(otherEvents.events) && otherEvents.events.length === 0, 'CROSS_TENANT_EVENT_VISIBLE');
    await request('GET', `${base}/participants`, tokens.get('otherTenant'), undefined, 404); passed(activeCheck);

    activeCheck = 'csv_upload_and_worker';
    const csv = [
      'provider,movement_id,participant_reference,amount,currency',
      `synthetic,${runId}-500,${primaryReference},500.00,MXN`,
      `synthetic,${runId}-750,${primaryReference},750.00,MXN`,
      `synthetic,${runId}-ambiguous,${sharedReference},100.00,MXN`,
      `synthetic,${runId}-invalid,${primaryReference},invalid,MXN`,
    ].join('\n');
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const importInput = { operationId: `upload-${runId}`, sha256, fileName: `synthetic-smoke-${runId}.csv` };
    const started = await request('POST', `${base}/imports`, operatorToken, importInput, 201);
    requireCheck(started.batch?.batchId === sha256, 'BATCH_HASH_MISMATCH');
    await upload(started.upload, csv);
    const deadline = clock() + 60_000;
    let batch; let polls = 0;
    do {
      ({ batch } = await request('GET', `${base}/imports/${sha256}`, operatorToken)); polls++;
      requireCheck(batch?.status !== 'failed', 'CSV_BATCH_FAILED');
      if (batch?.status === 'ready') break;
      requireCheck(clock() < deadline && polls < 31, 'CSV_WORKER_TIMEOUT');
      await sleep(2000);
    } while (true);
    requireCheck(batch.rows?.length === 4 && batch.rows.filter((row) => row.status === 'suggested').length === 2 && batch.rows.some((row) => row.status === 'ambiguous') && batch.rows.some((row) => row.status === 'rejected'), 'CSV_REVIEW_STATES_MISMATCH');
    const before = await request('GET', `${base}/balances`, operatorToken);
    requireCheck(before.balances.every((balance) => balance.paidMinor === '0'), 'IMPORT_APPLIED_WITHOUT_CONFIRMATION');
    passed(activeCheck, { bytes: Buffer.byteLength(csv), rows: batch.rows.length, polls });

    activeCheck = 'importer_cannot_confirm';
    const firstInput = { operationId: `allocation-${runId}-500`, batchId: sha256, rowId: '2', participantId, expectedVersion: 0 };
    await request('POST', `${base}/allocations`, tokens.get('importer'), firstInput, 403); passed(activeCheck);

    activeCheck = 'explicit_confirmations_and_idempotency';
    const first = await request('POST', `${base}/allocations`, operatorToken, firstInput);
    const replay = await request('POST', `${base}/allocations`, operatorToken, firstInput);
    requireCheck(first.movement?.movementId && replay.movement?.movementId === first.movement.movementId && replay.version === first.version, 'ALLOCATION_REPLAY_MISMATCH');
    const second = await request('POST', `${base}/allocations`, operatorToken, { operationId: `allocation-${runId}-750`, batchId: sha256, rowId: '3', participantId, expectedVersion: first.version });
    requireCheck(second.version === 2, 'CONFIRMATION_VERSION_MISMATCH'); passed(activeCheck);

    activeCheck = 'reversal_preserves_history';
    const reversal = await request('POST', `${base}/movements/${first.movement.movementId}/reversals`, operatorToken, { operationId: `reversal-${runId}`, expectedVersion: second.version });
    requireCheck(reversal.version === 3 && reversal.movement?.reversalOf === first.movement.movementId, 'REVERSAL_HISTORY_MISMATCH'); passed(activeCheck);

    activeCheck = 'repeated_file_is_one_batch';
    const repeated = await request('POST', `${base}/imports`, operatorToken, importInput, 201);
    requireCheck(repeated.batch?.batchId === sha256, 'REPEATED_BATCH_ID_MISMATCH');
    await upload(repeated.upload, csv);
    const imports = await request('GET', `${base}/imports`, operatorToken);
    requireCheck(imports.batches?.length === 1, 'REPEATED_FILE_CREATED_BATCH'); passed(activeCheck);

    activeCheck = 'final_balance_and_movements';
    const ledger = await request('GET', `${base}/movements`, operatorToken);
    const balances = await request('GET', `${base}/balances`, operatorToken);
    requireCheck(ledger.movements?.length === 3 && ledger.movements.filter((movement) => movement.kind === 'payment').length === 2 && ledger.movements.filter((movement) => movement.kind === 'reversal').length === 1, 'MOVEMENT_HISTORY_MISMATCH');
    const total = balances.balances.reduce((sum, balance) => sum + BigInt(balance.paidMinor), 0n).toString();
    requireCheck(total === '75000' && balances.version === 3, 'FINAL_BALANCE_MISMATCH');
    report.metrics = { currency: 'MXN', paidMinor: total, movements: ledger.movements.length, ledgerVersion: balances.version, batches: imports.batches.length, participants: 3 };
    passed(activeCheck, { paidMinor: total, movements: 3 });

    activeCheck = 'self_service_provisioning';
    const selfServiceToken = tokens.get('selfService');
    let selfClaims;
    try { selfClaims = JSON.parse(Buffer.from(selfServiceToken.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new SmokeFailure('SELF_SERVICE_TOKEN_INVALID'); }
    requireCheck(typeof selfClaims.sub === 'string' && selfClaims.sub.length <= 128, 'SELF_SERVICE_TOKEN_INVALID');
    const expectedOrganization = `org-${createHash('sha256').update(JSON.stringify([target.userPoolId,selfClaims.sub])).digest('hex').slice(0,32)}`;
    requireCheck(selfClaims['custom:organizationId'] === expectedOrganization && selfClaims['custom:roles'] === 'admin' && selfClaims['custom:tier'] === 'pilot' && ![organizationA,organizationB].includes(expectedOrganization), 'SELF_SERVICE_IDENTITY_MISMATCH');
    // JWT decoding above is an assertion only; HTTP API performs the signature/issuer/audience validation.
    await request('GET', `${base}/participants`, selfServiceToken, undefined, 404);
    const emptyWorkspace = await request('GET', '/api/v1/events', selfServiceToken);
    requireCheck(Array.isArray(emptyWorkspace.events) && emptyWorkspace.events.length === 0, 'SELF_SERVICE_WORKSPACE_NOT_ISOLATED');
    const ownEventId = `signup-${runId}`;
    const ownEvent = await request('POST','/api/v1/events',selfServiceToken,{ eventId:ownEventId, operationId:`signup-${runId}`, name:`[SINTÉTICO REGISTRO ${runId}] SaldoEvento ${target.environment}`, currency:'MXN' },201);
    requireCheck(ownEvent.event?.eventId === ownEventId, 'SELF_SERVICE_EVENT_FAILED');
    await request('GET', `/api/v1/events/${ownEventId}/participants`, operatorToken, undefined, 404);
    report.synthetic.selfServiceEventId = ownEventId;
    report.synthetic.selfServiceOrganizationId = expectedOrganization;
    passed(activeCheck,{ organizationAssignedByServer:true, roles:'admin', tier:'pilot', crossTenantAccess:'rejected' });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    // Provider/transport errors can contain passwords, JWTs or presigned URLs.
    // Persist only our controlled failure codes, never raw error messages.
    report.checks.push({ name: activeCheck, status: 'failed', code: error instanceof SmokeFailure ? error.code : 'PROVIDER_OR_TRANSPORT_FAILURE' });
  } finally {
    tokens.clear();
    for (const username of attemptedUsers.reverse()) {
      try { await cognito.deleteUser({ ...target, username }); report.cleanup.deletedUsers++; }
      catch { report.cleanup.failures++; }
    }
    if (report.cleanup.failures) { report.status = 'failed'; report.checks.push({ name: 'temporary_identity_cleanup', status: 'failed', code: 'COGNITO_CLEANUP_FAILED' }); }
    else passed('temporary_identity_cleanup', { deletedUsers: report.cleanup.deletedUsers });
    report.completedAt = new Date(clock()).toISOString();
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const stackDescription = describeStack(options);
  const target = validateCloudTarget(options.stack, stackDescription);
  const cognito = await createCognitoAdapter({ region: options.region });
  const report = await runCloudSmoke({ stackName: options.stack, stackDescription, region: options.region, cognito });
  const outputDir = path.join(repositoryRoot, 'artifacts/deployments', target.stage);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'cloud-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error instanceof SmokeFailure ? error.code : 'SMOKE_SETUP_FAILED' })); process.exitCode = 1; }
}
