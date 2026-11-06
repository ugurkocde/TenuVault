# Runs the whole watcher runbook once against in-memory stand-ins for Automation variables,
# the managed identity endpoint, blob storage, Microsoft Graph and the webhook and Teams
# endpoints, then prints one JSON line: what was posted where, the heartbeat, and the
# runbook output. The watcher tests use it to check where the alerts come from.
param(
    [Parameter(Mandatory)][string]$AlertsBlobPath,
    [Parameter(Mandatory)][string]$AlertsVariablePath,
    [switch]$AlertsReadFails
)

$ErrorActionPreference = "Stop"
$runbook = Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
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
$global:TvRunPosts = [System.Collections.Generic.List[object]]::new()
$global:TvRunAudit = $fixture.intune

function global:Get-AutomationVariable { param([string]$Name) if ($global:TvRunVariables.ContainsKey($Name)) { return $global:TvRunVariables[$Name] } throw "Variable $Name not found." }
function global:Start-Sleep { }

function global:Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [string]$Method = "Get", $Body, [string]$ContentType, [int]$TimeoutSec)
    if ($Uri -like "http://169.254.169.254/*") { return [pscustomobject]@{ access_token = "token" } }
    if ($Uri -like "https://graph.microsoft.com/*deviceManagement/auditEvents*") { return [pscustomobject]@{ value = @($global:TvRunAudit) } }
    if ($Uri -like "https://graph.microsoft.com/*") { return [pscustomobject]@{ value = @() } }
    throw "Unexpected REST call to $Uri"
}

function global:Invoke-WebRequest {
    param([string]$Uri, [string]$Method = "Get", [hashtable]$Headers, $Body, [string]$ContentType, [switch]$UseBasicParsing, [int]$TimeoutSec, [int]$MaximumRedirection)
    $response = { param($code, $content) [pscustomobject]@{ StatusCode = $code; Content = $content; Headers = @{} } }
    if ($Uri -like "https://tvlab.blob.core.windows.net/*") {
        $path = ([uri]$Uri).AbsolutePath.TrimStart("/")
        $query = ([uri]$Uri).Query
        if ($query -like "*comp=lease*") { return (& $response 201 "") }
        if ($query -like "*comp=list*") { return (& $response 200 '<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs></Blobs></EnumerationResults>') }
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
        return (& $response 202 "")
    }
    throw "Unexpected web request to $Uri"
}

$output = & $runbook *>&1 | ForEach-Object { [string]$_ }
$titles = foreach ($post in $global:TvRunPosts) {
    $parsed = $post.body | ConvertFrom-Json
    $title = if ($parsed.title) { $parsed.title } elseif ($parsed.attachments) { $parsed.attachments[0].content.body[0].text } else { "?" }
    [pscustomobject]@{ host = $post.host; title = [string]$title; envelopeTitle = [string]$parsed.title }
}
$heartbeat = $global:TvRunBlobs["tenuvault-notification-state/heartbeat.json"] | ConvertFrom-Json
Write-Output (ConvertTo-Json -Depth 6 -Compress ([ordered]@{
    posts = @($titles)
    heartbeat = $heartbeat
    output = @($output)
}))
