# Runs the cloud backup runbook's change report step against faked storage and Graph, for
# test/cloud-change-report.test.ts: the backups are sealed with a test key like real ones, and
# every write is captured. Prints the writes and the runbook output.
param([Parameter(Mandatory)][string]$FixturePath, [string]$Level = "full")
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly
$fixture = ConvertFrom-TvJson ([IO.File]::ReadAllText($FixturePath))
$tenant = [string]$fixture.tenantId
$account = "tvteststore"
$master = [byte[]](1..32)
$script:Blobs = @{}
$script:Writes = [System.Collections.Generic.List[object]]::new()
function Add-TestBlob([string]$Name, [object]$Value) {
    $target = Get-TvBlobTarget $account $Name
    $script:Blobs[$target.Uri] = Protect-TvAzureBlob ([Text.Encoding]::UTF8.GetBytes((ConvertTo-TvJsJson $Value))) $master $tenant $target.HostName $target.Pathname
}
foreach ($side in @("older", "newer")) {
    $backup = $fixture[$side]
    Add-TestBlob "$($backup.name)/metadata.json" $backup.metadata
    foreach ($file in $backup.files.Keys) { Add-TestBlob "$($backup.name)/$file" $backup.files[$file] }
}
# Newer than the previous complete backup, but completed with warnings or from another tenant: skipped.
Add-TestBlob "backup-2026-11-05-120000/metadata.json" ([ordered]@{ Status = "CompletedWithWarnings"; TenantId = $tenant; Items = [ordered]@{} })
Add-TestBlob "backup-2026-11-05-180000/metadata.json" ([ordered]@{ Status = "Success"; TenantId = "11111111-1111-1111-1111-111111111111"; Items = [ordered]@{} })
$folders = @("backup-2026-11-04-020000", $fixture.older.name, "backup-2026-11-05-120000", "backup-2026-11-05-180000", $fixture.newer.name)

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType)
    if ($Method -eq "Put") { $script:Writes.Add([ordered]@{ uri = $Uri; contentType = $ContentType; headers = $Headers; body = [Text.Encoding]::UTF8.GetString($BodyBytes) }); return @{ Status = 201 } }
    if ($Uri -like "*comp=list*") {
        $text = "<?xml version=`"1.0`"?><EnumerationResults><Blobs>" + (($folders | ForEach-Object { "<BlobPrefix><Name>$_/</Name></BlobPrefix>" }) -join "") + "</Blobs><NextMarker /></EnumerationResults>"
        return @{ Status = 200; Text = $text; Bytes = [Text.Encoding]::UTF8.GetBytes($text) }
    }
    if ($Uri -like "https://graph.microsoft.com/beta/deviceManagement/configurationSettings/*") {
        $id = [uri]::UnescapeDataString(($Uri -split "/")[-1])
        if (-not $fixture.definitions.Contains($id) -or $null -eq $fixture.definitions[$id]) { throw [TvHttpError]::new(404, "HTTP 404") }
        $text = ConvertTo-TvJsJson $fixture.definitions[$id]
        return @{ Status = 200; Text = $text; Bytes = [Text.Encoding]::UTF8.GetBytes($text) }
    }
    if ($Uri -like "https://graph.microsoft.com/beta/deviceManagement/auditEvents*") {
        if ($Uri -notlike "*activityDateTime%20gt%202026-11-05T02%3A00%3A00.000Z%20and%20activityDateTime%20le%202026-11-06T02%3A00%3A00.000Z*") { throw "Unexpected audit window: $Uri" }
        if ($Uri -like "*orderby*") { throw "The audit read must not order: Graph then scans the whole history first." }
        # Graph answers with empty pages while it moves through its partitions.
        if ($Uri -notlike "*skiptoken=page2*") {
            $text = ConvertTo-TvJsJson ([ordered]@{ value = @(); "@odata.nextLink" = "$Uri&`$skiptoken=page2" })
            return @{ Status = 200; Text = $text; Bytes = [Text.Encoding]::UTF8.GetBytes($text) }
        }
        $text = ConvertTo-TvJsJson ([ordered]@{ value = $fixture.audit })
        return @{ Status = 200; Text = $text; Bytes = [Text.Encoding]::UTF8.GetBytes($text) }
    }
    if ($script:Blobs.ContainsKey($Uri)) { return @{ Status = 200; Bytes = $script:Blobs[$Uri]; Text = "" } }
    throw [TvHttpError]::new(404, "HTTP 404 BlobNotFound")
}
function Get-TvAutomationVariable {
    param([string]$Name)
    switch ($Name) { "TenuVaultChangeReport" { return $Level } "TenuVaultTenantName" { return $fixture.tenantName } default { return $null } }
}
$context = @{ TenantId = $tenant; StorageAccount = $account; StorageToken = "storage-token"; Master = $master }
$output = @(Invoke-TvChangeReport -Context $context -BackupFolder $fixture.newer.name -Metadata $fixture.newer.metadata -Types (Get-TvTypes) -GraphToken "graph-token" -RunId "run-1")
[Console]::Out.Write((ConvertTo-TvJsJson ([ordered]@{ output = @($output | ForEach-Object { [string]$_ }); writes = $script:Writes.ToArray() })))
