#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Execute,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,127}$')][string]$ChangeSetName,
    [switch]$SkipChecks,
    [string]$ChecksEvidencePath,
    [string]$RepoRoot = (Join-Path $PSScriptRoot '..')
)

# UPDATE only. Dot-sourcing defines the same guard/runner functions for offline tests.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = [IO.Path]::GetFullPath($RepoRoot)
$helperFile = $PSCommandPath
$region = 'us-east-1'
$account = '765932874577'
$stackName = 'saldoevento-prod'
$primaryHost = 'saldoevento.zooberiahsystems.com'
$legacyHost = 'saldoevento.lynxpardelle.com'
$frontendDirectory = Join-Path $repoRoot 'artifacts/frontend'
$deploymentDirectory = Join-Path $repoRoot 'artifacts/deployments/prod'
$sourceTemplate = Join-Path $repoRoot 'infra/template.yaml'
$sourceParameters = Join-Path $repoRoot 'infra/environments/prod.json'
$protectedTypes = @('AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::Cognito::UserPool','AWS::Cognito::UserPoolClient','AWS::Cognito::UserPoolDomain','AWS::CloudFront::Distribution','AWS::ApiGatewayV2::Api','AWS::Serverless::HttpApi')
$retainedResources = @('UserPool','IdentityTable','EventsTable','ReconciliationTable','ImportsBucket','FrontendAssetsBucket')

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file missing: $Path" }
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CanonicalJson($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [Collections.IDictionary]) {
        return '{' + ((@($Value.Keys | Sort-Object -CaseSensitive) | ForEach-Object { (ConvertTo-Json -InputObject ([string]$_) -Compress) + ':' + (Get-CanonicalJson $Value[$_]) }) -join ',') + '}'
    }
    if ($Value -is [pscustomobject]) {
        return '{' + ((@($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive) | ForEach-Object { (ConvertTo-Json -InputObject ([string]$_) -Compress) + ':' + (Get-CanonicalJson $Value.$_) }) -join ',') + '}'
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        return '[' + ((@($Value | ForEach-Object { Get-CanonicalJson $_ })) -join ',') + ']'
    }
    ConvertTo-Json -InputObject $Value -Compress -Depth 100
}

function Get-ObjectHash($Value) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes((Get-CanonicalJson $Value)))).ToLowerInvariant()
}

function Get-ParametersHash($Parameters) {
    $values = [ordered]@{}
    foreach ($parameter in @($Parameters | Sort-Object ParameterKey)) { $values[$parameter.ParameterKey] = [string]$parameter.ParameterValue }
    Get-ObjectHash $values
}

function Assert-NoBillingInputs {
    foreach ($relative in @('package.json','services/package.json','web/package.json')) {
        $path = Join-Path $repoRoot $relative
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $package = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        foreach ($group in @('dependencies','devDependencies','optionalDependencies')) {
            if (@($package.$group.PSObject.Properties.Name | Where-Object { $_ -match '^(stripe|@stripe/)' }).Count) { throw 'Stripe dependencies require a separate billing release.' }
        }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $frontendDirectory -Recurse -File | Where-Object Extension -in @('.js','.mjs','.json'))) {
        if ((Get-Content -LiteralPath $file.FullName -Raw) -match '(?i)(https?://(?:checkout|api|js)\.stripe\.com|["''](?:@stripe/[^"'']+|stripe)["'']\s*:)') { throw 'Stripe SDK or payment endpoints cannot be deployed in this release.' }
    }
}

function Read-Template([string]$Path, [string]$Text) {
    $parser = 'import{createRequire}from"node:module";import{readFileSync}from"node:fs";const require=createRequire(process.argv[1]);const YAML=require("yaml");console.log(JSON.stringify(YAML.parse(readFileSync(process.argv[2]||0,"utf8"))))'
    $json = if ($Path) { & node --input-type=module -e $parser $helperFile $Path } else { $Text | & node --input-type=module -e $parser $helperFile }
    if ($LASTEXITCODE -ne 0 -or -not $json) { throw 'Cannot parse the reviewed CloudFormation template.' }
    $json | ConvertFrom-Json -Depth 100
}

function Invoke-Aws([Parameter(Mandatory)][string[]]$Arguments) {
    $output = (& aws @Arguments --region $region --no-cli-pager 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "AWS command failed ($($Arguments[0]) $($Arguments[1])): $output" }
    $output
}

function Assert-Source {
    $root = (& git rev-parse --show-toplevel | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($root) -ne $repoRoot) { throw 'RepoRoot must be the production repository root.' }
    $branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'Production deployment requires main.' }
    $dirty = (& git --no-optional-locks status --porcelain | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Production deployment requires a clean main worktree.' }
    $commit = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Unable to determine the main commit.' }
    $origin = (& git remote get-url origin | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $origin -notin @('https://github.com/LynxPardelle/abonos-por-evento.git','git@github.com:LynxPardelle/abonos-por-evento.git')) { throw 'Unexpected production repository origin.' }
    $remote = (& git ls-remote origin refs/heads/main | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or ($remote -split '\s+')[0] -ne $commit) { throw 'HEAD must equal the promoted remote main commit.' }
    $commit
}

function Assert-FrontendArtifact([string]$SourceCommit) {
    $manifestFile = Join-Path $frontendDirectory 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.sourceCommit -ne $SourceCommit -or $manifest.contentSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Frontend must identify the promoted main commit and content fingerprint.' }
    $files = @($manifest.files.PSObject.Properties)
    if (-not $files.Count) { throw 'Frontend file checksums are required.' }
    # package-frontend uses JSON.stringify insertion order for this particular hash.
    $mapHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($manifest.files | ConvertTo-Json -Depth 100 -Compress)))).ToLowerInvariant()
    if ($mapHash -ne $manifest.contentSha256) { throw 'Frontend file map differs from its content fingerprint.' }
    $prefix = $frontendDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $files) {
        $path = [IO.Path]::GetFullPath((Join-Path $frontendDirectory $file.Name))
        if ($file.Name.Contains('\') -or $file.Name -match '(^|/)\.\.?(/|$)' -or -not $path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $file.Value -notmatch '^[a-f0-9]{64}$' -or -not $expected.Add($path)) { throw 'Invalid frontend checksum path or value.' }
        if ((Get-Sha256 $path) -ne $file.Value) { throw "Frontend artifact checksum changed: $($file.Name)" }
    }
    [void]$expected.Add([IO.Path]::GetFullPath($manifestFile))
    $actual = @(Get-ChildItem -LiteralPath $frontendDirectory -Recurse -Force)
    if (@($actual | Where-Object { -not $_.PSIsContainer }).Count -ne $expected.Count) { throw 'Frontend file set has unlisted or missing files.' }
    if ((Get-Item -LiteralPath $frontendDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Frontend root cannot be a reparse point.' }
    foreach ($item in $actual) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Frontend cannot contain reparse points.' }
        if (-not $item.PSIsContainer -and -not $expected.Contains($item.FullName)) { throw 'Frontend contains an unlisted file.' }
    }
    $manifest
}

function Assert-ProductionParameters($Parameters) {
    $expected = @{ Stage='prod'; PublicOrigin="https://$primaryHost"; HostedZoneId='Z00733952JM7567FL6HXC'; SelfRegistrationEnabled='true' }
    if (@($Parameters).Count -ne 5) { throw 'Only the five approved production parameters are permitted.' }
    foreach ($key in @($expected.Keys) + 'CertificateArn') {
        $matches = @($Parameters | Where-Object ParameterKey -eq $key)
        if ($matches.Count -ne 1 -or $matches[0].UsePreviousValue) { throw "Invalid production parameter: $key" }
        if ($key -eq 'CertificateArn') {
            if ($matches[0].ParameterValue -notmatch '^arn:aws:acm:us-east-1:765932874577:certificate/[a-f0-9-]{36}$') { throw 'Certificate must belong to the production account in us-east-1.' }
        } elseif ($matches[0].ParameterValue -cne $expected[$key]) { throw "Unexpected production parameter: $key" }
    }
}

function Assert-TemplatePolicy($Template) {
    if ((Get-CanonicalJson $Template) -match '(?i)(STRIPE_|https?://(?:checkout|api|js)\.stripe\.com|"(?:BILLING_ENABLED|STRIPE_ENABLED)"\s*:\s*"?true)') { throw 'Stripe/billing runtime configuration is outside this release.' }
    $expected = @{ 'Fn::Not' = @(@{ 'Fn::Equals' = @(@{ Ref='Stage' },'prod') }) }
    if ((Get-ObjectHash $Template.Conditions.IsNonProduction) -ne (Get-ObjectHash $expected)) { throw 'Production administrative-password exclusion changed.' }
    $conditional = @{ 'Fn::If' = @('IsNonProduction','ALLOW_ADMIN_USER_PASSWORD_AUTH',@{Ref='AWS::NoValue'}) }
    $flows = @($Template.Resources.UserPoolClient.Properties.ExplicitAuthFlows)
    if (-not $flows.Count -or @($flows | Where-Object { (Get-ObjectHash $_) -eq (Get-ObjectHash $conditional) }).Count -ne 1) { throw 'Production admin-password authentication must remain non-production only.' }
    foreach ($flow in $flows) {
        if ($flow -is [string] -and $flow -in @('ALLOW_USER_SRP_AUTH','ALLOW_REFRESH_TOKEN_AUTH')) { continue }
        if ((Get-ObjectHash $flow) -ne (Get-ObjectHash $conditional)) { throw 'Unapproved production password authentication flow.' }
    }
    foreach ($name in $retainedResources) {
        $resource = $Template.Resources.$name
        if ($resource.DeletionPolicy -ne 'Retain' -or $resource.UpdateReplacePolicy -ne 'Retain') { throw "Retain policies must preserve $name." }
    }
}

function Get-ReviewFingerprint($ChangeSet) {
    Get-ObjectHash ([ordered]@{ ChangeSetId=$ChangeSet.ChangeSetId; StackId=$ChangeSet.StackId; ChangeSetName=$ChangeSet.ChangeSetName; Parameters=@($ChangeSet.Parameters | Sort-Object ParameterKey); Capabilities=@($ChangeSet.Capabilities | Sort-Object); Changes=@($ChangeSet.Changes) })
}

function Assert-ProductionChangeSet($ChangeSet, [string]$Name) {
    if ($ChangeSet.StackName -ne $stackName -or $ChangeSet.ChangeSetName -ne $Name -or $ChangeSet.Status -ne 'CREATE_COMPLETE' -or $ChangeSet.ExecutionStatus -notin @('AVAILABLE','EXECUTE_IN_PROGRESS','EXECUTE_COMPLETE')) { throw 'Production change set has an unsafe execution state.' }
    if ($ChangeSet.StackId -notlike "arn:aws:cloudformation:${region}:${account}:stack/${stackName}/*" -or $ChangeSet.ChangeSetId -notlike "arn:aws:cloudformation:${region}:${account}:changeSet/${Name}/*") { throw 'Change set account, region or stack differs from production.' }
    Assert-ProductionParameters $ChangeSet.Parameters
    if (-not @($ChangeSet.Changes).Count -or $ChangeSet.NextToken) { throw 'A complete, nonempty production review is required.' }
    foreach ($change in $ChangeSet.Changes) {
        $resource = $change.ResourceChange
        if ($change.Type -ne 'Resource' -or $resource.Action -notin @('Add','Modify','Remove')) { throw 'Unsupported production change type.' }
        if ($resource.ResourceType -in $protectedTypes -and $resource.Action -eq 'Add') { throw "New protected resources need a separate data/identity migration: $($resource.LogicalResourceId)" }
        if ($resource.Action -eq 'Remove' -and $resource.ResourceType -ne 'AWS::Lambda::Permission') { throw "Production resource removal blocked: $($resource.LogicalResourceId)" }
        if ($resource.ResourceType -in $protectedTypes -and ($resource.Action -eq 'Remove' -or $resource.Replacement -in @('True','Conditional'))) { throw "Protected resource replacement/removal blocked: $($resource.LogicalResourceId)" }
        if ($resource.Replacement -in @('True','Conditional') -and $resource.ResourceType -ne 'AWS::Lambda::Permission') { throw "Production replacement needs a separate migration: $($resource.LogicalResourceId)" }
    }
}

function Get-Stack {
    $stack = (Invoke-Aws @('cloudformation','describe-stacks','--stack-name',$stackName,'--output','json') | ConvertFrom-Json -Depth 100).Stacks[0]
    if ($stack.StackId -notlike "arn:aws:cloudformation:${region}:${account}:stack/${stackName}/*") { throw 'Existing production stack identity is required; creation is excluded.' }
    $stack
}

function Get-ProtectedResources {
    $all = (Invoke-Aws @('cloudformation','list-stack-resources','--stack-name',$stackName,'--output','json') | ConvertFrom-Json -Depth 100).StackResourceSummaries
    $map = [ordered]@{}
    foreach ($resource in @($all | Where-Object ResourceType -in $protectedTypes | Sort-Object LogicalResourceId)) {
        if (-not $resource.PhysicalResourceId -or $resource.ResourceStatus -eq 'DELETE_COMPLETE') { throw 'Protected resource has no live physical identity.' }
        $map[$resource.LogicalResourceId] = $resource.PhysicalResourceId
    }
    foreach ($name in $retainedResources + @('UserPoolClient','FrontendDistribution','BusinessApi')) { if (-not $map[$name]) { throw "Missing protected production resource: $name" } }
    $map
}

function Get-StackTemplateHash {
    $body = (Invoke-Aws @('cloudformation','get-template','--stack-name',$stackName,'--template-stage','Original','--output','json') | ConvertFrom-Json -Depth 100).TemplateBody
    if ($body -is [string]) { $body = Read-Template -Text $body }
    Get-ObjectHash $body
}

function Publish-Assets($Manifest, [string]$Bucket, [switch]$ImmutableOnly) {
    if ($Bucket -notmatch '^saldoevento-prod-frontendassetsbucket-[a-z0-9]+$') { throw 'Assets bucket is outside the existing production stack.' }
    foreach ($file in $Manifest.files.PSObject.Properties) {
        if (-not $file.Name.StartsWith('browser/') -or $file.Name -match '\.html$') { continue }
        $key = $file.Name.Substring(8)
        # Only Angular's generated bundle names carry a build content hash.
        # Human names such as ejemplo-importacion.csv / dm-sans-variable.ttf do not.
        $immutable = $key -match '^(main|chunk|styles|polyfills)-[a-zA-Z0-9_-]{8}\.(js|css)$'
        if ($ImmutableOnly -and -not $immutable) { continue }
        if (-not $ImmutableOnly -and $immutable) { continue }
        $path = Join-Path $frontendDirectory $file.Name
        if ((Get-Sha256 $path) -ne $file.Value) { throw 'Asset changed at the upload boundary.' }
        $cache = if ($immutable) { 'public,max-age=31536000,immutable' } else { 'public,max-age=300' }
        Invoke-Aws @('s3','cp',$path,"s3://$Bucket/$key",'--cache-control',$cache,'--metadata',"content-sha256=$($file.Value)",'--only-show-errors') | Out-Null
    }
}

function Invoke-ProductionDeployment {
    [CmdletBinding()]
    param([switch]$Execute, [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,127}$')][string]$ChangeSetName, [switch]$SkipChecks, [string]$ChecksEvidencePath)
    Push-Location $repoRoot
    try {
        $commit = Assert-Source
        if ($Execute -and -not $ChangeSetName) { throw 'ChangeSetName is required for reviewed production execution.' }
        foreach ($command in @('aws','node','npm','git')) { Get-Command $command -ErrorAction Stop | Out-Null }
        if ((Invoke-Aws @('sts','get-caller-identity','--output','json') | ConvertFrom-Json).Account -ne $account) { throw "Production requires account $account." }
        $parameters = Get-Content -LiteralPath $sourceParameters -Raw | ConvertFrom-Json
        Assert-ProductionParameters $parameters
        $template = Read-Template -Path $sourceTemplate
        Assert-TemplatePolicy $template
        $certificateArn = @($parameters | Where-Object ParameterKey -eq CertificateArn)[0].ParameterValue
        $cert = (Invoke-Aws @('acm','describe-certificate','--certificate-arn',$certificateArn,'--output','json') | ConvertFrom-Json).Certificate
        if ($cert.Status -ne 'ISSUED' -or $primaryHost -notin $cert.SubjectAlternativeNames -or $legacyHost -notin $cert.SubjectAlternativeNames) { throw 'Issued certificate must cover both production domains explicitly.' }
        foreach ($required in @('services/package.json','services/package-lock.json','services/node_modules')) { if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) { throw "Missing production input: $required" } }
        if (-not $Execute -and -not $SkipChecks) {
            foreach ($arguments in @(@('test'),@('run','test:web'),@('run','build:web'),@('run','package:frontend'),@('run','validate:infra'),@('run','smoke:frontend'))) {
                & npm @arguments
                if ($LASTEXITCODE -ne 0) { throw "Verification failed: npm $($arguments -join ' ')" }
            }
        }
        $manifest = Assert-FrontendArtifact $commit
        Assert-NoBillingInputs
        if (-not $ChangeSetName) { $ChangeSetName = 'saldoevento-prod-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') }
        $reviewFile = Join-Path $deploymentDirectory "$ChangeSetName.json"
        $metadataFile = Join-Path $deploymentDirectory "$ChangeSetName.metadata.json"
        $packagedFile = Join-Path $deploymentDirectory "$ChangeSetName.packaged.yaml"
        $effectiveFile = Join-Path $deploymentDirectory "$ChangeSetName.parameters.json"
        $evidenceFile = if ($Execute) { (Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json).checksEvidencePath } elseif ($SkipChecks) {
            if (-not $ChecksEvidencePath) { throw 'SkipChecks requires saved evidence for this main commit.' }; (Resolve-Path -LiteralPath $ChecksEvidencePath).Path
        } else {
            New-Item -ItemType Directory -Path $deploymentDirectory -Force | Out-Null
            $path = Join-Path $deploymentDirectory "$ChangeSetName.checks.json"
            @{passed=$true; sourceCommit=$commit; frontendContentSha256=$manifest.contentSha256; checks=@('test','test:web','build:web','package:frontend','validate:infra','smoke:frontend')} | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
            $path
        }
        $evidence = Get-Content -LiteralPath $evidenceFile -Raw | ConvertFrom-Json
        if ($evidence.passed -ne $true -or $evidence.sourceCommit -ne $commit -or $evidence.frontendContentSha256 -ne $manifest.contentSha256) { throw 'Passing verification evidence must match the main source and frontend.' }
        $stack = Get-Stack
        $protected = Get-ProtectedResources
        $bucket = $protected.FrontendAssetsBucket
        $hashFiles = [ordered]@{ helperSha256=$helperFile; sourceTemplateSha256=$sourceTemplate; sourceParametersSha256=$sourceParameters; effectiveParametersSha256=$effectiveFile; packagedTemplateSha256=$packagedFile; manifestSha256=(Join-Path $frontendDirectory 'manifest.json'); checksEvidenceSha256=$evidenceFile; reviewFileSha256=$reviewFile }
        if ($Execute) {
            $metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json -Depth 100
            if ($metadata.stackName -ne $stackName -or $metadata.changeSetType -ne 'UPDATE' -or $metadata.sourceCommit -ne $commit -or $metadata.frontendContentSha256 -ne $manifest.contentSha256 -or $metadata.repoRoot -ne $repoRoot -or $metadata.stackId -ne $stack.StackId) { throw 'Reviewed production source, stack or artifact changed.' }
            foreach ($key in $hashFiles.Keys) { if ((Get-Sha256 $hashFiles[$key]) -ne $metadata.$key) { throw "Reviewed production input changed: $key" } }
            if ((Get-ObjectHash $protected) -ne (Get-ObjectHash $metadata.protectedResources)) { throw 'Protected production resource identity changed.' }
            $saved = Get-Content -LiteralPath $reviewFile -Raw | ConvertFrom-Json -Depth 100
            Assert-ProductionChangeSet $saved $ChangeSetName
            if ((Get-ReviewFingerprint $saved) -ne $metadata.reviewFingerprint) { throw 'Persisted production review fingerprint changed.' }
            $current = Invoke-Aws @('cloudformation','describe-change-set','--stack-name',$stackName,'--change-set-name',$saved.ChangeSetId,'--output','json') | ConvertFrom-Json -Depth 100
            Assert-ProductionChangeSet $current $ChangeSetName
            if ((Get-ReviewFingerprint $current) -ne $metadata.reviewFingerprint) { throw 'Live change set differs from the saved production review.' }
            if ($current.ExecutionStatus -eq 'AVAILABLE') {
                if ($stack.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE') -or (Get-StackTemplateHash) -ne $metadata.baselineTemplateHash -or (Get-ParametersHash $stack.Parameters) -ne $metadata.baselineParametersHash) { throw 'Production baseline changed; prepare a new review.' }
            } elseif ($current.ExecutionStatus -eq 'EXECUTE_COMPLETE') {
                if ($stack.StackStatus -ne 'UPDATE_COMPLETE' -or (Get-StackTemplateHash) -ne $metadata.targetTemplateHash -or (Get-ParametersHash $stack.Parameters) -ne (Get-ParametersHash $parameters)) { throw 'Cannot resume after a different template or later update.' }
            }
            if ((Assert-Source) -ne $commit) { throw 'Production source changed at execution boundary.' }
            $manifest = Assert-FrontendArtifact $commit
            # Immutable paths are additive; existing chunks remain available to old pages.
            Publish-Assets $manifest $bucket -ImmutableOnly
            if ($current.ExecutionStatus -eq 'AVAILABLE') {
                $requestToken = 'saldoevento-' + (Get-ObjectHash @{commit=$commit;review=$metadata.reviewFingerprint})
                Invoke-Aws @('cloudformation','execute-change-set','--stack-name',$stackName,'--change-set-name',$current.ChangeSetId,'--client-request-token',$requestToken) | Out-Null
            }
            if ($current.ExecutionStatus -ne 'EXECUTE_COMPLETE') { Invoke-Aws @('cloudformation','wait','stack-update-complete','--stack-name',$stackName) | Out-Null }
            $deployed = Get-Stack
            if ($deployed.StackStatus -ne 'UPDATE_COMPLETE' -or $deployed.StackId -ne $metadata.stackId -or (Get-StackTemplateHash) -ne $metadata.targetTemplateHash -or (Get-ParametersHash $deployed.Parameters) -ne (Get-ParametersHash $parameters) -or (Get-ObjectHash (Get-ProtectedResources)) -ne (Get-ObjectHash $metadata.protectedResources)) { throw 'Production update did not attest the reviewed template, parameters and preserved resources.' }
            $null = Assert-FrontendArtifact $commit
            Publish-Assets $manifest $bucket
            Invoke-Aws @('cloudfront','wait','distribution-deployed','--id',$protected.FrontendDistribution) | Out-Null
            $distribution = (Invoke-Aws @('cloudfront','get-distribution','--id',$protected.FrontendDistribution,'--output','json') | ConvertFrom-Json -Depth 100).Distribution
            if ($distribution.Status -ne 'Deployed' -or $primaryHost -notin $distribution.DistributionConfig.Aliases.Items -or $legacyHost -notin $distribution.DistributionConfig.Aliases.Items) { throw 'Both production aliases must remain on the preserved deployed distribution.' }
            [ordered]@{ passed=$true; sourceCommit=$commit; frontendContentSha256=$manifest.contentSha256; stackName=$stackName; changeSetId=$saved.ChangeSetId; preservedResources=$true; aliases=@($primaryHost,$legacyHost); stripeEnabled=$false; completedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $deploymentDirectory "$ChangeSetName.completed.json") -Encoding UTF8
            Write-Output "Production update and assets completed from $commit. Verify both HTTPS domains and account flows; Stripe remains OFF."
            return
        }
        if (Test-Path -LiteralPath $metadataFile) { throw 'A saved review already exists; execute that exact review or use a new name.' }
        if ($stack.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE')) { throw 'Production must be stable before preparing an UPDATE.' }
        $bootstrap = (Invoke-Aws @('cloudformation','describe-stacks','--stack-name','saldoevento-artifacts','--output','json') | ConvertFrom-Json).Stacks[0]
        $artifactBucket = @($bootstrap.Outputs | Where-Object OutputKey -eq ArtifactsBucketName)[0].OutputValue
        if ($bootstrap.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE') -or $artifactBucket -notmatch '^saldoevento-artifacts-artifactsbucket-[a-z0-9]+$') { throw 'Existing artifact bootstrap is required; bootstrap creation is excluded.' }
        New-Item -ItemType Directory -Path $deploymentDirectory -Force | Out-Null
        $parameters | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $effectiveFile -Encoding UTF8
        $baselineHash = Get-StackTemplateHash
        Invoke-Aws @('cloudformation','package','--template-file',$sourceTemplate,'--s3-bucket',$artifactBucket,'--s3-prefix',"saldoevento/prod/$ChangeSetName",'--output-template-file',$packagedFile) | Out-Null
        $packaged = Read-Template -Path $packagedFile
        Assert-TemplatePolicy $packaged
        Invoke-Aws @('cloudformation','create-change-set','--stack-name',$stackName,'--change-set-name',$ChangeSetName,'--change-set-type','UPDATE','--template-body',"file://$packagedFile",'--parameters',"file://$effectiveFile",'--capabilities','CAPABILITY_IAM','CAPABILITY_AUTO_EXPAND','--tags','Key=Product,Value=SaldoEvento','Key=Environment,Value=prod','--output','json') | Out-Null
        Invoke-Aws @('cloudformation','wait','change-set-create-complete','--stack-name',$stackName,'--change-set-name',$ChangeSetName) | Out-Null
        $reviewJson = Invoke-Aws @('cloudformation','describe-change-set','--stack-name',$stackName,'--change-set-name',$ChangeSetName,'--output','json')
        $reviewJson | Set-Content -LiteralPath $reviewFile -Encoding UTF8
        $review = $reviewJson | ConvertFrom-Json -Depth 100
        Assert-ProductionChangeSet $review $ChangeSetName
        if ($review.ExecutionStatus -ne 'AVAILABLE') { throw 'Preview must create an available UPDATE.' }
        $metadata = [ordered]@{ stackName=$stackName; stackId=$stack.StackId; changeSetType='UPDATE'; repoRoot=$repoRoot; sourceCommit=$commit; frontendContentSha256=$manifest.contentSha256; checksEvidencePath=$evidenceFile; protectedResources=$protected; baselineTemplateHash=$baselineHash; baselineParametersHash=(Get-ParametersHash $stack.Parameters); targetTemplateHash=(Get-ObjectHash $packaged); reviewFingerprint=(Get-ReviewFingerprint $review); createdAt=[DateTime]::UtcNow.ToString('o') }
        foreach ($key in $hashFiles.Keys) { $metadata[$key] = Get-Sha256 $hashFiles[$key] }
        $metadata | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
        $review.Changes | ForEach-Object { $_.ResourceChange | Select-Object Action,LogicalResourceId,ResourceType,Replacement } | Format-Table | Out-Host
        Write-Output "Prepared production UPDATE without execution: $reviewFile"
        Write-Output "Review parameters, protected identities, changes and metadata; then run with -Execute -ChangeSetName $ChangeSetName."
    } finally { Pop-Location }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-ProductionDeployment -Execute:$Execute -ChangeSetName $ChangeSetName -SkipChecks:$SkipChecks -ChecksEvidencePath $ChecksEvidencePath }
