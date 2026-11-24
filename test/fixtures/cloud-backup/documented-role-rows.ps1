$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
. (Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$legacy = [ordered]@{ roleAssignments = @([ordered]@{ id = "assignment"; members = "member"; resourceScopes = $null }) }
$current = Get-TvRoleAssignmentSnapshot $legacy
$result = foreach ($change in "added", "deleted") {
    $legacyRows = Get-TvDocumentedRows $legacy $change
    $currentRows = Get-TvDocumentedRows $current $change
    @{ change = $change; legacy = $legacyRows; current = $currentRows }
}
ConvertTo-Json -InputObject @($result) -Depth 12 -Compress
