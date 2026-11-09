# Runs the watcher's change report delivery against faked storage and mail, for
# test/cloud-change-report.test.ts. Notes come from a JSON file of { name: note text }. With
# -StatePath, the delivered report names are kept in that file between runs, as the watcher keeps
# them in its state; -FailDelete makes every delete fail with HTTP 403.
param([Parameter(Mandatory)][string]$NotesPath, [Parameter(Mandatory)][string]$TenantId, [string]$MailEnabled = "true", [string]$FailMail = "false", [string]$StatePath = "", [string]$FailDelete = "false")
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1") -LibraryOnly
$notes = [IO.File]::ReadAllText($NotesPath) | ConvertFrom-Json
$script:Stored = [ordered]@{}
foreach ($property in $notes.PSObject.Properties) { $script:Stored["cloud-change-reports/$($property.Name)"] = [string]$property.Value }
$script:Deleted = [System.Collections.Generic.List[string]]::new()
$script:Mails = [System.Collections.Generic.List[object]]::new()
$container = "https://tvteststore.blob.core.windows.net/tenuvault-backup-results"
function Invoke-TvStorageRequest {
    param([string]$Uri, [string]$Method = "Get", [string]$Token, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType)
    if ($Uri -like "*comp=list*") {
        $blobs = ($script:Stored.Keys | ForEach-Object { "<Blob><Name>$_</Name><Properties><Content-Length>$([Text.Encoding]::UTF8.GetByteCount($script:Stored[$_]))</Content-Length></Properties></Blob>" }) -join ""
        return [pscustomobject]@{ Content = "<?xml version=`"1.0`"?><EnumerationResults><Blobs>$blobs</Blobs><NextMarker /></EnumerationResults>" }
    }
    $name = [uri]::UnescapeDataString($Uri.Substring($container.Length + 1))
    if ($Method -eq "Delete") {
        if ($FailDelete -eq "true") { throw "The remote server returned an error: (403) Forbidden." }
        $script:Deleted.Add($name)
        return $null
    }
    $stream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($script:Stored[$name]))
    return [pscustomobject]@{ RawContentStream = $stream }
}
function Send-TvRawMail {
    param([string]$From, [string[]]$To, [string]$Subject, [string]$BodyText, [string]$GraphToken, [string]$BodyContentType, [object[]]$Attachments)
    if ($FailMail -eq "true") { throw "Mail send as $From failed with HTTP 403." }
    $script:Mails.Add([ordered]@{ from = $From; to = $To; subject = $Subject; attachments = @($Attachments | ForEach-Object { $_.name }); html = $BodyText })
}
$delivered = [System.Collections.Generic.List[string]]::new()
if ($StatePath -and (Test-Path $StatePath)) { foreach ($name in @([IO.File]::ReadAllText($StatePath) | ConvertFrom-Json)) { if ($name) { $delivered.Add([string]$name) } } }
$script:Saves = 0
$save = { $script:Saves++; if ($StatePath) { [IO.File]::WriteAllText($StatePath, (ConvertTo-Json -InputObject @($delivered.ToArray()) -Compress)) } }
$result = Send-TvChangeReports -ContainerUri $container -Token "storage" -TenantId $TenantId -TenantName "Contoso" -MailEnabled ($MailEnabled -eq "true") `
    -MailSender "reports@contoso.example" -Recipients "security@contoso.example; auditor@fabrikam.example" -GraphToken "graph" -RenewLease {} -Now ([DateTime]::Parse("2026-11-06T08:00:00Z").ToUniversalTime()) -Delivered $delivered -SaveState $save
[Console]::Out.Write(([ordered]@{ result = $result; deleted = $script:Deleted.ToArray(); mails = $script:Mails.ToArray(); delivered = @($delivered.ToArray()); saves = $script:Saves } | ConvertTo-Json -Depth 6 -Compress))
