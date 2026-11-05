<#
.SYNOPSIS
    Parity check: renders the Teams card for every envelope in a JSON file with the default
    layout, one canonical JSON line each, to compare how oversized cards are shortened.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EnvelopesPath, [string]$StylePath, [string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly

$style = if ($StylePath) { ConvertTo-TvCardStyle (Get-Content $StylePath -Raw -Encoding UTF8 | ConvertFrom-Json) } else { $null }
foreach ($envelope in @(Get-Content $EnvelopesPath -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $envelope $style))
}
