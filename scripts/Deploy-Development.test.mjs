import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('./Deploy-Development.ps1', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

async function runGuard(powershell, argumentsText) {
  await assert.doesNotReject(access(script), 'Development deployment script must exist');
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', powershell + `\ntry { & '${script.replaceAll("'", "''")}' ${argumentsText}; exit 0 } catch { Write-Output $_.Exception.Message; exit 7 }`], { cwd: root, encoding: 'utf8' });
}

test('development deploy script is valid PowerShell syntax', async () => {
  await assert.doesNotReject(access(script), 'Development deployment script must exist');
  const output = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }; Write-Output 'valid'`], { encoding: 'utf8' });
  assert.match(output, /valid/);
});

test('production branch stops before any AWS call', async () => {
  try {
    await runGuard("function global:git { if ($args[0] -eq 'branch') { 'main' } else { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; $global:LASTEXITCODE = 0 }; function global:aws { throw 'AWS_MUST_NOT_RUN' }", '-SkipChecks');
    assert.fail('main must be rejected');
  } catch (error) {
    assert.match(String(error.stdout ?? error), /branch.*feature\/saldoevento-v1.*development/i);
    assert.doesNotMatch(String(error.stdout ?? error), /AWS_MUST_NOT_RUN/);
  }
});

test('execution requires a named reviewed change set before any AWS mutation', async () => {
  try {
    await runGuard("function global:git { if ($args[0] -eq 'branch') { 'feature/saldoevento-v1' } else { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; $global:LASTEXITCODE = 0 }; function global:aws { throw 'AWS_MUST_NOT_RUN' }", '-Execute');
    assert.fail('unnamed execution must be rejected');
  } catch (error) {
    assert.match(String(error.stdout ?? error), /ChangeSetName.*review/i);
    assert.doesNotMatch(String(error.stdout ?? error), /AWS_MUST_NOT_RUN/);
  }
});

test('artifact bootstrap retains a private encrypted bucket with 90-day expiry', async () => {
  const template = parse(await readFile(new URL('../infra/artifacts.yaml', import.meta.url), 'utf8'));
  const bucket = template.Resources.ArtifactsBucket;
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.equal(bucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 90);
});

test('offline preview never executes, and reviewed CREATE uses the creation waiter before asset upload', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'saldoevento-deploy-'));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  try {
    for (const directory of ['scripts', 'infra/environments', 'services/node_modules', 'artifacts/frontend/browser']) await mkdir(path.join(fixture, directory), { recursive: true });
    await cp(script, path.join(fixture, 'scripts/Deploy-Development.ps1'));
    await writeFile(path.join(fixture, 'infra/environments/dev.json'), JSON.stringify([{ ParameterKey: 'Stage', ParameterValue: 'dev' }]));
    for (const filename of ['infra/template.yaml', 'infra/artifacts.yaml', 'services/package.json', 'services/package-lock.json', 'artifacts/frontend/index.mjs']) await writeFile(path.join(fixture, filename), '{}');
    await writeFile(path.join(fixture, 'artifacts/frontend/manifest.json'), JSON.stringify({ contentSha256: 'test-fingerprint' }));
    await writeFile(path.join(fixture, 'evidence.json'), JSON.stringify({ passed: true, sourceCommit: 'a'.repeat(40), frontendContentSha256: 'test-fingerprint' }));
    const log = path.join(fixture, 'aws-calls.jsonl');
    const review = { ChangeSetId: 'arn:aws:cloudformation:us-east-1:765932874577:changeSet/test-preview/id', StackId: 'arn:aws:cloudformation:us-east-1:765932874577:stack/saldoevento-dev/id', StackName: 'saldoevento-dev', Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Parameters: [], Changes: [{ ResourceChange: { Action: 'Add', LogicalResourceId: 'EventsTable', ResourceType: 'AWS::DynamoDB::Table' } }] };
    const mock = (executing, pendingReview = false) => `
function global:git { if ($args[0] -eq 'branch') { 'feature/saldoevento-v1' } else { '${'a'.repeat(40)}' }; $global:LASTEXITCODE = 0 }
function global:aws {
  $invokeArguments = @($args)
  Add-Content -LiteralPath ${quote(log)} -Value (ConvertTo-Json -InputObject $invokeArguments -Compress)
  $global:LASTEXITCODE = 0
  $operation = "$($args[0])/$($args[1])"
  if ($operation -eq 'sts/get-caller-identity') { '{"Account":"765932874577"}'; return }
  if ($operation -eq 'cloudformation/describe-change-set') { ${quote(JSON.stringify(review))}; return }
  if ($operation -eq 'cloudformation/describe-stacks') {
    $stack = $args[[Array]::IndexOf($args, '--stack-name') + 1]
    if ($stack -eq 'saldoevento-artifacts') { '{"Stacks":[{"Outputs":[{"OutputKey":"ArtifactsBucketName","OutputValue":"mock-artifacts-bucket"}]}]}'; return }
    ${executing ? `'{"Stacks":[{"Outputs":[{"OutputKey":"FrontendAssetsBucketName","OutputValue":"mock-dev-assets"}]}]}'; return` : pendingReview ? "'{\"Stacks\":[{\"StackStatus\":\"REVIEW_IN_PROGRESS\"}]}'; return" : "$global:LASTEXITCODE = 254; 'Stack does not exist'; return"}
  }
  if ($operation -eq 'cloudformation/package') { $destination = $args[[Array]::IndexOf($args, '--output-template-file') + 1]; Set-Content -LiteralPath $destination -Value 'Resources: {}'; return }
  if ($operation -in @('cloudformation/deploy','cloudformation/create-change-set','cloudformation/wait','s3/sync','s3/cp')) { return }
  if ($operation -eq 'cloudformation/execute-change-set') { ${executing ? 'return' : "throw 'PREVIEW_MUST_NOT_EXECUTE'"} }
  throw "Unexpected mocked AWS operation $operation"
}
`;
    const fixtureScript = path.join(fixture, 'scripts/Deploy-Development.ps1');
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', mock(false) + `\n& ${quote(fixtureScript)} -SkipChecks -ChecksEvidencePath ${quote(path.join(fixture, 'evidence.json'))} -ChangeSetName test-preview`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const previewCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(previewCalls.some((args) => args.includes('create-change-set')));
    assert.ok(!previewCalls.some((args) => args.includes('execute-change-set')));
    const savedReview = JSON.parse(await readFile(path.join(fixture, 'artifacts/deployments/dev/test-preview.json'), 'utf8'));
    assert.equal(savedReview.ChangeSetId, review.ChangeSetId);

    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', mock(false, true) + `\n& ${quote(fixtureScript)} -SkipChecks -ChecksEvidencePath ${quote(path.join(fixture, 'evidence.json'))} -ChangeSetName second-preview`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const repeatedPreview = JSON.parse(await readFile(path.join(fixture, 'artifacts/deployments/dev/second-preview.metadata.json'), 'utf8'));
    assert.equal(repeatedPreview.changeSetType, 'CREATE', 'An unexecuted stack review must still use CREATE');

    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', mock(true) + `\n& ${quote(fixtureScript)} -Execute -ChangeSetName test-preview`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const allCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const execute = allCalls.findIndex((args) => args.includes('execute-change-set'));
    const waiter = allCalls.findIndex((args) => args.includes('stack-create-complete'));
    const sync = allCalls.findIndex((args) => args[0] === 's3' && args[1] === 'sync');
    assert.ok(execute >= 0 && waiter > execute && sync > waiter);
    assert.ok(!allCalls.some((args) => args.includes('stack-update-complete')));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
