$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$env:TenuVaultTenantId = "11111111-2222-3333-4444-555555555555"
$env:TenuVaultStorageAccount = "stcontoso"
$script:jobId = [guid]"99999999-9999-4999-8999-999999999999"
$PSPrivateMetadata = @{ JobId = $script:jobId }
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:blobs = @{}
$script:scenario = ""

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
$budget = @{ Clock = [System.Diagnostics.Stopwatch]::StartNew(); Seconds = 1; Requests = 1 }
$budgetContext = @{ StorageAccount = "stcontoso"; StorageToken = "token"; AuditBudget = $budget }
try { Invoke-TvAuditStorage $budgetContext "audit-logs" "/test.json" } catch { }
$budgetedCalls = $script:transportCalls
try { Invoke-TvHttp -Uri "https://stcontoso.blob.core.windows.net/audit-logs/test.json" -Token "token" } catch { }
$unbudgetedCalls = $script:transportCalls - $budgetedCalls

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes, [int]$BudgetMs)
    $script:calls.Add(@{ uri = $Uri; method = $Method; condition = $Headers["If-Match"] })
    if ($Uri.EndsWith("/start.json") -and ($script:scenario -eq "startReadDenied" -or
        ($Method -eq "Put" -and $script:scenario -eq "startWriteDenied"))) {
        throw [TvHttpError]::new(403, "Start checkpoint denied")
    }
    if ($Uri.EndsWith("/terminal.json") -and $script:scenario -eq "terminalReadDenied" -and $Method -eq "Get") {
        throw [TvHttpError]::new(403, "Terminal checkpoint denied")
    }
    if ($Uri -like "https://graph.microsoft.com/*") {
        if ($script:scenario -eq "graph401") { throw [TvHttpError]::new(401, "Graph policy list refused") }
        $text = '{"value":[]}'
    } elseif ($Uri -like "*comp=list*") {
        $text = "<EnumerationResults><Blobs /><NextMarker /></EnumerationResults>"
    } elseif ($Method -eq "Delete") {
        if ($script:scenario -ne "excessive") { throw [TvHttpError]::new(403, "Delete denied") }
        $script:blobs.Remove($Uri)
        return @{ Status = 202 }
    } elseif ($Method -eq "Put") {
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
    return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text }
}

function Run-Scenario {
    $script:calls.Clear()
    $message = $null
    $output = [System.Collections.Generic.List[string]]::new()
    try { Invoke-TvBackup 2>&1 3>&1 | ForEach-Object { $output.Add([string]$_) } } catch { $message = $_.Exception.Message }
    return @{
        calls = @($script:calls.ToArray()); error = $message
        output = @($output | ForEach-Object { [string]$_ })
        blobs = $script:blobs.Clone()
    }
}
$results = @{
    identity = @{ token = $identityToken; calls = $script:identityCalls }
    transport = @{ budgeted = $budgetedCalls; unbudgeted = $unbudgetedCalls; remaining = $budget.Requests }
}
foreach ($caseName in @("lostAck", "crash", "graph401", "terminalGap", "uncertain", "startReadDenied", "startWriteDenied")) {
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
}
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
