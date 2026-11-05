<#
.SYNOPSIS
    Exercises Send-TvBackupOutcome from the cloud backup runbook against a mocked storage
    call, writing one JSON line per scenario.
#>
[CmdletBinding()]
param([string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultBackup.ps1"
}
. $RunbookPath -LibraryOnly

$script:calls = [System.Collections.Generic.List[object]]::new()
$script:answer = 201
function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType)
    $script:calls.Add([pscustomobject]@{ uri = $Uri; method = $Method; ifNoneMatch = $Headers["If-None-Match"]; contentType = $ContentType; body = [Text.Encoding]::UTF8.GetString($BodyBytes) })
    if ($script:answer -ne 201) { throw [TvHttpError]::new($script:answer, "HTTP $($script:answer)") }
}

$common = @{ Account = "stcontoso"; Token = "token"; TenantId = "11111111-2222-3333-4444-555555555555"; RunId = "a1b2c3d4-0000-4000-8000-000000000009" }

# 1. A partial backup, then a second call for the same run that must be ignored.
$out1 = @(Send-TvBackupOutcome @common -Status "CompletedWithWarnings" -BackupFolder "backup-2026-11-05-020000" -TotalPolicies 398 -Failures 3 -FailedTypes @("Apps", "Remediations"))
$out1 += @(Send-TvBackupOutcome @common -Status "Failed" -BackupFolder "backup-2026-11-05-020000" -TotalPolicies 0)
Write-Output (@{ calls = @($script:calls.ToArray()); output = $out1 } | ConvertTo-Json -Compress -Depth 5)

# 2. No watcher container: the call reports it and never throws.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:answer = 404
$out2 = @(Send-TvBackupOutcome @common -Status "Failed" -BackupFolder $null -TotalPolicies $null)
Write-Output (@{ calls = @($script:calls.ToArray()); output = $out2 } | ConvertTo-Json -Compress -Depth 5)
