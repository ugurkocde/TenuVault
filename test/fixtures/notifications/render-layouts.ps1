<#
.SYNOPSIS
    Parity check: renders Teams cards for every style in card-layouts.json and every
    envelope in a JSON file passed in, one canonical JSON line per pair, styles outer.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EnvelopesPath, [string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly

$layouts = Get-Content (Join-Path $PSScriptRoot "card-layouts.json") -Raw | ConvertFrom-Json
$envelopes = @(Get-Content $EnvelopesPath -Raw | ConvertFrom-Json)
foreach ($name in @($layouts.styles.PSObject.Properties.Name)) {
    $style = ConvertTo-TvCardStyle $layouts.styles.$name
    foreach ($envelope in $envelopes) {
        Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $envelope $style))
    }
}
