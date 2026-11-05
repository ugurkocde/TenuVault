<#
.SYNOPSIS
    Exercises Read-TvBackupOutcomes from the watcher runbook against mocked storage: two
    list pages of result notes, one note of another tenant, then a failing listing.
#>
[CmdletBinding()]
param([string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly

$fixture = Get-Content (Join-Path $PSScriptRoot "cloud-outcomes.json") -Raw | ConvertFrom-Json
$notes = @{
    "cloud-backup-outcomes/backup-2026-11-06-020000.json" = ($fixture.notes[1] | ConvertTo-Json -Compress)
    "cloud-backup-outcomes/backup-2026-11-07-020000.json" = ($fixture.notes[2] | ConvertTo-Json -Compress)
    "cloud-backup-outcomes/run-a1b2c3d4-0000-4000-8000-000000000004.json" = ($fixture.notes[3] | ConvertTo-Json -Compress)
    "cloud-backup-outcomes/run-other-tenant.json" = ($fixture.notes[6] | ConvertTo-Json -Compress)
    "cloud-backup-outcomes/backup-2026-10-01-020000.json" = (@{ schema = "tenuvault.cloud-backup-outcome/v1"; tenantId = $fixture.tenantId; runId = "old-run"; status = "Failed"; backupFolder = "backup-2026-10-01-020000"; finishedAt = "2026-10-01T02:01:00.000Z"; totalPolicies = 0; failures = 2; failedTypes = @() } | ConvertTo-Json -Compress)
}
$script:failList = $false
$script:renewals = 0

function Invoke-TvStorageRequest {
    param([string]$Uri, [string]$Method, [string]$Token, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType)
    if ($script:failList) { throw "Forbidden" }
    if ($Uri -like "*marker=page2*") {
        return [pscustomobject]@{ Content = "<?xml version=`"1.0`"?><EnumerationResults><Blobs><Blob><Name>cloud-backup-outcomes/run-a1b2c3d4-0000-4000-8000-000000000004.json</Name></Blob><Blob><Name>cloud-backup-outcomes/run-other-tenant.json</Name></Blob><Blob><Name>cloud-backup-outcomes/backup-2026-10-01-020000.json</Name><Properties><Content-Length>300</Content-Length></Properties></Blob><Blob><Name>cloud-backup-outcomes/huge.json</Name><Properties><Content-Length>5000000000</Content-Length></Properties></Blob></Blobs><NextMarker /></EnumerationResults>" }
    }
    return [pscustomobject]@{ Content = "<?xml version=`"1.0`"?><EnumerationResults><Blobs><Blob><Name>cloud-backup-outcomes/backup-2026-11-06-020000.json</Name></Blob><Blob><Name>cloud-backup-outcomes/backup-2026-11-07-020000.json</Name></Blob></Blobs><NextMarker>page2</NextMarker></EnumerationResults>" }
}
$script:downloads = [System.Collections.Generic.List[string]]::new()
function Get-TvBlobText {
    param([string]$Uri, [string]$Token)
    $script:downloads.Add($Uri)
    $name = $Uri.Substring($Uri.IndexOf("cloud-backup-outcomes/"))
    return $notes[[uri]::UnescapeDataString($name)]
}

$read = Read-TvBackupOutcomes -ContainerUri "https://stcontoso.blob.core.windows.net/tenuvault-backup-results" -Token "t" `
    -TenantId $fixture.tenantId -TenantName "Contoso" -RenewLease { $script:renewals++ } -Now ([DateTime]::new(2026, 11, 9, 0, 0, 0, [DateTimeKind]::Utc))
Write-Output (@{
    types = @($read.Envelopes | ForEach-Object { $_.type })
    failedFolders = @($read.FailedFolders)
    processed = @($read.Processed)
    ignored = $read.Ignored
    expired = $read.Expired
    error = $read.Error
    renewals = $script:renewals
    downloadedHuge = @($script:downloads | Where-Object { $_ -like "*huge.json" }).Count
} | ConvertTo-Json -Compress)

$script:failList = $true
$failed = Read-TvBackupOutcomes -ContainerUri "https://stcontoso.blob.core.windows.net/tenuvault-backup-results" -Token "t" `
    -TenantId $fixture.tenantId -TenantName "Contoso" -RenewLease { }
Write-Output (@{ count = $failed.Envelopes.Count; error = $failed.Error } | ConvertTo-Json -Compress)
