<#
.SYNOPSIS
    Parity check: turns every note of cloud-outcomes.json into its backup event with the
    watcher's functions, one canonical JSON line per note, or "null" for a rejected note.
#>
[CmdletBinding()]
param([string]$RunbookPath, [ValidateSet("SystemTextJson", "ConvertFromJson")][string]$Parser = "SystemTextJson")

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly
# ConvertFromJson is the path the Windows PowerShell 5.1 runtime takes.
$script:TvNoteJsonParser = $Parser

# Parsed like a downloaded note, so times stay text exactly as written.
$fixture = ConvertFrom-TvNoteJson (Get-Content (Join-Path $PSScriptRoot "cloud-outcomes.json") -Raw)
foreach ($note in @($fixture.notes)) {
    $outcome = ConvertFrom-TenuVaultBackupOutcome $note $fixture.tenantId
    if ($null -eq $outcome) { Write-Output "null"; continue }
    Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TenuVaultCloudOutcomeEvent -Outcome $outcome -TenantId $fixture.tenantId -TenantName $fixture.tenantName))
}
