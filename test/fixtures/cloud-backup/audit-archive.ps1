$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$fixture = ConvertFrom-TvJson ([Console]::In.ReadToEnd())
$script:reads = [System.Collections.Generic.List[string]]::new()
function Get-TvBackupFolders { return $fixture.folders }
function Read-TvPlainJson {
    param($Context, $BlobName)
    return $fixture.files[$BlobName]
}
function Invoke-TvGraphGet {
    param($Path, $Token)
    $script:reads.Add($Path)
    return $fixture.pages[$script:reads.Count - 1]
}
function Set-TvBlob {
    param($Account, $BlobName, $Body, $Token)
    $script:written = @{ name = $BlobName; body = ConvertFrom-TvJson $Body }
}

$window = Save-TvIntuneAuditArchive @{ TenantId = $fixture.tenant; StorageAccount = "stcontoso"; StorageToken = "storage" } $fixture.current ([DateTime]::Parse($fixture.started).ToUniversalTime()) "graph"
ConvertTo-Json -InputObject @{ window = $window; archive = $script:written; reads = $script:reads } -Depth 100 -Compress
