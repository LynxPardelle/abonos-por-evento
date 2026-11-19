#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Execute,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,127}$')]
    [string]$ChangeSetName,
    [switch]$SkipChecks,
    [string]$ChecksEvidencePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$region = 'us-east-1'
$expectedAccount = '765932874577'
$stackName = 'saldoevento-dev'
$bootstrapStack = 'saldoevento-artifacts'
$deploymentDirectory = Join-Path $repoRoot 'artifacts/deployments/dev'
$parameterFile = Join-Path $repoRoot 'infra/environments/dev.json'

function Invoke-Aws {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$AllowMissingStack)
    $output = (& aws @Arguments --region $region --no-cli-pager 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        if ($AllowMissingStack -and $output -match 'does not exist') { return $null }
        throw "AWS command failed ($($Arguments[0]) $($Arguments[1])): $output"
    }
    return $output
}

function Invoke-Check {
    param([string[]]$Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Verification failed: npm $($Arguments -join ' ')" }
}

function Get-ReviewFingerprint {
    param($ChangeSet)
    $review = [ordered]@{
        ChangeSetId = $ChangeSet.ChangeSetId
        StackId = $ChangeSet.StackId
        Parameters = @($ChangeSet.Parameters)
        Changes = @($ChangeSet.Changes)
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($review | ConvertTo-Json -Depth 100 -Compress))
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

Push-Location $repoRoot
try {
    $branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -notin @('feature/saldoevento-v1', 'development')) {
        throw 'Deployment branch must be feature/saldoevento-v1 or development. Production branches are excluded.'
    }
    if ($Execute -and -not $ChangeSetName) {
        throw 'ChangeSetName is required to execute a previously reviewed change set.'
    }
    if ($Execute) {
        $reviewFile = Join-Path $deploymentDirectory "$ChangeSetName.json"
        if (-not (Test-Path -LiteralPath $reviewFile -PathType Leaf)) { throw 'A saved change-set review is required before execution.' }
        $metadataFile = Join-Path $deploymentDirectory "$ChangeSetName.metadata.json"
        if (-not (Test-Path -LiteralPath $metadataFile -PathType Leaf)) { throw 'The saved change-set CREATE/UPDATE metadata is required before execution.' }
    }
    foreach ($command in @('aws', 'node', 'npm', 'git')) { Get-Command $command -ErrorAction Stop | Out-Null }
    $identity = Invoke-Aws -Arguments @('sts', 'get-caller-identity', '--output', 'json') | ConvertFrom-Json
    if ($identity.Account -ne $expectedAccount) { throw "Development deployment requires account $expectedAccount." }

    if ($Execute) {
        $saved = Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($metadata.stackName -ne $stackName -or $metadata.changeSetType -notin @('CREATE', 'UPDATE')) { throw 'Invalid development change-set metadata.' }
        if ($saved.StackName -ne $stackName) { throw 'Saved review does not target the development stack.' }
        $currentJson = Invoke-Aws -Arguments @('cloudformation', 'describe-change-set', '--stack-name', $stackName, '--change-set-name', $saved.ChangeSetId, '--output', 'json')
        $current = $currentJson | ConvertFrom-Json
        if ((Get-ReviewFingerprint $current) -ne (Get-ReviewFingerprint $saved)) { throw 'Change set differs from the saved review; prepare and review a new preview.' }
        if ($current.Status -ne 'CREATE_COMPLETE' -or $current.ExecutionStatus -ne 'AVAILABLE') { throw 'Reviewed change set is not available for execution.' }
        Invoke-Aws -Arguments @('cloudformation', 'execute-change-set', '--stack-name', $stackName, '--change-set-name', $current.ChangeSetId) | Out-Null
        $waiter = if ($metadata.changeSetType -eq 'CREATE') { 'stack-create-complete' } else { 'stack-update-complete' }
        Invoke-Aws -Arguments @('cloudformation', 'wait', $waiter, '--stack-name', $stackName) | Out-Null
        $deployedJson = Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $stackName, '--output', 'json')
        $deployedJson | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.stack.json") -Encoding UTF8
        $deployed = $deployedJson | ConvertFrom-Json
        $assetsBucket = @($deployed.Stacks[0].Outputs | Where-Object OutputKey -eq 'FrontendAssetsBucketName')[0].OutputValue
        if (-not $assetsBucket) { throw 'Development stack did not return FrontendAssetsBucketName.' }
        $browser = Join-Path $repoRoot 'artifacts/frontend/browser'
        # Every upload is limited to the new development stack output; no deletion of stored assets.
        Invoke-Aws -Arguments @('s3', 'sync', $browser, "s3://$assetsBucket/", '--exclude', '*.html', '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors') | Out-Null
        foreach ($mutableAsset in @('favicon.svg', 'ejemplo-importacion.csv')) {
            $localAsset = Join-Path $browser $mutableAsset
            if (Test-Path -LiteralPath $localAsset -PathType Leaf) {
                Invoke-Aws -Arguments @('s3', 'cp', $localAsset, "s3://$assetsBucket/$mutableAsset", '--cache-control', 'public,max-age=300', '--only-show-errors') | Out-Null
            }
        }
        Write-Output "Development stack completed. Outputs saved in $deploymentDirectory. Verify health, SSR, login and the synthetic pilot before promotion."
        return
    }

    $commit = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the source commit.' }
    if ($SkipChecks) {
        if (-not $ChecksEvidencePath -or -not (Test-Path -LiteralPath $ChecksEvidencePath -PathType Leaf)) { throw 'SkipChecks requires a saved ChecksEvidencePath from completed root verification.' }
        $evidence = Get-Content -LiteralPath $ChecksEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $frontend = Get-Content -LiteralPath (Join-Path $repoRoot 'artifacts/frontend/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($evidence.passed -ne $true -or $evidence.sourceCommit -ne $commit -or $evidence.frontendContentSha256 -ne $frontend.contentSha256) { throw 'Verification evidence does not match the current commit and packaged frontend.' }
    } else {
        Invoke-Check -Arguments @('test')
        Invoke-Check -Arguments @('run', 'test:web')
        Invoke-Check -Arguments @('run', 'build:web')
        Invoke-Check -Arguments @('run', 'package:frontend')
        Invoke-Check -Arguments @('run', 'validate:infra')
        Invoke-Check -Arguments @('run', 'smoke:frontend')
    }
    foreach ($required in @('services/package.json', 'services/package-lock.json', 'services/node_modules', 'artifacts/frontend/index.mjs', 'artifacts/frontend/browser', 'infra/template.yaml', 'infra/artifacts.yaml', 'infra/environments/dev.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) { throw "Required deployment input is missing: $required" }
    }
    $parameters = Get-Content -LiteralPath $parameterFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($parameters | Where-Object { $_.ParameterKey -eq 'Stage' -and $_.ParameterValue -eq 'dev' }).Count -ne 1) { throw 'Only development parameters are accepted.' }
    New-Item -ItemType Directory -Path $deploymentDirectory -Force | Out-Null
    Invoke-Aws -Arguments @('cloudformation', 'deploy', '--stack-name', $bootstrapStack, '--template-file', (Join-Path $repoRoot 'infra/artifacts.yaml'), '--no-fail-on-empty-changeset', '--tags', 'Product=SaldoEvento', 'Purpose=DeploymentArtifacts') | Out-Null
    $bootstrap = Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $bootstrapStack, '--output', 'json') | ConvertFrom-Json
    $artifactBucket = @($bootstrap.Stacks[0].Outputs | Where-Object OutputKey -eq 'ArtifactsBucketName')[0].OutputValue
    if (-not $artifactBucket) { throw 'Artifact bootstrap did not return ArtifactsBucketName.' }
    if (-not $ChangeSetName) { $ChangeSetName = 'saldoevento-dev-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') }
    $packagedTemplate = Join-Path $deploymentDirectory "$ChangeSetName.packaged.yaml"
    Invoke-Aws -Arguments @('cloudformation', 'package', '--template-file', (Join-Path $repoRoot 'infra/template.yaml'), '--s3-bucket', $artifactBucket, '--s3-prefix', "saldoevento/dev/$ChangeSetName", '--output-template-file', $packagedTemplate) | Out-Null
    $existing = Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $stackName, '--output', 'json') -AllowMissingStack
    $existingStatus = if ($null -eq $existing) { $null } else { ($existing | ConvertFrom-Json).Stacks[0].StackStatus }
    $type = if ($null -eq $existing -or $existingStatus -eq 'REVIEW_IN_PROGRESS') { 'CREATE' } else { 'UPDATE' }
    Invoke-Aws -Arguments @('cloudformation', 'create-change-set', '--stack-name', $stackName, '--change-set-name', $ChangeSetName, '--change-set-type', $type, '--template-body', "file://$packagedTemplate", '--parameters', "file://$parameterFile", '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND', '--tags', 'Key=Product,Value=SaldoEvento', 'Key=Environment,Value=dev', '--output', 'json') | Out-Null
    try {
        Invoke-Aws -Arguments @('cloudformation', 'wait', 'change-set-create-complete', '--stack-name', $stackName, '--change-set-name', $ChangeSetName) | Out-Null
    } catch {
        $failure = Invoke-Aws -Arguments @('cloudformation', 'describe-change-set', '--stack-name', $stackName, '--change-set-name', $ChangeSetName, '--output', 'json')
        $failure | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.failed.json") -Encoding UTF8
        throw
    }
    $review = Invoke-Aws -Arguments @('cloudformation', 'describe-change-set', '--stack-name', $stackName, '--change-set-name', $ChangeSetName, '--output', 'json')
    $reviewFile = Join-Path $deploymentDirectory "$ChangeSetName.json"
    $review | Set-Content -LiteralPath $reviewFile -Encoding UTF8
    [ordered]@{
        stackName = $stackName
        changeSetType = $type
        sourceCommit = $commit
        packagedTemplateSha256 = (Get-FileHash -LiteralPath $packagedTemplate -Algorithm SHA256).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.metadata.json") -Encoding UTF8
    $parsedReview = $review | ConvertFrom-Json
    $parsedReview.Changes | ForEach-Object { $_.ResourceChange | Select-Object Action, LogicalResourceId, ResourceType, Replacement } | Format-Table | Out-Host
    Write-Output "Prepared development change set without execution: $reviewFile"
    Write-Output "After reviewing that exact change set: pwsh -File scripts/Deploy-Development.ps1 -Execute -ChangeSetName $ChangeSetName"
} finally {
    Pop-Location
}
