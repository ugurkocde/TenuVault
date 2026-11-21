# Runs the whole watcher runbook once against in-memory stand-ins for Automation variables,
# the managed identity endpoint, blob storage, Microsoft Graph and the webhook and Teams
# endpoints, then prints one JSON line: what was posted where, the heartbeat, and the
# runbook output. The watcher tests use it to check where the alerts come from.
param(
    [Parameter(Mandatory)][string]$AlertsBlobPath,
    [Parameter(Mandatory)][string]$AlertsVariablePath,
    [switch]$AlertsReadFails,
    [switch]$AuditStatusStalls,
    [ValidateSet("Baseline", "New", "Retry")][string]$QuotaScenario,
    [string]$RunbookPath = (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1")
)

$ErrorActionPreference = "Stop"
$fixture = Get-Content (Join-Path $PSScriptRoot "alert-live.json") -Raw | ConvertFrom-Json

class TvHttpError : System.Exception {
    [object]$Response
    TvHttpError([int]$code) : base("The remote server returned an error: ($code).") { $this.Response = [pscustomobject]@{ StatusCode = $code } }
}

$global:TvRunVariables = @{
    TenuVaultTenantId = $fixture.tenantId
    TenuVaultTenantName = "Lab"
    TenuVaultStorageAccount = "tvlab"
    TenuVaultWebhookUrl = "https://hooks.example.test/watcher"
    TenuVaultTeamsWebhookUrl = "https://contoso.webhook.office.com/workflows/watcher"
    TenuVaultMissedBackupHours = "8760"
    TenuVaultIncludeActor = "true"
}
$variableText = Get-Content -LiteralPath $AlertsVariablePath -Raw
if ($variableText) { $global:TvRunVariables["TenuVaultAlertRules"] = $variableText.Trim() }
$global:TvRunBlobs = @{}
$blobText = Get-Content -LiteralPath $AlertsBlobPath -Raw
if ($blobText) { $global:TvRunBlobs["tenuvault-notification-state/alerts.json"] = $blobText }
$global:TvRunAlertsReadFails = [bool]$AlertsReadFails
$global:TvAuditStatusStalls = [bool]$AuditStatusStalls
$global:PSPrivateMetadata = @{ JobId = [guid]"55555555-5555-4555-8555-555555555555" }
$global:TvRunPosts = [System.Collections.Generic.List[object]]::new()
$global:TvRunAudit = $fixture.intune
$global:TvSimTime = 0
$global:TvLeaseExpiry = 0
$global:TvAuditStatusReads = [System.Collections.Generic.List[object]]::new()

if ($QuotaScenario) {
    $global:TvRunVariables.Remove("TenuVaultTeamsWebhookUrl")
    $global:TvRunVariables.TenuVaultMailSender = "reports@example.test"
    $global:TvRunVariables.TenuVaultReportRecipients = "operator@example.test"
    $global:TvRunAudit = @()
    $global:TvDeliveryOrder = [System.Collections.Generic.List[string]]::new()
    $now = [DateTime]::UtcNow
    $at = $now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    $state = @{ tenantId = $fixture.tenantId; mailVerified = $true; mailVerifiedSender = "reports@example.test"; mailVerifiedAt = $at }
    if ($QuotaScenario -eq "Retry") {
        $state.pendingEnvelopes = @(@{
            envelope = @{ type = "backup.warning"; title = "Cloud backup audit needs attention"; eventId = "a" * 64 }
            intendedChannels = @("webhook"); attempts = 4; attemptsByChannel = @{ webhook = 4 }
        })
    }
    $global:TvRunBlobs["tenuvault-notification-state/state.json"] = $state | ConvertTo-Json -Depth 8
    if ($QuotaScenario -eq "New") {
        $tenantKey = $fixture.tenantId.Substring(0, 8).ToLowerInvariant()
        $global:TvRunBlobs["intune-backups/cloud-backup-status-$tenantKey.json"] = @{
            TenantId = $fixture.tenantId; RunId = "22222222-2222-4222-8222-222222222222"; LastRunAt = $at; AuditDeliveryPending = $true
        } | ConvertTo-Json
    }
    $folder = "backup-" + $now.ToString("yyyy-MM-dd-HHmmss")
    $global:TvReportName = "cloud-change-reports/$folder.json"
    $global:TvReportBody = @{
        schema = "tenuvault.cloud-change-report/v1"; tenantId = $fixture.tenantId; backupFolder = $folder; createdAt = $at
        email = @{ severity = "info"; title = "Cloud change report"; summary = "One change"; naturalKey = $folder; occurredAt = $at; moreCount = 0 }
    } | ConvertTo-Json
    $global:TvRunBlobs["tenuvault-backup-results/$global:TvReportName"] = $global:TvReportBody
}

function global:Get-AutomationVariable { param([string]$Name) if ($global:TvRunVariables.ContainsKey($Name)) { return $global:TvRunVariables[$Name] } throw "Variable $Name not found." }
function global:Start-Sleep { }

function global:Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [string]$Method = "Get", $Body, [string]$ContentType, [int]$TimeoutSec)
    if ($Uri -like "http://169.254.169.254/*") {
        $claims = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"oid":"33333333-3333-4333-8333-333333333333"}')).TrimEnd("=").Replace("+", "-").Replace("/", "_")
        return [pscustomobject]@{ access_token = "header.$claims.signature" }
    }
    if ($Uri -like "https://graph.microsoft.com/*deviceManagement/auditEvents*") { return [pscustomobject]@{ value = @($global:TvRunAudit) } }
    if ($Uri -like "https://graph.microsoft.com/*/sendMail") {
        $mail = [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
        $global:TvDeliveryOrder.Add($mail.message.subject)
        return
    }
    if ($Uri -like "https://graph.microsoft.com/*") { return [pscustomobject]@{ value = @() } }
    throw "Unexpected REST call to $Uri"
}

function global:Invoke-WebRequest {
    param([string]$Uri, [string]$Method = "Get", [hashtable]$Headers, $Body, [string]$ContentType, [switch]$UseBasicParsing, [int]$TimeoutSec, [int]$MaximumRedirection)
    $response = { param($code, $content) [pscustomobject]@{ StatusCode = $code; Content = $content; Headers = @{} } }
    if ($Uri -like "https://tvlab.blob.core.windows.net/*") {
        $path = ([uri]$Uri).AbsolutePath.TrimStart("/")
        $query = ([uri]$Uri).Query
        if ($global:TvAuditStatusStalls -and $Method -eq "Get" -and $path -like "intune-backups/cloud-backup-status-*.json") {
            $global:TvAuditStatusReads.Add(@{ timeout = $TimeoutSec; duringLease = $global:TvSimTime -lt $global:TvLeaseExpiry })
            $global:TvSimTime += $TimeoutSec
            throw "Audit status request timed out"
        }
        if ($query -like "*comp=lease*") {
            $action = $Headers["x-ms-lease-action"]
            if ($action -ne "acquire" -and $global:TvSimTime -ge $global:TvLeaseExpiry) { throw [TvHttpError]::new(412) }
            $global:TvLeaseExpiry = if ($action -eq "release") { 0 } else { $global:TvSimTime + 60 }
            return (& $response 201 "")
        }
        if ($query -like "*comp=list*") {
            $blobs = if ($global:TvReportName -and $query -like "*prefix=cloud-change-reports*") {
                "<Blob><Name>$global:TvReportName</Name><Properties><Content-Length>$($global:TvReportBody.Length)</Content-Length></Properties></Blob>"
            }
            return (& $response 200 "<EnumerationResults><Blobs>$blobs</Blobs></EnumerationResults>")
        }
        if ($Method -eq "Get" -and $global:TvReportName -and $path -eq "tenuvault-backup-results/$global:TvReportName") {
            return [pscustomobject]@{ RawContentStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($global:TvReportBody)) }
        }
        if ($Method -eq "Put") {
            $global:TvRunBlobs[$path] = [Text.Encoding]::UTF8.GetString([byte[]]$Body)
            return (& $response 201 "")
        }
        if ($Method -eq "Delete") { $global:TvRunBlobs.Remove($path); return (& $response 202 "") }
        if ($global:TvRunAlertsReadFails -and $path -eq "tenuvault-notification-state/alerts.json") { throw [TvHttpError]::new(403) }
        if ($global:TvRunBlobs.ContainsKey($path)) { return (& $response 200 $global:TvRunBlobs[$path]) }
        throw [TvHttpError]::new(404)
    }
    if ($Uri -like "https://hooks.example.test/*" -or $Uri -like "https://contoso.webhook.office.com/*") {
        $text = if ($Body -is [byte[]]) { [Text.Encoding]::UTF8.GetString($Body) } else { [string]$Body }
        $global:TvRunPosts.Add([pscustomobject]@{ host = ([uri]$Uri).Host; body = $text })
        if ($null -ne $global:TvDeliveryOrder) {
            $global:TvDeliveryOrder.Add(($text | ConvertFrom-Json).title)
            if ($global:TvRunPosts.Count -gt 1) { throw [TvHttpError]::new(429) }
        }
        return (& $response 202 "")
    }
    throw "Unexpected web request to $Uri"
}

$output = & $RunbookPath *>&1 | ForEach-Object { [string]$_ }
$titles = foreach ($post in $global:TvRunPosts) {
    $parsed = $post.body | ConvertFrom-Json
    $title = if ($parsed.title) { $parsed.title } elseif ($parsed.attachments) { $parsed.attachments[0].content.body[0].text } else { "?" }
    [pscustomobject]@{ host = $post.host; title = [string]$title; envelopeTitle = [string]$parsed.title }
}
$heartbeat = $global:TvRunBlobs["tenuvault-notification-state/heartbeat.json"] | ConvertFrom-Json
$state = $global:TvRunBlobs["tenuvault-notification-state/state.json"] | ConvertFrom-Json
Write-Output (ConvertTo-Json -Depth 6 -Compress ([ordered]@{
    posts = @($titles)
    deliveryOrder = @($global:TvDeliveryOrder | ForEach-Object { $_ })
    pendingTitles = @($state.pendingEnvelopes | ForEach-Object { $_.envelope.title })
    deadTitles = @($state.deadEnvelopes | ForEach-Object { $_.envelope.title })
    auditStatusReads = $global:TvAuditStatusReads.ToArray()
    heartbeat = $heartbeat
    output = @($output)
}))
