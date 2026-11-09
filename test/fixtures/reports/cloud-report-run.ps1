# Runs the cloud backup runbook's change report step against faked storage and Graph, for
# test/cloud-change-report.test.ts: backups are plain JSON like real ones since runbook 1.2.0, a
# legacy sealed backup sits in between, and every write is captured. Prints the writes and the
# runbook output. -Scenario nopredecessor leaves only backups the runbook must skip; succeeded
# adds an earlier backup recorded as Succeeded; oversized adds a newer backup whose metadata.json
# is over 32 MiB and an oversized policy file in the previous backup; crowded puts other tenants'
# folders between the backups; throws makes storage fail with an unexpected error; stalled makes
# a newer manifest and a policy file of the previous backup miss the body read deadline.
param([Parameter(Mandatory)][string]$FixturePath, [string]$Level = "full", [string]$Scenario = "default")
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly
$fixture = ConvertFrom-TvJson ([IO.File]::ReadAllText($FixturePath))
$tenant = [string]$fixture.tenantId
$other = "11111111-1111-1111-1111-111111111111"
$account = "tvteststore"
$script:Blobs = @{}
$script:Writes = [System.Collections.Generic.List[object]]::new()
$script:Methods = [System.Collections.Generic.List[string]]::new()
$script:Reads = [System.Collections.Generic.List[string]]::new()
function Add-TestBlob([string]$Name, [object]$Value) {
    $script:Blobs[(Get-TvBlobTarget $account $Name).Uri] = [Text.Encoding]::UTF8.GetBytes((ConvertTo-TvJsJson $Value))
}
# A blob in the legacy TVAZ1 envelope: magic, nonce, tag and cipher text the runbook has no key for.
function Add-SealedTestBlob([string]$Name) {
    $script:Blobs[(Get-TvBlobTarget $account $Name).Uri] = [byte[]]([Text.Encoding]::ASCII.GetBytes("TVAZ1`n") + [byte[]](1..60))
}
$newestSealed = "backup-2026-11-05-220000"
if ($Scenario -eq "nopredecessor") {
    # Only backups that must be skipped: sealed, untagged, another tenant's by marker.
    Add-SealedTestBlob "backup-2026-11-05-020000/metadata.json"
    Add-TestBlob "backup-2026-11-05-060000/metadata.json" ([ordered]@{ Status = "Success"; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-080000/metadata.json" ([ordered]@{ Status = "Success"; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-080000/.tenuvault-owner.json" ([ordered]@{ TenantId = $other })
    $folders = @("backup-2026-11-05-020000", "backup-2026-11-05-060000", "backup-2026-11-05-080000", $newestSealed, $fixture.newer.name)
} else {
    foreach ($side in @("older", "newer")) {
        $backup = $fixture[$side]
        Add-TestBlob "$($backup.name)/metadata.json" $backup.metadata
        foreach ($file in $backup.files.Keys) { Add-TestBlob "$($backup.name)/$file" $backup.files[$file] }
    }
    # Newer than the previous complete backup, but completed with warnings, from another tenant (by
    # its manifest or, with no tenant in the manifest, by its ownership marker), untagged, or naming
    # an invalid tenant: skipped.
    Add-TestBlob "backup-2026-11-05-120000/metadata.json" ([ordered]@{ Status = "CompletedWithWarnings"; TenantId = $tenant; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-180000/metadata.json" ([ordered]@{ Status = "Success"; TenantId = $other; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-190000/metadata.json" ([ordered]@{ Status = "Success"; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-190000/.tenuvault-owner.json" ([ordered]@{ TenantId = $other })
    Add-TestBlob "backup-2026-11-05-200000/metadata.json" ([ordered]@{ Status = "Success"; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-210000/metadata.json" ([ordered]@{ Status = "Success"; TenantId = ""; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-210000/.tenuvault-owner.json" ([ordered]@{ TenantId = $tenant })
    # Recorded failures or no completed status: not complete, skipped.
    Add-TestBlob "backup-2026-11-05-110000/metadata.json" ([ordered]@{ Status = "Success"; Failures = 2; TenantId = $tenant; Items = [ordered]@{} })
    Add-TestBlob "backup-2026-11-05-115000/metadata.json" ([ordered]@{ Status = "Running"; TenantId = $tenant; Items = [ordered]@{} })
    $folders = [System.Collections.Generic.List[string]]@("backup-2026-11-04-020000", $fixture.older.name, "backup-2026-11-05-110000", "backup-2026-11-05-115000", "backup-2026-11-05-120000", "backup-2026-11-05-180000", "backup-2026-11-05-190000", "backup-2026-11-05-200000", "backup-2026-11-05-210000", $newestSealed, $fixture.newer.name)
    if ($Scenario -eq "succeeded") {
        # The app's status normalizer reads Succeeded as complete, with Failures 0.
        $metadata = ConvertFrom-TvJson (ConvertTo-TvJsJson $fixture.older.metadata)
        $metadata.Status = "Succeeded"
        $metadata.Failures = 0
        Add-TestBlob "backup-2026-11-05-100000/metadata.json" $metadata
        foreach ($file in $fixture.older.files.Keys) { Add-TestBlob "backup-2026-11-05-100000/$file" $fixture.older.files[$file] }
        $folders.Insert(2, "backup-2026-11-05-100000")
    }
    if ($Scenario -eq "oversized") {
        # One byte over the 32 MiB cap: skipped with a line in the output, never parsed.
        $script:Blobs[(Get-TvBlobTarget $account "backup-2026-11-05-230000/metadata.json").Uri] = [byte[]]::new(33554433)
        $folders.Insert($folders.Count - 1, "backup-2026-11-05-230000")
        $script:Blobs[(Get-TvBlobTarget $account "$($fixture.older.name)/DeviceConfigurations/Wi-Fi.json").Uri] = [byte[]]::new(33554433)
    }
    if ($Scenario -eq "stalled") { $folders.Insert($folders.Count - 1, "backup-2026-11-05-230000") }
    if ($Scenario -eq "crowded") {
        # 40 other tenants' backups between the two: skipped by their markers, manifests unread.
        for ($i = 0; $i -lt 40; $i++) {
            $name = "backup-2026-11-05-03{0:d2}00" -f $i
            Add-TestBlob "$name/.tenuvault-owner.json" ([ordered]@{ TenantId = $other })
            Add-TestBlob "$name/metadata.json" ([ordered]@{ Status = "Success"; TenantId = $other; Items = [ordered]@{} })
            $folders.Insert(2, $name)
        }
    }
}
# The newest earlier backup is a legacy sealed one of this tenant: skipped, never opened.
Add-SealedTestBlob "$newestSealed/metadata.json"
Add-SealedTestBlob "$newestSealed/.tenuvault-owner.json"

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes = 0)
    $script:Methods.Add($Method)
    if ($Scenario -eq "throws" -and $Method -eq "Get") { throw [InvalidOperationException]::new("storage is unavailable") }
    if ($Scenario -eq "stalled" -and ($Uri -like "*/backup-2026-11-05-230000/metadata.json" -or $Uri -like "*/$($fixture.older.name)/DeviceConfigurations/Wi-Fi.json")) { throw [TvReadTimeoutError]::new("The response did not arrive within 90 seconds.") }
    if ($Method -eq "Get") { $script:Reads.Add($Uri) }
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
        $from = if ($Scenario -eq "succeeded") { "2026-11-05T10%3A00%3A00.000Z" } else { "2026-11-05T02%3A00%3A00.000Z" }
        if ($Uri -notlike "*activityDateTime%20gt%20$from%20and%20activityDateTime%20le%202026-11-06T02%3A00%3A00.000Z*") { throw "Unexpected audit window: $Uri" }
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
$context = @{ TenantId = $tenant; StorageAccount = $account; StorageToken = "storage-token" }
$output = @(Invoke-TvChangeReport -Context $context -BackupFolder $fixture.newer.name -Metadata $fixture.newer.metadata -Types (Get-TvTypes) -GraphToken "graph-token" -RunId "run-1")
[Console]::Out.Write((ConvertTo-TvJsJson ([ordered]@{ output = @($output | ForEach-Object { [string]$_ }); writes = $script:Writes.ToArray(); methods = @($script:Methods | Sort-Object -Unique); reads = $script:Reads.ToArray() })))
