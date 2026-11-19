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
$stackName = 'saldoevento-test'
$bootstrapStack = 'saldoevento-artifacts'
$deploymentDirectory = Join-Path $repoRoot 'artifacts/deployments/test'
$parameterFile = Join-Path $repoRoot 'infra/environments/test.json'
$frontendDirectory = Join-Path $repoRoot 'artifacts/frontend'

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
    $review = [ordered]@{ ChangeSetId=$ChangeSet.ChangeSetId; StackId=$ChangeSet.StackId; Parameters=@($ChangeSet.Parameters); Changes=@($ChangeSet.Changes) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($review | ConvertTo-Json -Depth 100 -Compress))
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Assert-FrontendArtifact {
    param([string]$SourceCommit)
    $manifestFile = Join-Path $frontendDirectory 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw 'Packaged frontend manifest is required.' }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.sourceCommit -ne $SourceCommit) { throw 'Frontend artifact must be built from the promoted testing commit.' }
    $files = @($manifest.files.PSObject.Properties)
    if ($files.Count -eq 0) { throw 'Frontend artifact checksums are required.' }
    $artifactPrefix = $frontendDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($file in $files) {
        $filename = [System.IO.Path]::GetFullPath((Join-Path $frontendDirectory $file.Name))
        if (-not $filename.StartsWith($artifactPrefix,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact checksum path must remain in the frontend directory.' }
        if (-not (Test-Path -LiteralPath $filename -PathType Leaf) -or (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value) { throw "Frontend artifact checksum changed: $($file.Name)" }
    }
    return $manifest
}

Push-Location $repoRoot
try {
    $branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'testing') { throw 'Deployment branch must be testing. Main, development and feature branches are excluded.' }
    $dirty = (& git --no-optional-locks status --porcelain | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Testing deployment requires a clean worktree.' }
    $commit = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Unable to resolve the testing source commit.' }
    $origin = (& git remote get-url origin | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $origin -notin @('https://github.com/LynxPardelle/abonos-por-evento.git','git@github.com:LynxPardelle/abonos-por-evento.git')) { throw 'Testing deployment requires the SaldoEvento repository origin.' }
    $remote = (& git ls-remote origin refs/heads/testing | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or ($remote -split '\s+')[0] -ne $commit) { throw 'HEAD must equal the remote testing commit promoted through the pull request.' }
    if ($Execute -and -not $ChangeSetName) { throw 'ChangeSetName is required to execute a previously reviewed change set.' }
    foreach ($command in @('aws','node','npm','git')) { Get-Command $command -ErrorAction Stop | Out-Null }
    $identity = Invoke-Aws -Arguments @('sts','get-caller-identity','--output','json') | ConvertFrom-Json
    if ($identity.Account -ne $expectedAccount) { throw "Testing deployment requires account $expectedAccount." }

    if ($Execute) {
        $reviewFile = Join-Path $deploymentDirectory "$ChangeSetName.json"
        $metadataFile = Join-Path $deploymentDirectory "$ChangeSetName.metadata.json"
        if (-not (Test-Path -LiteralPath $reviewFile -PathType Leaf) -or -not (Test-Path -LiteralPath $metadataFile -PathType Leaf)) { throw 'A saved testing change-set review and metadata are required.' }
        $saved = Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.StackName -ne $stackName -or $metadata.stackName -ne $stackName -or $metadata.changeSetType -notin @('CREATE','UPDATE')) { throw 'Saved review does not target the testing stack.' }
        $manifest = Assert-FrontendArtifact -SourceCommit $commit
        if ($metadata.sourceCommit -ne $commit -or $metadata.frontendContentSha256 -ne $manifest.contentSha256) { throw 'The reviewed testing source or frontend artifact changed.' }
        $packagedFile = Join-Path $deploymentDirectory "$ChangeSetName.packaged.yaml"
        if (-not (Test-Path -LiteralPath $packagedFile -PathType Leaf) -or (Get-FileHash -LiteralPath $packagedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.packagedTemplateSha256) { throw 'The reviewed packaged template changed.' }
        $current = Invoke-Aws -Arguments @('cloudformation','describe-change-set','--stack-name',$stackName,'--change-set-name',$saved.ChangeSetId,'--output','json') | ConvertFrom-Json
        if ((Get-ReviewFingerprint $current) -ne (Get-ReviewFingerprint $saved)) { throw 'Change set differs from the saved review; prepare a new testing preview.' }
        if ($current.Status -ne 'CREATE_COMPLETE' -or $current.ExecutionStatus -ne 'AVAILABLE') { throw 'Reviewed testing change set is not available for execution.' }
        Invoke-Aws -Arguments @('cloudformation','execute-change-set','--stack-name',$stackName,'--change-set-name',$current.ChangeSetId) | Out-Null
        $waiter = if ($metadata.changeSetType -eq 'CREATE') { 'stack-create-complete' } else { 'stack-update-complete' }
        Invoke-Aws -Arguments @('cloudformation','wait',$waiter,'--stack-name',$stackName) | Out-Null
        $deployedJson = Invoke-Aws -Arguments @('cloudformation','describe-stacks','--stack-name',$stackName,'--output','json')
        $deployedJson | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.stack.json") -Encoding UTF8
        $deployed = $deployedJson | ConvertFrom-Json
        $assetsBucket = @($deployed.Stacks[0].Outputs | Where-Object OutputKey -eq 'FrontendAssetsBucketName')[0].OutputValue
        if (-not $assetsBucket) { throw 'Testing stack did not return FrontendAssetsBucketName.' }
        $browser = Join-Path $frontendDirectory 'browser'
        Invoke-Aws -Arguments @('s3','sync',$browser,"s3://$assetsBucket/",'--exclude','*.html','--cache-control','public,max-age=31536000,immutable','--only-show-errors') | Out-Null
        foreach ($asset in @('favicon.svg','ejemplo-importacion.csv')) {
            $file = Join-Path $browser $asset
            if (Test-Path -LiteralPath $file -PathType Leaf) { Invoke-Aws -Arguments @('s3','cp',$file,"s3://$assetsBucket/$asset",'--cache-control','public,max-age=300','--only-show-errors') | Out-Null }
        }
        Write-Output "Testing stack completed from $commit. Verify https://saldoevento-test.lynxpardelle.com before any production promotion."
        return
    }

    if ($SkipChecks) {
        if (-not $ChecksEvidencePath -or -not (Test-Path -LiteralPath $ChecksEvidencePath -PathType Leaf)) { throw 'SkipChecks requires saved evidence for this testing commit.' }
        $evidence = Get-Content -LiteralPath $ChecksEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifest = Assert-FrontendArtifact -SourceCommit $commit
        if ($evidence.passed -ne $true -or $evidence.sourceCommit -ne $commit -or $evidence.frontendContentSha256 -ne $manifest.contentSha256) { throw 'Verification evidence must match the promoted testing commit and frontend.' }
    } else {
        Invoke-Check -Arguments @('test')
        Invoke-Check -Arguments @('run','test:web')
        Invoke-Check -Arguments @('run','build:web')
        Invoke-Check -Arguments @('run','package:frontend')
        Invoke-Check -Arguments @('run','validate:infra')
        Invoke-Check -Arguments @('run','smoke:frontend')
        $manifest = Assert-FrontendArtifact -SourceCommit $commit
    }
    foreach ($required in @('services/package.json','services/package-lock.json','services/node_modules','infra/template.yaml','infra/environments/test.json')) { if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) { throw "Missing testing input: $required" } }
    $parameters = Get-Content -LiteralPath $parameterFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($parameters | Where-Object { $_.ParameterKey -eq 'Stage' -and $_.ParameterValue -eq 'test' }).Count -ne 1 -or @($parameters | Where-Object { $_.ParameterKey -eq 'PublicOrigin' -and $_.ParameterValue -eq 'https://saldoevento-test.lynxpardelle.com' }).Count -ne 1) { throw 'Only testing Stage and public origin parameters are accepted.' }
    if (@($parameters | Where-Object { $_.ParameterKey -eq 'SelfRegistrationEnabled' -and $_.ParameterValue -eq 'true' }).Count -ne 1) { throw 'Self-service registration must be enabled in testing before this release is verified.' }
    New-Item -ItemType Directory -Path $deploymentDirectory -Force | Out-Null
    # The bootstrap belongs to development preparation; testing only reuses its output.
    $bootstrap = Invoke-Aws -Arguments @('cloudformation','describe-stacks','--stack-name',$bootstrapStack,'--output','json') | ConvertFrom-Json
    if ($bootstrap.Stacks[0].StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE')) { throw 'The existing artifact bootstrap is not ready.' }
    $artifactBucket = @($bootstrap.Stacks[0].Outputs | Where-Object OutputKey -eq 'ArtifactsBucketName')[0].OutputValue
    if (-not $artifactBucket) { throw 'Existing bootstrap did not return ArtifactsBucketName.' }
    if (-not $ChangeSetName) { $ChangeSetName = 'saldoevento-test-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') }
    $packagedTemplate = Join-Path $deploymentDirectory "$ChangeSetName.packaged.yaml"
    Invoke-Aws -Arguments @('cloudformation','package','--template-file',(Join-Path $repoRoot 'infra/template.yaml'),'--s3-bucket',$artifactBucket,'--s3-prefix',"saldoevento/test/$ChangeSetName",'--output-template-file',$packagedTemplate) | Out-Null
    $existing = Invoke-Aws -Arguments @('cloudformation','describe-stacks','--stack-name',$stackName,'--output','json') -AllowMissingStack
    $status = if ($null -eq $existing) { $null } else { ($existing | ConvertFrom-Json).Stacks[0].StackStatus }
    if ($status -and $status -notin @('REVIEW_IN_PROGRESS','CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE')) { throw "Testing stack must finish or be recovered before preparing changes: $status" }
    $type = if ($null -eq $existing -or $status -eq 'REVIEW_IN_PROGRESS') { 'CREATE' } else { 'UPDATE' }
    Invoke-Aws -Arguments @('cloudformation','create-change-set','--stack-name',$stackName,'--change-set-name',$ChangeSetName,'--change-set-type',$type,'--template-body',"file://$packagedTemplate",'--parameters',"file://$parameterFile",'--capabilities','CAPABILITY_IAM','CAPABILITY_AUTO_EXPAND','--tags','Key=Product,Value=SaldoEvento','Key=Environment,Value=test','--output','json') | Out-Null
    try { Invoke-Aws -Arguments @('cloudformation','wait','change-set-create-complete','--stack-name',$stackName,'--change-set-name',$ChangeSetName) | Out-Null }
    catch { Invoke-Aws -Arguments @('cloudformation','describe-change-set','--stack-name',$stackName,'--change-set-name',$ChangeSetName,'--output','json') | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.failed.json") -Encoding UTF8; throw }
    $review = Invoke-Aws -Arguments @('cloudformation','describe-change-set','--stack-name',$stackName,'--change-set-name',$ChangeSetName,'--output','json')
    $reviewFile = Join-Path $deploymentDirectory "$ChangeSetName.json"
    $review | Set-Content -LiteralPath $reviewFile -Encoding UTF8
    [ordered]@{ stackName=$stackName; changeSetType=$type; sourceCommit=$commit; frontendContentSha256=$manifest.contentSha256; packagedTemplateSha256=(Get-FileHash -LiteralPath $packagedTemplate -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.metadata.json") -Encoding UTF8
    ($review | ConvertFrom-Json).Changes | ForEach-Object { $_.ResourceChange | Select-Object Action,LogicalResourceId,ResourceType,Replacement } | Format-Table | Out-Host
    Write-Output "Prepared testing change set without execution: $reviewFile"
    Write-Output "After reviewing: pwsh -File scripts/Deploy-Testing.ps1 -Execute -ChangeSetName $ChangeSetName"
} finally { Pop-Location }
