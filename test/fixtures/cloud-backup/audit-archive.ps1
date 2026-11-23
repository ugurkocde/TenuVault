$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$fixture = ConvertFrom-TvJson ([Console]::In.ReadToEnd())
if ($fixture.maxBytes) { $script:MaxBlobBytes = $fixture.maxBytes }
$script:notes = [System.Collections.Generic.List[string]]::new()
$script:reads = [System.Collections.Generic.List[string]]::new()
function Get-TvBackupFolders { return $fixture.folders }
function Read-TvPlainJson {
    param($Context, $BlobName)
    $data = $fixture.files[$BlobName]
    if ($data -eq "unreadable") { throw [InvalidOperationException]::new("Unreadable") }
    return $data
}
function Invoke-TvHttp {
    param($Uri, $Token, $Headers, $MaxBytes, [switch]$BytesOnly, $BudgetMs)
    if (-not $BytesOnly -or $BudgetMs -le 0) { throw "Expected a bounded UTF-8 read." }
    $name = ([uri]$Uri).AbsolutePath.Substring("/intune-backups/".Length)
    $data = $fixture.files[$name]
    if (-not $data) { throw [TvHttpError]::new(404, "missing") }
    return @{ Bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $data -Compress -Depth 100)) }
}
function Invoke-TvGraphGet {
    param($Path, $Token, $BudgetMs)
    if ($BudgetMs -le 0) { throw "Expected a bounded Graph read." }
    $script:reads.Add($Path)
    $page = $fixture.pages[$script:reads.Count - 1]
    if ($page -eq "timeout") { throw [TvAuditBudgetError]::new() }
    if (-not $page) { throw "Unexpected Graph request." }
    return $page
}
function Set-TvBlob {
    param($Account, $BlobName, $Body, $Token)
    $script:written = @{ name = $BlobName; body = ConvertFrom-TvJson $Body }
}

$window = Save-TvIntuneAuditArchive @{ TenantId = $fixture.tenant; StorageAccount = "stcontoso"; StorageToken = "storage" } $fixture.current ([DateTime]::Parse($fixture.started).ToUniversalTime()) "graph" -Notes $script:notes
ConvertTo-Json -InputObject @{ window = $window; archive = $script:written; reads = $script:reads; notes = $script:notes } -Depth 100 -Compress
