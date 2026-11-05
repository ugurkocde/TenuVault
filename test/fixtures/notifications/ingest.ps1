<#
.SYNOPSIS
    Exercises Invoke-TvAuditIngestion from the watcher runbook against a mocked Graph.

.DESCRIPTION
    Dot sources the runbook with -LibraryOnly, replaces Invoke-RestMethod with a function
    that serves pages from the Entra fixture, and writes one JSON line per scenario:
    paging with dedupe, an expired continuation that restarts, and a failure.
#>
[CmdletBinding()]
param([string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly

$fixture = Get-Content (Join-Path $PSScriptRoot "entra-audit.json") -Raw | ConvertFrom-Json
$events = @($fixture.events)
$script:calls = [System.Collections.Generic.List[string]]::new()
$script:failAll = $false
$script:foreignNext = $false

function Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [string]$Method, [int]$TimeoutSec)
    $script:calls.Add($Uri)
    if ($script:failAll) { throw "Forbidden" }
    if ($Uri -like "*expired*") {
        $exception = [System.Exception]::new("Bad Request")
        $response = [pscustomobject]@{ StatusCode = 400 }
        $exception | Add-Member -NotePropertyName Response -NotePropertyValue $response -Force
        throw $exception
    }
    if ($Uri -like "*page=2*") { return [pscustomobject]@{ value = @($events[4..6]) } }
    if ($script:foreignNext) { return [pscustomobject]@{ value = @($events[0..1]); "@odata.nextLink" = "https://attacker.example/next" } }
    return [pscustomobject]@{ value = @($events[0..3]); "@odata.nextLink" = "https://graph.microsoft.com/v1.0/next?page=2" }
}

$common = @{
    Label = "Conditional Access"; FreshUri = "https://graph.microsoft.com/v1.0/fresh"; WatermarkIso = "2026-11-03T22:00:00.000Z"
    GraphToken = "token"; TokenError = $null; Map = { param($raw) ConvertFrom-TenuVaultEntraAuditEvent $raw }; RenewLease = { }
}
$summary = {
    param($result)
    [pscustomobject][ordered]@{
        ids = @($result.Changes | ForEach-Object { $_.auditId })
        newest = $result.NewestSeenIso
        continuation = $result.Continuation
        error = $result.Error
        calls = @($script:calls.ToArray())
    } | ConvertTo-Json -Compress -Depth 5
}

# 1. Two pages, one id already known from an earlier run.
$prior = @{ "IPCGraph_aaaaaaaa-0000-0000-0000-000000000001_X_1" = $true }
$script:calls.Clear()
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation $null -PriorIds $prior))

# 2. An expired continuation restarts from the fresh query.
$script:calls.Clear()
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation "https://graph.microsoft.com/v1.0/expired" -PriorIds @{}))

# 3. A failure discards the partial collection and keeps the watermark.
$script:calls.Clear()
$script:failAll = $true
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation "https://graph.microsoft.com/v1.0/saved" -PriorIds @{}))

# 4. A saved continuation outside Microsoft Graph is ignored; the token never goes there.
$script:calls.Clear()
$script:failAll = $false
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation "https://attacker.example/steal" -PriorIds @{}))

# 5. A next link outside Microsoft Graph stops paging as an error.
$script:calls.Clear()
$script:foreignNext = $true
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation $null -PriorIds @{}))

# 6. Pruning: old ids go without a continuation and stay while one is saved.
$recent = @{ "old" = "2026-11-01T00:00:00.000Z"; "new" = "2026-11-03T21:50:00.000Z" }
$pruned = @(Get-TvRecentAuditList -RecentById $recent -WatermarkIso "2026-11-03T22:00:00.000Z" | ForEach-Object { $_.id })
$kept = @(Get-TvRecentAuditList -RecentById $recent -WatermarkIso "2026-11-03T22:00:00.000Z" -KeepAll $true | ForEach-Object { $_.id })
Write-Output (@{ ids = $pruned; calls = @(); kept = $kept } | ConvertTo-Json -Compress)
