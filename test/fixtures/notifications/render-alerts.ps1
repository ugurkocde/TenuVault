<#
.SYNOPSIS
    Parity check for alerts: maps the live-shaped events in alert-live.json with the
    PowerShell watcher, plans the alerts for both services, and renders the first
    single-change alert as a Teams card and as mail. Writes one canonical JSON value per
    line so the test can compare each with the TypeScript result.
#>
[CmdletBinding()]
param(
    [string]$FixturePath,
    [string]$RunbookPath
)

$ErrorActionPreference = "Stop"

if (-not $FixturePath) { $FixturePath = Join-Path $PSScriptRoot "alert-live.json" }
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}

. $RunbookPath -LibraryOnly

$fixtureText = Get-Content $FixturePath -Raw
$fixture = $fixtureText | ConvertFrom-Json
$intune = [System.Collections.Generic.List[object]]::new()
foreach ($raw in $fixture.intune) { $change = ConvertFrom-TenuVaultAuditEvent $raw; if ($change) { $intune.Add($change) } }
$entra = [System.Collections.Generic.List[object]]::new()
foreach ($raw in $fixture.entra) { $change = ConvertFrom-TenuVaultEntraAuditEvent $raw; if ($change) { $entra.Add($change) } }

# The alerts reach the watcher as the JSON text of the Automation variable.
$alertsText = ConvertTo-TenuVaultCanonicalJson ([pscustomobject][ordered]@{ schema = "tenuvault.watcher-alerts/v1"; alerts = @($fixture.alerts) })
$alerts = ConvertFrom-TvWatcherAlerts $alertsText

$intunePlan = Get-TvChangeAlertPlan -Service intune -Changes @($intune.ToArray()) -Alerts $alerts -TenantId $fixture.tenantId -TenantName $fixture.tenantName -IncludeActor $true
$entraPlan = Get-TvChangeAlertPlan -Service conditionalAccess -Changes @($entra.ToArray()) -Alerts $alerts -TenantId $fixture.tenantId -TenantName $fixture.tenantName -IncludeActor $true

function ConvertTo-PlanJson {
    param([object[]]$Plan)
    $rows = foreach ($entry in $Plan) {
        [pscustomobject][ordered]@{
            alertIds = @($entry.alertIds.ToArray())
            destinations = Get-TvAlertDestinations -Alerts $alerts -AlertIds @($entry.alertIds.ToArray())
            envelope = $entry.envelope
        }
    }
    return ConvertTo-TenuVaultCanonicalJson @($rows)
}

$single = @($intunePlan | Where-Object { $_.envelope.items[0].change.auditId -eq "live-intune-update" -and ([string]$_.envelope.title).StartsWith("Intune change:") })[0].envelope
$style = Get-TvCardStyleFor $null "intune.change"

Write-Output (ConvertTo-TenuVaultCanonicalJson @($intune.ToArray()))
Write-Output (ConvertTo-TenuVaultCanonicalJson @($entra.ToArray()))
Write-Output (ConvertTo-PlanJson $intunePlan)
Write-Output (ConvertTo-PlanJson $entraPlan)
Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $single $style))
Write-Output (ConvertTo-TenuVaultCanonicalJson (Get-TvEmailHtml $single))
$failed = [pscustomobject]@{ type = "backup.failed"; severity = "critical" }
$legacy = Get-TvIntendedDestinations -Alerts $null -Envelope $failed -Planned $null -Configured @("webhook", "teams", "mail")
$routed = Get-TvIntendedDestinations -Alerts $alerts -Envelope $failed -Planned $null -Configured @("webhook", "teams")
$planned = Get-TvIntendedDestinations -Alerts $alerts -Envelope $failed -Planned @("webhook", "mail") -Configured @("webhook", "teams")
$nobody = Get-TvIntendedDestinations -Alerts $alerts -Envelope ([pscustomobject]@{ type = "restore.failed"; severity = "critical" }) -Planned $null -Configured @("webhook", "teams", "mail")
Write-Output (ConvertTo-TenuVaultCanonicalJson ([pscustomobject][ordered]@{ legacy = $legacy; routed = $routed; planned = $planned; nobody = $nobody }))
$taking = Get-TvAlertsTaking -Alerts $alerts -Envelope ([pscustomobject]@{ type = "backup.failed"; severity = "critical" })
Write-Output (ConvertTo-TenuVaultCanonicalJson $taking)

$mass = @($intunePlan | Where-Object { $_.envelope.type -eq "intune.massChange" })[0].envelope
Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $mass (Get-TvCardStyleFor $null "intune.massChange")))
Write-Output (ConvertTo-TenuVaultCanonicalJson (Get-TvEmailHtml $mass))

$note = @{
    schema = "tenuvault.cloud-backup-outcome/v1"
    tenantId = $fixture.tenantId
    status = "Success"
    runId = "test-run"
    backupFolder = "backup-2026-11-06-120000"
    finishedAt = "2026-11-06T12:00:00.000Z"
    comparison = @{
        deleted = @{ count = 1; items = @(@{ title = "Contoso removed profile" }) }
        updated = @{ count = 2; items = @(@{ title = "Contoso encryption"; actor = "Contoso automation" }) }
        created = @{ count = 0; items = @() }
    }
}
$outcome = ConvertFrom-TenuVaultBackupOutcome $note $fixture.tenantId
$backupPlan = @(Get-TvBackupMassChangePlan $outcome $alerts $fixture.tenantId $fixture.tenantName $true)
Write-Output (ConvertTo-TenuVaultCanonicalJson $backupPlan)

# Audit pages can return the newest event before older events.
$updatedThenDeleted = $intune[1] | Select-Object *
$updatedThenDeleted.auditId = "updated-before-deletion"
$updatedThenDeleted.resourceId = "removed-policy"
$updatedThenDeleted.at = $intune[0].at
$deletion = $updatedThenDeleted | Select-Object *
$deletion.auditId = "deletion"
$deletion.changeType = "deleted"
$deletion.at = $intune[1].at
$unsortedPlan = Get-TvChangeAlertPlan -Service intune -Changes @($intune[2], $deletion, $intune[0], $intune[1], $updatedThenDeleted) -Alerts $alerts -TenantId $fixture.tenantId -TenantName $fixture.tenantName -IncludeActor $true
$unsortedMass = @($unsortedPlan | Where-Object { $_.envelope.type -eq "intune.massChange" })[0].envelope
Write-Output (ConvertTo-TenuVaultCanonicalJson $unsortedMass)
