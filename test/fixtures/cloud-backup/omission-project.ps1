param([Parameter(Mandatory)][string]$Fixture)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$cases = ConvertFrom-TvJson (Get-Content -Raw $Fixture)
$results = foreach ($case in $cases) {
    $projection = Protect-TvSnapshotFields $case.folder $case.snapshot $case.scripts
    @{ snapshot = $projection.Snapshot; fields = $projection.Fields; hash = Get-TvSnapshotHash $projection.Snapshot }
}
ConvertTo-Json -InputObject @($results) -Depth 100 -Compress
