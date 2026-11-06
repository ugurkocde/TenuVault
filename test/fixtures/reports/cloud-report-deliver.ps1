# Runs the watcher's change report delivery against faked storage and mail, for
# test/cloud-change-report.test.ts. Notes come from a JSON file of { name: note text }.
param([Parameter(Mandatory)][string]$NotesPath, [Parameter(Mandatory)][string]$TenantId, [string]$MailEnabled = "true", [string]$FailMail = "false")
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
    if ($Method -eq "Delete") { $script:Deleted.Add($name); return $null }
    $stream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($script:Stored[$name]))
    return [pscustomobject]@{ RawContentStream = $stream }
}
function Send-TvRawMail {
    param([string]$From, [string[]]$To, [string]$Subject, [string]$BodyText, [string]$GraphToken, [string]$BodyContentType, [object[]]$Attachments)
    if ($FailMail -eq "true") { throw "Mail send as $From failed with HTTP 403." }
    $script:Mails.Add([ordered]@{ from = $From; to = $To; subject = $Subject; attachments = @($Attachments | ForEach-Object { $_.name }); html = $BodyText })
}
$result = Send-TvChangeReports -ContainerUri $container -Token "storage" -TenantId $TenantId -TenantName "Contoso" -MailEnabled ($MailEnabled -eq "true") `
    -MailSender "reports@contoso.example" -Recipients "security@contoso.example; auditor@fabrikam.example" -GraphToken "graph" -RenewLease {} -Now ([DateTime]::Parse("2026-11-06T08:00:00Z").ToUniversalTime())
[Console]::Out.Write(([ordered]@{ result = $result; deleted = $script:Deleted.ToArray(); mails = $script:Mails.ToArray() } | ConvertTo-Json -Depth 6 -Compress))
