# Builds the change report of test/fixtures/reports/cloud-backups.json with the cloud backup runbook,
# for test/cloud-change-report.test.ts. Prints the report, its Markdown and HTML, and the email fields.
param([Parameter(Mandatory)][string]$FixturePath, [string]$Level = "full", [string]$Actors = "true", [string]$AuditError = "")
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly
$fixture = ConvertFrom-TvJson ([IO.File]::ReadAllText($FixturePath))
$backups = @{}
foreach ($side in @("older", "newer")) { $backups[$fixture[$side].name] = $fixture[$side] }
$older = @{ Name = $fixture.older.name; Metadata = $fixture.older.metadata }
$newer = @{ Name = $fixture.newer.name; Metadata = $fixture.newer.metadata }
$readItem = {
    param($backup, $file)
    $files = $backups[$backup].files
    if (-not $files.Contains($file)) { throw "The file could not be read (404)." }
    return , (ConvertFrom-TvJson (ConvertTo-TvJsJson $files[$file]))
}
$compared = Get-TvBackupDrifts -Older $older -Newer $newer -Types (Get-TvTypes) -ReadItem $readItem
$rows = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $compared.Drifts) { foreach ($row in @($entry.changes | Where-Object { $null -ne $_ })) { $rows.Add($row) } }
$ids = [string[]](Get-TvDefinitionIds $rows)
$definitions = @{}
foreach ($id in $ids) { if ($fixture.definitions.Contains($id)) { $definitions[$id] = $fixture.definitions[$id] } }
$names = ConvertTo-TvSettingNames $ids $definitions
$drift = @{ drifts = $compared.Drifts; warnings = $compared.Warnings; settingNames = $names; baseline = (Get-TvBackupRef $older.Name $older.Metadata); comparison = (Get-TvBackupRef $newer.Name $newer.Metadata) }
$changes = @($fixture.audit | ForEach-Object { ConvertFrom-TvAuditEvent $_ } | Where-Object { $_ })
$options = @{ TenantId = $fixture.tenantId; TenantName = $fixture.tenantName; GeneratedAt = $fixture.generatedAt; IncludeValues = $Level -eq "full"; IncludeActors = $Actors -eq "true" }
$audit = if ($AuditError) { @{ Error = $AuditError } } else { @{ Changes = $changes; Note = $null } }
$report = New-TvChangeReport -Drift $drift -Audit $audit -Options $options
$output = [ordered]@{ ids = $ids; report = $report; markdown = ConvertTo-TvReportMarkdown $report; html = ConvertTo-TvReportHtml $report; email = Get-TvReportEmail $report; fileName = Get-TvReportFileName $report }
[Console]::Out.Write((ConvertTo-TvJsJson $output))
