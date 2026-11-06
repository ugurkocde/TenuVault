# Turns a cloud change report note into the email the watcher sends, for test/cloud-change-report.test.ts.
param([Parameter(Mandatory)][string]$NotePath, [Parameter(Mandatory)][string]$TenantId, [string]$TenantName)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1") -LibraryOnly
$report = ConvertFrom-TenuVaultChangeReport (ConvertFrom-TvNoteJson ([IO.File]::ReadAllText($NotePath))) $TenantId
if ($null -eq $report) { throw "The note was refused." }
$attachments = Get-TvReportAttachments $report
$envelope = New-TenuVaultChangeReportEnvelope -Report $report -TenantId $TenantId -TenantName $TenantName -AttachmentNote $null
$output = [ordered]@{ html = Get-TvEmailHtml $envelope; attachments = @($attachments | ForEach-Object { $_.name }); severity = $envelope.severity; title = $envelope.title }
[Console]::Out.Write(($output | ConvertTo-Json -Compress -Depth 5))
