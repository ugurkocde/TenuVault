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
    return [pscustomobject]@{ value = @($events[0..3]); "@odata.nextLink" = "https://graph.example/next?page=2" }
}

$common = @{
    Label = "Conditional Access"; FreshUri = "https://graph.example/fresh"; WatermarkIso = "2026-11-03T22:00:00.000Z"
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
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation "https://graph.example/expired" -PriorIds @{}))

# 3. A failure discards the partial collection and keeps the watermark.
$script:calls.Clear()
$script:failAll = $true
Write-Output (& $summary (Invoke-TvAuditIngestion @common -Continuation "https://graph.example/saved" -PriorIds @{}))
