import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./Deploy-Testing.ps1', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const commit = 'a'.repeat(40);
const gitMock = ({ branch = 'testing', dirty = false, remoteCommit = commit } = {}) => `
function global:git {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'branch') { '${branch}'; return }
  if ($args -contains 'status') { ${dirty ? "' M user-change.txt'" : ''}; return }
  if ($args[0] -eq 'remote') { 'https://github.com/LynxPardelle/abonos-por-evento.git'; return }
  if ($args[0] -eq 'ls-remote') { '${remoteCommit} refs/heads/testing'; return }
  '${commit}'
}
`;

function run(source, target = script, argumentsText = '-SkipChecks') {
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', source + `\ntry { & ${quote(target)} ${argumentsText}; exit 0 } catch { Write-Output $_.Exception.Message; exit 7 }`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('testing deployment script exists and is valid PowerShell', async () => {
  await access(script);
  const output = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count){$errors|Out-String|Write-Output;exit 1}; 'valid'`], { encoding: 'utf8' });
  assert.match(output, /valid/);
});

test('main, development and feature branches stop before any AWS call', async () => {
  await access(script);
  for (const branch of ['main', 'development', 'feature/saldoevento-v1']) {
    assert.throws(() => run(gitMock({ branch }) + "function global:aws { throw 'AWS_MUST_NOT_RUN' }"), error => /branch must be testing/i.test(String(error.stdout)) && !String(error.stdout).includes('AWS_MUST_NOT_RUN'));
  }
});

test('uncommitted changes and commits absent from remote testing stop before AWS', async () => {
  await access(script);
  for (const options of [{ dirty: true }, { remoteCommit: 'b'.repeat(40) }]) {
    assert.throws(() => run(gitMock(options) + "function global:aws { throw 'AWS_MUST_NOT_RUN' }"), error => /clean|remote testing/i.test(String(error.stdout)) && !String(error.stdout).includes('AWS_MUST_NOT_RUN'));
  }
});

test('unnamed execution cannot make an AWS call', async () => {
  await access(script);
  assert.throws(() => run(gitMock() + "function global:aws { throw 'AWS_MUST_NOT_RUN' }", script, '-Execute'), error => /ChangeSetName.*review/i.test(String(error.stdout)) && !String(error.stdout).includes('AWS_MUST_NOT_RUN'));
});

test('testing preview is isolated and reviewed execution uses the promoted source and original artifacts', async () => {
  await access(script);
  const fixture = await mkdtemp(path.join(tmpdir(), 'saldoevento-testing-'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  try {
    for (const directory of ['scripts', 'infra/environments', 'services/node_modules', 'artifacts/frontend/browser']) await mkdir(path.join(fixture, directory), { recursive: true });
    await cp(script, path.join(fixture, 'scripts/Deploy-Testing.ps1'));
    const testingParameters = [{ ParameterKey: 'Stage', ParameterValue: 'test' }, { ParameterKey: 'PublicOrigin', ParameterValue: 'https://saldoevento-test.lynxpardelle.com' }, { ParameterKey: 'SelfRegistrationEnabled', ParameterValue: 'true' }];
    const parameterFile = path.join(fixture, 'infra/environments/test.json');
    await writeFile(parameterFile, JSON.stringify(testingParameters));
    for (const file of ['infra/template.yaml', 'services/package.json', 'services/package-lock.json', 'artifacts/frontend/index.mjs']) await writeFile(path.join(fixture, file), '{}');
    await writeFile(path.join(fixture, 'artifacts/frontend/browser/main.js'), 'synthetic-module');
    const manifest = { sourceCommit: commit, contentSha256: 'test-fingerprint', files: { 'index.mjs': sha('{}'), 'browser/main.js': sha('synthetic-module') } };
    await writeFile(path.join(fixture, 'artifacts/frontend/manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(fixture, 'evidence.json'), JSON.stringify({ passed: true, sourceCommit: commit, frontendContentSha256: manifest.contentSha256 }));
    const log = path.join(fixture, 'aws-calls.jsonl');
    const review = { ChangeSetId: 'arn:aws:cloudformation:us-east-1:765932874577:changeSet/testing-preview/id', StackId: 'arn:aws:cloudformation:us-east-1:765932874577:stack/saldoevento-test/id', StackName: 'saldoevento-test', Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Parameters: [], Changes: [{ ResourceChange: { Action: 'Add', LogicalResourceId: 'EventsTable', ResourceType: 'AWS::DynamoDB::Table' } }] };
    const mock = executing => gitMock() + `
function global:aws {
  $invokeArguments=@($args); Add-Content -LiteralPath ${quote(log)} -Value (ConvertTo-Json -InputObject $invokeArguments -Compress); $global:LASTEXITCODE=0
  $operation="$($args[0])/$($args[1])"
  if($operation -eq 'sts/get-caller-identity') { '{"Account":"765932874577"}';return }
  if($operation -eq 'cloudformation/describe-change-set') { ${quote(JSON.stringify(review))};return }
  if($operation -eq 'cloudformation/describe-stacks') {
    $stack=$args[[Array]::IndexOf($args,'--stack-name')+1]
    if($stack -eq 'saldoevento-artifacts') { '{"Stacks":[{"StackStatus":"CREATE_COMPLETE","Outputs":[{"OutputKey":"ArtifactsBucketName","OutputValue":"mock-artifacts"}]}]}';return }
    ${executing ? "'{\"Stacks\":[{\"Outputs\":[{\"OutputKey\":\"FrontendAssetsBucketName\",\"OutputValue\":\"mock-testing-assets\"}]}]}';return" : "$global:LASTEXITCODE=254; 'Stack does not exist';return"}
  }
  if($operation -eq 'cloudformation/package') {$destination=$args[[Array]::IndexOf($args,'--output-template-file')+1];Set-Content -LiteralPath $destination -Value 'Resources: {}';return}
  if($operation -in @('cloudformation/create-change-set','cloudformation/wait','s3/sync','s3/cp')) {return}
  if($operation -eq 'cloudformation/execute-change-set') {${executing ? 'return' : "throw 'PREVIEW_MUST_NOT_EXECUTE'"}}
  throw "Unexpected AWS call $operation"
}
`;
    const target = path.join(fixture, 'scripts/Deploy-Testing.ps1');
    run(mock(false), target, `-SkipChecks -ChecksEvidencePath ${quote(path.join(fixture, 'evidence.json'))} -ChangeSetName testing-preview`);
    const preview = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(preview.some(args => args.includes('create-change-set')));
    assert.ok(!preview.some(args => args.includes('execute-change-set') || args.includes('deploy')));
    assert.ok(preview.every(args => !args.includes('saldoevento-dev') && !args.includes('saldoevento-prod')));
    const metadata = JSON.parse(await readFile(path.join(fixture, 'artifacts/deployments/test/testing-preview.metadata.json'), 'utf8'));
    assert.equal(metadata.sourceCommit, commit);
    assert.equal(metadata.frontendContentSha256, manifest.contentSha256);
    run(mock(true), target, '-Execute -ChangeSetName testing-preview');
    const allCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const execute = allCalls.findIndex(args => args.includes('execute-change-set'));
    const waiter = allCalls.findIndex(args => args.includes('stack-create-complete'));
    const sync = allCalls.findIndex(args => args[0] === 's3' && args[1] === 'sync');
    assert.ok(execute >= 0 && waiter > execute && sync > waiter);
    await writeFile(parameterFile, JSON.stringify(testingParameters.map(parameter => parameter.ParameterKey === 'SelfRegistrationEnabled' ? { ...parameter, ParameterValue: 'false' } : parameter)));
    assert.throws(() => run(mock(false), target, `-SkipChecks -ChecksEvidencePath ${quote(path.join(fixture, 'evidence.json'))} -ChangeSetName disabled-registration`), error => /registration.*enabled/i.test(String(error.stdout)));
    await writeFile(parameterFile, JSON.stringify(testingParameters));
    await writeFile(path.join(fixture, 'artifacts/frontend/browser/main.js'), 'changed-after-review');
    assert.throws(() => run(mock(true), target, '-Execute -ChangeSetName testing-preview'), error => /artifact.*changed|checksum/i.test(String(error.stdout)));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
