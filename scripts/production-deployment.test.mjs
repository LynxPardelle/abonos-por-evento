import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./Deploy-Production.ps1', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const q = value => `'${value.replaceAll("'", "''")}'`;
const commit = 'a'.repeat(40);
const sha = value => createHash('sha256').update(value).digest('hex');
const parameters = [
  ['Stage', 'prod'], ['PublicOrigin', 'https://saldoevento.zooberiahsystems.com'],
  ['HostedZoneId', 'Z00733952JM7567FL6HXC'], ['SelfRegistrationEnabled', 'true'],
  ['CertificateArn', 'arn:aws:acm:us-east-1:765932874577:certificate/11111111-2222-3333-4444-555555555555'],
].map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
const resources = Object.fromEntries([
  ['UserPool', 'AWS::Cognito::UserPool'], ['UserPoolClient', 'AWS::Cognito::UserPoolClient'],
  ['IdentityTable', 'AWS::DynamoDB::Table'], ['EventsTable', 'AWS::DynamoDB::Table'],
  ['ReconciliationTable', 'AWS::DynamoDB::Table'], ['ImportsBucket', 'AWS::S3::Bucket'],
  ['FrontendAssetsBucket', 'AWS::S3::Bucket'], ['FrontendDistribution', 'AWS::CloudFront::Distribution'],
  ['BusinessApi', 'AWS::ApiGatewayV2::Api'],
].map(([LogicalResourceId, ResourceType]) => [LogicalResourceId, { LogicalResourceId, ResourceType, PhysicalResourceId: `existing-${LogicalResourceId}` }]));
resources.FrontendAssetsBucket.PhysicalResourceId = 'saldoevento-prod-frontendassetsbucket-existing';
const change = (LogicalResourceId, ResourceType, Replacement = 'False', Action = 'Modify') => ({ Type: 'Resource', ResourceChange: { LogicalResourceId, ResourceType, Replacement, Action } });
const review = {
  StackName: 'saldoevento-prod', ChangeSetName: 'production-review', Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
  StackId: 'arn:aws:cloudformation:us-east-1:765932874577:stack/saldoevento-prod/existing',
  ChangeSetId: 'arn:aws:cloudformation:us-east-1:765932874577:changeSet/production-review/new',
  Parameters: parameters, Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'],
  Changes: [change('UserPoolClient', 'AWS::Cognito::UserPoolClient'), change('FrontendDistribution', 'AWS::CloudFront::Distribution'), change('TriggerPermission', 'AWS::Lambda::Permission', 'Conditional')],
};

function ps(code, fixture = root) {
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `$ErrorActionPreference='Stop'; . ${q(script)} -RepoRoot ${q(fixture)}; try { ${code}; exit 0 } catch { Write-Output $_.Exception.Message; exit 7 }`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const rejects = (code, expression, fixture) => assert.throws(() => ps(code, fixture), error => expression.test(String(error.stdout)));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'saldoevento-production-'));
  for (const child of ['infra/environments', 'services/node_modules', 'artifacts/frontend/browser/fonts']) await mkdir(path.join(directory, child), { recursive: true });
  const template = {
    Conditions: { IsNonProduction: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] }] } },
    Resources: Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, { Type: value.ResourceType, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {} }])),
  };
  template.Resources.UserPoolClient.Properties.ExplicitAuthFlows = ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH', { 'Fn::If': ['IsNonProduction', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', { Ref: 'AWS::NoValue' }] }];
  await writeFile(path.join(directory, 'infra/template.yaml'), JSON.stringify(template));
  await writeFile(path.join(directory, 'infra/environments/prod.json'), JSON.stringify(parameters));
  for (const file of ['services/package.json', 'services/package-lock.json']) await writeFile(path.join(directory, file), '{}');
  const files = { 'browser/main-ABCD1234.js': sha('synthetic'), 'browser/favicon.svg': sha('icon'), 'browser/ejemplo-importacion.csv': sha('sample'), 'browser/fonts/dm-sans-variable.ttf': sha('font'), 'browser/index.html': sha('html') };
  for (const [filename, value] of Object.entries({ 'browser/main-ABCD1234.js': 'synthetic', 'browser/favicon.svg': 'icon', 'browser/ejemplo-importacion.csv': 'sample', 'browser/fonts/dm-sans-variable.ttf': 'font', 'browser/index.html': 'html' })) await writeFile(path.join(directory, 'artifacts/frontend', filename), value);
  const manifest = { sourceCommit: commit, contentSha256: sha(JSON.stringify(files)), files };
  await writeFile(path.join(directory, 'artifacts/frontend/manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, sourceCommit: commit, frontendContentSha256: manifest.contentSha256 }));
  return { directory, template, manifest };
}

const mock = (directory, { branch = 'main', dirty = false, remoteCommit = commit, account = '765932874577', state = 'AVAILABLE', changes = review.Changes, changedStackTemplate = false, missingSan = false, changedResource = false } = {}) => `
function global:git {
  $global:LASTEXITCODE=0
  if($args[0] -eq 'branch'){ '${branch}'; return }
  if($args -contains 'status'){ ${dirty ? "' M preserved.txt'" : ''}; return }
  if($args[0] -eq 'remote'){ 'https://github.com/LynxPardelle/abonos-por-evento.git'; return }
  if($args[0] -eq 'ls-remote'){ '${remoteCommit} refs/heads/main'; return }
  if($args[0] -eq 'rev-parse' -and $args[1] -eq '--show-toplevel'){ ${q(directory)}; return }
  '${commit}'
}
function global:aws {
  $global:LASTEXITCODE=0; $operation="$($args[0])/$($args[1])"
  Add-Content -LiteralPath ${q(path.join(directory, 'calls.jsonl'))} -Value (ConvertTo-Json -InputObject @($args) -Compress)
  switch($operation){
    'sts/get-caller-identity' { '${JSON.stringify({ Account: account })}'; return }
    'acm/describe-certificate' { '${JSON.stringify({ Certificate: { Status: 'ISSUED', DomainName: 'saldoevento.zooberiahsystems.com', SubjectAlternativeNames: missingSan ? ['saldoevento.zooberiahsystems.com'] : ['saldoevento.zooberiahsystems.com', 'saldoevento.lynxpardelle.com'] } })}'; return }
    'cloudformation/describe-stacks' {
      if($args -contains 'saldoevento-artifacts'){ '{"Stacks":[{"StackStatus":"CREATE_COMPLETE","Outputs":[{"OutputKey":"ArtifactsBucketName","OutputValue":"saldoevento-artifacts-artifactsbucket-existing"}]}]}'; return }
      '${JSON.stringify({ Stacks: [{ StackId: review.StackId, StackName: 'saldoevento-prod', StackStatus: 'UPDATE_COMPLETE', Parameters: parameters.toReversed(), Outputs: [{ OutputKey: 'FrontendAssetsBucketName', OutputValue: resources.FrontendAssetsBucket.PhysicalResourceId }] }] })}'; return
    }
    'cloudformation/list-stack-resources' { '${JSON.stringify({ StackResourceSummaries: Object.values(resources).map(r => changedResource && r.LogicalResourceId === 'UserPool' ? { ...r, PhysicalResourceId: 'different-pool' } : r) })}'; return }
    'cloudformation/package' { $destination=$args[[Array]::IndexOf($args,'--output-template-file')+1]; Copy-Item -LiteralPath ${q(path.join(directory, 'infra/template.yaml'))} -Destination $destination; return }
    'cloudformation/describe-change-set' { '${JSON.stringify({ ...review, ExecutionStatus: state, Changes: changes })}'; return }
    'cloudformation/get-template' { $body=Get-Content -Raw -LiteralPath ${q(path.join(directory, 'infra/template.yaml'))}|ConvertFrom-Json; ${changedStackTemplate ? '$body | Add-Member -NotePropertyName Description -NotePropertyValue different;' : ''} @{TemplateBody=$body}|ConvertTo-Json -Depth 100 -Compress; return }
    'cloudfront/get-distribution' { '${JSON.stringify({ Distribution: { Status: 'Deployed', DistributionConfig: { Aliases: { Items: ['saldoevento.zooberiahsystems.com', 'saldoevento.lynxpardelle.com'] } } } })}'; return }
    {$_ -in @('cloudformation/create-change-set','cloudformation/wait','cloudformation/execute-change-set','cloudfront/wait','s3/cp')} { return }
    default { throw "UNEXPECTED_AWS $operation" }
  }
}
`;
const invoke = (directory, execute = false) => `Invoke-ProductionDeployment ${execute ? '-Execute' : '-SkipChecks -ChecksEvidencePath ' + q(path.join(directory, 'evidence.json'))} -ChangeSetName production-review`;
const calls = async directory => (await readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);

test('production helper exists and dot-sourcing it makes no network or deployment calls', async () => {
  await access(script);
  assert.match(ps("'functions-loaded'"), /functions-loaded/);
});

test('non-main, dirty source and unpromoted HEAD stop before AWS', () => {
  for (const options of [{ branch: 'testing' }, { branch: 'development' }, { dirty: true }, { remoteCommit: 'b'.repeat(40) }]) {
    rejects(mock(root, options) + "function global:aws { throw 'AWS_MUST_NOT_RUN' }; " + invoke(root), /main|clean|remote/i);
  }
});

test('production parameters reject wrong stage/origin/zone, duplicates and unapproved certificate account', () => {
  ps(`Assert-ProductionParameters (${q(JSON.stringify(parameters))}|ConvertFrom-Json)`);
  for (const [key, value] of [['Stage', 'test'], ['PublicOrigin', 'https://saldoevento-test.lynxpardelle.com'], ['HostedZoneId', 'ZWRONG'], ['SelfRegistrationEnabled', 'false'], ['CertificateArn', parameters.at(-1).ParameterValue.replace('765932874577', '111111111111')]]) {
    const wrong = parameters.map(p => p.ParameterKey === key ? { ...p, ParameterValue: value } : p);
    rejects(`Assert-ProductionParameters (${q(JSON.stringify(wrong))}|ConvertFrom-Json)`, /parameter|certificate/i);
  }
  rejects(`Assert-ProductionParameters (${q(JSON.stringify([...parameters, parameters[0]]))}|ConvertFrom-Json)`, /parameter/i);
});

test('protected replacements/removals fail, permission-only conditional replacement is allowed and review includes changes/parameters', () => {
  ps(`Assert-ProductionChangeSet (${q(JSON.stringify(review))}|ConvertFrom-Json) production-review`);
  for (const r of Object.values(resources)) for (const [replacement, action] of [['True', 'Modify'], ['Conditional', 'Modify'], ['False', 'Remove']]) {
    rejects(`Assert-ProductionChangeSet (${q(JSON.stringify({ ...review, Changes: [change(r.LogicalResourceId, r.ResourceType, replacement, action)] }))}|ConvertFrom-Json) production-review`, /protected|remov|replace/i);
  }
  rejects(`Assert-ProductionChangeSet (${q(JSON.stringify({ ...review, Changes: [change('NewPool', 'AWS::Cognito::UserPool', 'False', 'Add')] }))}|ConvertFrom-Json) production-review`, /protected|migration/i);
  const changed = structuredClone(review); changed.Parameters[0].ParameterValue = 'test';
  const output = ps(`$a=${q(JSON.stringify(review))}|ConvertFrom-Json; $b=${q(JSON.stringify(changed))}|ConvertFrom-Json; if((Get-ReviewFingerprint $a) -eq (Get-ReviewFingerprint $b)){throw 'fingerprint ignored parameters'}; $b=$a|ConvertTo-Json -Depth 100|ConvertFrom-Json; $b.Changes[0].ResourceChange.Replacement='True'; if((Get-ReviewFingerprint $a) -eq (Get-ReviewFingerprint $b)){throw 'fingerprint ignored changes'}; 'frozen'`);
  assert.match(output, /frozen/);
});

test('parameter attestation ignores AWS list order and Stripe runtime/dependencies cannot be approved', async () => {
  assert.match(ps(`$a=${q(JSON.stringify(parameters))}|ConvertFrom-Json; $b=@($a|Sort-Object ParameterKey); if((Get-ParametersHash $a) -ne (Get-ParametersHash $b)){throw 'parameter order differs'}; 'canonical'`), /canonical/);
  const f = await fixture();
  try {
    await writeFile(path.join(f.directory, 'services/package.json'), JSON.stringify({ dependencies: { stripe: '1.0.0' } }));
    rejects('Assert-NoBillingInputs', /stripe|billing/i, f.directory);
    await writeFile(path.join(f.directory, 'services/package.json'), '{}');
    await writeFile(path.join(f.directory, 'artifacts/frontend/browser/main-ABCD1234.js'), 'fetch("https://checkout.stripe.com/somewhere")');
    rejects('Assert-NoBillingInputs', /stripe|billing/i, f.directory);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('manifest checks aggregate hash, each file, exact file set and path escape', async () => {
  const f = await fixture();
  try {
    ps(`Assert-FrontendArtifact '${commit}'|Out-Null`, f.directory);
    const file = path.join(f.directory, 'artifacts/frontend/browser/main-ABCD1234.js');
    await writeFile(file, 'tampered'); rejects(`Assert-FrontendArtifact '${commit}'`, /checksum/i, f.directory);
    await writeFile(file, 'synthetic');
    await writeFile(path.join(f.directory, 'artifacts/frontend/extra.js'), 'extra'); rejects(`Assert-FrontendArtifact '${commit}'`, /unlisted|file set/i, f.directory);
    await rm(path.join(f.directory, 'artifacts/frontend/extra.js'));
    const manifest = { ...f.manifest, contentSha256: '0'.repeat(64) };
    await writeFile(path.join(f.directory, 'artifacts/frontend/manifest.json'), JSON.stringify(manifest)); rejects(`Assert-FrontendArtifact '${commit}'`, /fingerprint/i, f.directory);
    manifest.files = { '../outside': sha('out') }; manifest.contentSha256 = sha(JSON.stringify(manifest.files));
    await writeFile(path.join(f.directory, 'artifacts/frontend/manifest.json'), JSON.stringify(manifest)); rejects(`Assert-FrontendArtifact '${commit}'`, /path/i, f.directory);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('preview is UPDATE-only; execute preloads immutable assets, preserves identities and resumes without executing twice', async () => {
  const f = await fixture();
  try {
    ps(mock(f.directory) + invoke(f.directory), f.directory);
    const preview = await calls(f.directory);
    const create = preview.find(c => c[1] === 'create-change-set');
    assert.equal(create[create.indexOf('--change-set-type') + 1], 'UPDATE');
    assert.ok(!preview.some(c => ['execute-change-set', 'cp', 'sync'].includes(c[1])));
    const metadata = JSON.parse(await readFile(path.join(f.directory, 'artifacts/deployments/prod/production-review.metadata.json'), 'utf8'));
    assert.equal(metadata.sourceCommit, commit); assert.equal(metadata.changeSetType, 'UPDATE');
    await writeFile(path.join(f.directory, 'calls.jsonl'), '');
    ps(mock(f.directory) + invoke(f.directory, true), f.directory);
    const executed = await calls(f.directory);
    const executeIndex = executed.findIndex(c => c[1] === 'execute-change-set');
    const immutable = executed.findIndex(c => c[0] === 's3' && c.some(v => String(v).endsWith('main-ABCD1234.js')));
    const favicon = executed.findIndex(c => c[0] === 's3' && c.some(v => String(v).endsWith('favicon.svg')));
    assert.ok(immutable >= 0 && immutable < executeIndex, 'hashed assets must exist before new Lambda can serve HTML');
    assert.ok(favicon > executeIndex, 'unversioned assets wait for successful CF update');
    for (const stableFile of ['ejemplo-importacion.csv', 'dm-sans-variable.ttf']) {
      const uploadIndex = executed.findIndex(c => c[0] === 's3' && c.some(v => String(v).endsWith(stableFile)));
      assert.ok(uploadIndex > executeIndex, `${stableFile} has no content hash and must wait for CF`);
      assert.ok(executed[uploadIndex].includes('public,max-age=300'));
    }
    assert.ok(executed.every(c => !c.includes('--delete') && !['create-user-pool', 'admin-initiate-auth'].includes(c[1])));
    await writeFile(path.join(f.directory, 'calls.jsonl'), '');
    ps(mock(f.directory, { state: 'EXECUTE_COMPLETE' }) + invoke(f.directory, true), f.directory);
    const resumed = await calls(f.directory);
    assert.ok(!resumed.some(c => c[1] === 'execute-change-set'));
    assert.ok(resumed.some(c => c[1] === 'get-template'));
    rejects(mock(f.directory, { state: 'EXECUTE_COMPLETE', changedStackTemplate: true }) + invoke(f.directory, true), /template|later update/i, f.directory);
    rejects(mock(f.directory, { state: 'EXECUTE_COMPLETE', changedResource: true }) + invoke(f.directory, true), /protected|identity|resource/i, f.directory);
    rejects(mock(f.directory, { state: 'OBSOLETE' }) + invoke(f.directory, true), /execution|obsolete|state/i, f.directory);
    const content = await readFile(path.join(f.directory, 'artifacts/deployments/prod/production-review.packaged.yaml'), 'utf8');
    await writeFile(path.join(f.directory, 'artifacts/deployments/prod/production-review.packaged.yaml'), content + ' ');
    rejects(mock(f.directory) + invoke(f.directory, true), /changed|hash/i, f.directory);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('wrong account, missing certificate SAN and production admin-password regression stop before package or execute', async () => {
  const f = await fixture();
  try {
    rejects(mock(f.directory, { account: '111111111111' }) + invoke(f.directory), /account/i, f.directory);
    rejects(mock(f.directory, { missingSan: true }) + invoke(f.directory), /certificate|domain/i, f.directory);
    f.template.Resources.UserPoolClient.Properties.ExplicitAuthFlows.push('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    await writeFile(path.join(f.directory, 'infra/template.yaml'), JSON.stringify(f.template));
    rejects(mock(f.directory) + invoke(f.directory), /password|auth/i, f.directory);
    assert.ok(!(await calls(f.directory)).some(c => ['package', 'create-change-set', 'execute-change-set'].includes(c[1])));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
