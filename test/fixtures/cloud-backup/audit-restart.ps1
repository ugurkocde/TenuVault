$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$env:TenuVaultTenantId = "11111111-2222-3333-4444-555555555555"
$env:TenuVaultStorageAccount = "stcontoso"
$script:jobId = [guid]"99999999-9999-4999-8999-999999999999"
$PSPrivateMetadata = @{ JobId = $script:jobId }
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:blobs = @{}
$script:scenario = ""

function Get-TvManagedIdentityToken { param([string]$Resource) return "token" }
function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes, [int]$BudgetMs)
    $script:calls.Add(@{ uri = $Uri; method = $Method; condition = $Headers["If-Match"] })
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
        if ($script:blobs.ContainsKey($Uri)) {
            if ($Headers["If-None-Match"] -eq "*") { throw [TvHttpError]::new(412, "Existing blob") }
            if ($Headers["If-Match"] -eq "*" -and $script:scenario -ne "excessive") { throw [TvHttpError]::new(403, "Overwrite denied") }
        }
        $script:blobs[$Uri] = [Text.Encoding]::UTF8.GetString($BodyBytes)
        if ($Uri.EndsWith("/metadata.json") -and $script:scenario -eq "lostAck") { throw [TvHttpError]::new(0, "Lost manifest acknowledgement") }
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
$results = @{}
foreach ($caseName in @("lostAck", "crash", "graph401", "terminalGap", "uncertain")) {
    $script:blobs.Clear()
    $script:scenario = $caseName
    $results[$caseName] = Run-Scenario
    if ($caseName -in @("lostAck", "crash", "terminalGap")) {
        $script:scenario = "restart"
        $results["${caseName}Restart"] = Run-Scenario
    }
}
$AuditCanary = $true
foreach ($caseName in @("scoped", "excessive")) {
    $script:blobs.Clear()
    $script:scenario = $caseName
    $results[$caseName] = Run-Scenario
    if ($caseName -eq "scoped") { $results.scopedAgain = Run-Scenario }
}
[Console]::WriteLine(($results | ConvertTo-Json -Compress -Depth 9))
