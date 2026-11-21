param([string]$RunbookPath = (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1"), [switch]$Baseline, [switch]$ClaimedRestart, [switch]$UncertainRestart)
$ErrorActionPreference = "Stop"
. $RunbookPath -LibraryOnly

$env:TenuVaultTenantId = "11111111-2222-3333-4444-555555555555"
$env:TenuVaultStorageAccount = "stcontoso"
$script:jobId = [guid]"99999999-9999-4999-8999-999999999999"
$PSPrivateMetadata = @{ JobId = $script:jobId }
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:blobs = @{}
$script:scenario = ""
$script:backupBase = "https://stcontoso.blob.core.windows.net/intune-backups"
$script:statusUri = "$script:backupBase/cloud-backup-status-11111111.json"
$script:baselineFolder = "backup-2026-01-01-000000"
$script:statusETag = '"legacy"'
$script:statusAttempts = 0

$script:identityCalls = 0
function Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [string]$Method, [int]$TimeoutSec)
    $script:identityCalls++
    if ($script:identityCalls -lt 3) { throw "Identity endpoint temporarily unavailable" }
    return @{ access_token = "token" }
}
function Start-Sleep { param([double]$Seconds) }
$identityToken = $null
try { $identityToken = Get-TvManagedIdentityToken "https://storage.azure.com/" } catch { }
function Get-TvManagedIdentityToken { param([string]$Resource) return "token" }

$script:transportCalls = 0
$script:HttpClient.Dispose()
$script:HttpClient = [pscustomobject]@{}
$script:HttpClient | Add-Member ScriptMethod SendAsync {
    $script:transportCalls++
    throw "Transport unavailable"
}
if (-not ($Baseline -or $ClaimedRestart -or $UncertainRestart)) {
    $budget = @{ Clock = [System.Diagnostics.Stopwatch]::StartNew(); Seconds = 1; Requests = 1 }
    $budgetContext = @{ StorageAccount = "stcontoso"; StorageToken = "token"; AuditBudget = $budget }
    try { Invoke-TvAuditStorage $budgetContext "audit-logs" "/test.json" } catch { }
    $budgetedCalls = $script:transportCalls
    try { Invoke-TvHttp -Uri "https://stcontoso.blob.core.windows.net/audit-logs/test.json" -Token "token" } catch { }
    $unbudgetedCalls = $script:transportCalls - $budgetedCalls
}

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes, [int]$BudgetMs)
    $script:calls.Add(@{ uri = $Uri; method = $Method; condition = $Headers["If-Match"]; ifNoneMatch = $Headers["If-None-Match"] })
    if ($script:scenario -eq "resultsDenied" -and $Uri -like "*/tenuvault-backup-results*") {
        throw [TvHttpError]::new(403, "Results container denied")
    }
    if ($script:scenario -eq "receiptDenied" -and $Uri -like "*/audit-receipts/*") {
        throw [TvHttpError]::new(403, "Receipt denied")
    }
    if ($Uri.EndsWith("/start.json") -and ($script:scenario -in @("startReadDenied", "startUnreadableRestart") -or
        ($Method -eq "Put" -and $script:scenario -eq "startWriteDenied"))) {
        throw [TvHttpError]::new(403, "Start checkpoint denied")
    }
    if ($Uri.EndsWith("/terminal.json") -and $script:scenario -eq "terminalReadDenied" -and $Method -eq "Get") {
        throw [TvHttpError]::new(403, "Terminal checkpoint denied")
    }
    if ($Uri -like "https://graph.microsoft.com/*") {
        if ($script:scenario -eq "graph401") { throw [TvHttpError]::new(401, "Graph policy list refused") }
        $text = '{"value":[]}'
        if (($ClaimedRestart -or $UncertainRestart) -and $Uri -like "*/deviceManagement/deviceCategories") {
            $text = '{"value":[{"id":"11111111-1111-1111-1111-111111111111","displayName":"Example"}]}'
        }
        if (($ClaimedRestart -or $UncertainRestart) -and $Uri -like "*/deviceManagement/deviceCategories/*") {
            $text = '{"id":"11111111-1111-1111-1111-111111111111","displayName":"Example"}'
        }
    } elseif ($Uri -like "*/intune-backups?*comp=list*") {
        $text = "<EnumerationResults><Blobs><BlobPrefix><Name>$script:baselineFolder/</Name></BlobPrefix></Blobs><NextMarker /></EnumerationResults>"
    } elseif ($Uri -like "*comp=list*") {
        $prefix = [Uri]::UnescapeDataString([regex]::Match($Uri, '[?&]prefix=([^&]*)').Groups[1].Value)
        $items = foreach ($key in $script:blobs.Keys) {
            $name = $key -replace '^.*/tenuvault-backup-results/', ''
            if ($name.StartsWith($prefix)) { "<Blob><Name>$name</Name></Blob>" }
        }
        $text = "<EnumerationResults><Blobs>$($items -join '')</Blobs><NextMarker /></EnumerationResults>"
    } elseif ($Method -eq "Delete") {
        if ($script:scenario -ne "excessive") { throw [TvHttpError]::new(403, "Delete denied") }
        $script:blobs.Remove($Uri)
        return @{ Status = 202 }
    } elseif ($Method -eq "Put") {
        if ($script:scenario -eq "outage") {
            if ($Uri.EndsWith("/metadata.json")) {
                $body = [Text.Encoding]::UTF8.GetString($BodyBytes)
                if (($body | ConvertFrom-Json).Status -eq "Success") { $script:unconfirmedManifest = @{ uri = $Uri; body = $body } }
                throw [TvHttpError]::new(503, "Manifest storage unavailable")
            }
            if ($Uri -eq $script:statusUri -or $Uri -like "*/cloud-backup-outcomes/*") {
                throw [TvHttpError]::new(503, "Result storage unavailable")
            }
        }
        if ($Uri -like "*/cloud-change-reports/*" -and $script:scenario -eq "reportGap") {
            throw [TvHttpError]::new(503, "Interrupted before report publication")
        }
        if ($Uri -eq $script:statusUri -and $script:scenario -in @("statusOlderConflict", "statusNewerConflict")) {
            $script:statusAttempts++
            if ($script:statusAttempts -eq 1) {
                $at = if ($script:scenario -eq "statusOlderConflict") { "2025-01-01T00:00:00.000Z" } else { "2099-01-01T00:00:00.000Z" }
                $script:blobs[$Uri] = @{ TenantId = $env:TenuVaultTenantId; RunId = "other-job"; LastRunAt = $at; LastStatus = "Failed" } | ConvertTo-Json -Compress
                $script:statusETag = '"concurrent"'
                throw [TvHttpError]::new(412, "Status updated by another job")
            }
            if ($Headers["If-Match"] -cne $script:statusETag) { throw [TvHttpError]::new(412, "Stale ETag") }
        }
        if ($script:scenario -eq "terminalGap" -and ($Uri -like "*/cloud-backup-status-*" -or $Uri -like "*/cloud-backup-outcomes/*")) {
            throw [TvHttpError]::new(503, "Interrupted after terminal checkpoint")
        }
        if ($Uri.EndsWith("/metadata.json") -and $script:scenario -eq "uncertain") { throw [TvHttpError]::new(503, "Write unconfirmed") }
        if ($Uri -like "*/audit-runs/*/terminal.json" -and $script:scenario -eq "crash") { throw [TvHttpError]::new(403, "Power lost before receipt") }
        if ($Uri -like "*/audit-logs/*" -and $Headers["If-None-Match"] -eq "*" -and $script:scenario -eq "revokedCreate") {
            throw [TvHttpError]::new(403, "Audit create revoked")
        }
        if ($script:blobs.ContainsKey($Uri)) {
            if ($Headers["If-None-Match"] -eq "*") { throw [TvHttpError]::new(412, "Existing blob") }
            if ($Headers["If-Match"] -eq "*" -and $script:scenario -ne "excessive") { throw [TvHttpError]::new(403, "Overwrite denied") }
        }
        $script:blobs[$Uri] = [Text.Encoding]::UTF8.GetString($BodyBytes)
        if ($Uri.EndsWith("/metadata.json") -and $script:scenario -eq "lostAck") { throw [TvHttpError]::new(0, "Lost manifest acknowledgement") }
        if ($Uri -like "*/audit-logs/producer-tests/*" -and $Headers["If-None-Match"] -eq "*" -and $script:scenario -eq "canaryLostAck") {
            throw [TvHttpError]::new(0, "Lost canary acknowledgement")
        }
        return @{ Status = 201 }
    } else {
        if (-not $script:blobs.ContainsKey($Uri)) { throw [TvHttpError]::new(404, "Missing blob") }
        $text = $script:blobs[$Uri]
    }
    return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text; ETag = $script:statusETag }
}

function Run-Scenario {
    $script:calls.Clear()
    $script:OutcomeSent = $false
    $message = $null
    $output = [System.Collections.Generic.List[string]]::new()
    try { Invoke-TvBackup 2>&1 3>&1 | ForEach-Object { $output.Add([string]$_) } } catch { $message = $_.Exception.Message }
    return @{
        calls = @($script:calls.ToArray()); error = $message
        output = @($output | ForEach-Object { [string]$_ })
        blobs = $script:blobs.Clone()
    }
}
if ($UncertainRestart) {
    Remove-Item Function:Start-Sleep
    $env:TenuVaultExcludedFolders = (Get-TvTypes | Where-Object { $_.Folder -ne "DeviceCategories" }).Folder -join ","
    $script:scenario = "outage"
    $first = Run-Scenario
    $firstManifest = $script:unconfirmedManifest
    # The baseline allocates folders by wall clock, so allow its next second before retrying.
    Start-Sleep -Seconds 1
    $second = Run-Scenario
    Start-Sleep -Seconds 1
    $script:scenario = "restart"
    $success = Run-Scenario
    $again = Run-Scenario
    # Independently model a delayed successful PUT from the original attempt.
    $script:blobs = $first.blobs.Clone()
    $script:blobs[$firstManifest.uri] = $firstManifest.body
    $lateManifest = Run-Scenario
    [Console]::WriteLine((@{ first = $first; second = $second; success = $success; again = $again; lateManifest = $lateManifest } | ConvertTo-Json -Compress -Depth 9))
    return
}
if ($ClaimedRestart) {
    $env:TenuVaultExcludedFolders = (Get-TvTypes | Where-Object { $_.Folder -ne "DeviceCategories" }).Folder -join ","
    $older = [DateTime]::UtcNow.AddMinutes(-1)
    $folder = "backup-$(ConvertTo-TvFolderTimestamp $older)"
    $run = $script:jobId.ToString()
    $path = "https://stcontoso.blob.core.windows.net/tenuvault-backup-results/audit-runs/$env:TenuVaultTenantId/$run/start.json"
    $script:blobs[$path] = @{ jobId = $run; runId = $run; folder = $folder; startedAt = $older.ToString("o"); trigger = "scheduled" } | ConvertTo-Json -Compress
    $script:blobs["$script:backupBase/$folder/.tenuvault-owner.json"] = @{ TenantId = $env:TenuVaultTenantId; RunId = $run } | ConvertTo-Json -Compress
    $first = Run-Scenario
    [Console]::WriteLine((@{ first = $first; again = Run-Scenario; oldFolder = $folder; oldRunId = $run } | ConvertTo-Json -Compress -Depth 9))
    return
}
if ($Baseline) {
    $env:TenuVaultChangeReport = "names"
    $script:blobs[$script:statusUri] = "TVAZ1`nsealed payload"
    $script:blobs["$script:backupBase/$script:baselineFolder/metadata.json"] = @{ TenantId = $env:TenuVaultTenantId; Status = "Success"; Items = @{} } | ConvertTo-Json -Compress
    [Console]::WriteLine(((Run-Scenario) | ConvertTo-Json -Compress -Depth 9))
    return
}
$results = @{
    identity = @{ token = $identityToken; calls = $script:identityCalls }
    transport = @{ budgeted = $budgetedCalls; unbudgeted = $unbudgetedCalls; remaining = $budget.Requests }
}
foreach ($caseName in @("lostAck", "crash", "graph401", "terminalGap", "uncertain", "startReadDenied", "startWriteDenied", "resultsDenied", "receiptDenied")) {
    $script:blobs.Clear()
    $script:scenario = $caseName
    $results[$caseName] = Run-Scenario
    if ($caseName -in @("lostAck", "crash", "terminalGap")) {
        $script:scenario = "restart"
        $results["${caseName}Restart"] = Run-Scenario
    }
    if ($caseName -eq "crash") {
        $script:scenario = "terminalReadDenied"
        $results.terminalReadDenied = Run-Scenario
    }
    if ($caseName -eq "lostAck") {
        $script:scenario = "startUnreadableRestart"
        $results.startUnreadableRestart = Run-Scenario
    }
    if ($caseName -eq "receiptDenied") {
        $script:scenario = "restart"
        $context = @{ TenantId = $env:TenuVaultTenantId; StorageAccount = $env:TenuVaultStorageAccount; StorageToken = "token" }
        $results.orphanReplay = Invoke-TvAuditReplay $context
        $results.orphanBlobs = $script:blobs.Clone()
    }
}
foreach ($caseName in @("sealedStatus", "statusOlderConflict", "statusNewerConflict")) {
    $script:blobs.Clear()
    $script:scenario = $caseName
    $script:statusETag = '"legacy"'
    $script:statusAttempts = 0
    $script:blobs[$script:statusUri] = "TVAZ1`nsealed payload"
    $results[$caseName] = Run-Scenario
}
$script:blobs.Clear()
$env:TenuVaultChangeReport = "names"
$script:blobs["$script:backupBase/$script:baselineFolder/metadata.json"] = @{ TenantId = $env:TenuVaultTenantId; Status = "Success"; Items = @{} } | ConvertTo-Json -Compress
$script:scenario = "reportGap"
$results.reportGap = Run-Scenario
$script:scenario = "restart"
$results.reportRestart = Run-Scenario
$results.reportRestartAgain = Run-Scenario
Remove-Item Env:TenuVaultChangeReport

$script:blobs.Clear()
$older = [DateTime]::UtcNow.AddHours(-5)
$folder = "backup-$(ConvertTo-TvFolderTimestamp $older)"
$run = $script:jobId.ToString()
$start = [ordered]@{ jobId = $run; runId = $run; folder = $folder; startedAt = $older.ToString("o"); trigger = "manual"
    principalId = "22222222-2222-2222-2222-222222222222" }
$resultsBase = "https://stcontoso.blob.core.windows.net/tenuvault-backup-results"
$script:blobs["$resultsBase/audit-runs/$env:TenuVaultTenantId/$run/start.json"] = $start | ConvertTo-Json -Compress
$manifest = [ordered]@{ RunId = $run; BackupFolder = $folder; TenantId = $env:TenuVaultTenantId; Status = "CompletedWithWarnings"; CompletedAt = $older.AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    RunbookVersion = $script:RunbookVersion; ItemCounts = @{ TotalPolicies = 8 }; Failures = 1; FailedTypes = @("Apps") }
$script:blobs["$script:backupBase/$folder/metadata.json"] = $manifest | ConvertTo-Json -Compress
$context = @{ TenantId = $env:TenuVaultTenantId; StorageAccount = "stcontoso"; StorageToken = "token" }
$script:calls.Clear()
$results.agedStart = @{ replay = Invoke-TvAuditReplay $context; blobs = $script:blobs.Clone(); calls = $script:calls.ToArray(); manifest = $manifest }

$AuditCanary = $true
foreach ($caseName in @("scoped", "excessive", "canaryLostAck")) {
    $script:blobs.Clear()
    $script:scenario = $caseName
    $results[$caseName] = Run-Scenario
    if ($caseName -eq "scoped") {
        $results.scopedAgain = Run-Scenario
        $script:scenario = "revokedCreate"
        $results.revokedCreate = Run-Scenario
    }
}
[Console]::WriteLine(($results | ConvertTo-Json -Compress -Depth 9))
