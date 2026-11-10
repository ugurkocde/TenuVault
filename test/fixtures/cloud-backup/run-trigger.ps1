<#
.SYNOPSIS
    Runs Get-TvRunTrigger from the cloud backup runbook against a local ARM stand-in, for
    test/cloud-backup-runbook.test.ts, and prints one JSON object with each case's result.
    The stand-in answers GET .../jobs/<id> by the subscription segment of the path: "scheduler"
    and "user" return a job, "denied" a 403, "nostarter" a job without startedBy, "stall" never
    answers within the lookup timeout.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$port = Get-Random -Minimum 20000 -Maximum 60000
$prefix = "http://127.0.0.1:$port/"
$server = Start-ThreadJob -ArgumentList $prefix -ScriptBlock {
    param($prefix)
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add($prefix)
    $listener.Start()
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $path = $context.Request.Url.AbsolutePath
        $case = ($path -split "/")[2]
        $status = 200
        $body = switch ($case) {
            "scheduler" { '{"name":"job","properties":{"startedBy":"{scheduler}","status":"Running"}}' }
            "user" { '{"name":"job","properties":{"startedBy":"admin@contoso.example","status":"Running"}}' }
            "nostarter" { '{"name":"job","properties":{"status":"Running"}}' }
            "denied" { $status = 403; '{"error":{"code":"AuthorizationFailed","message":"no access"}}' }
            "stall" { Start-Sleep -Seconds 8; '{"properties":{"startedBy":"{scheduler}"}}' }
            default { $status = 404; '{}' }
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($body)
        try {
            $context.Response.StatusCode = $status
            $context.Response.ContentType = "application/json"
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
        } catch { }
    }
}
Start-Sleep -Milliseconds 500

$script:ArmEndpoint = "http://127.0.0.1:$port"
$script:JobLookupSeconds = 1
$script:tokenCalls = [System.Collections.Generic.List[string]]::new()
$script:failToken = $false
function Get-TvManagedIdentityToken {
    param([string]$Resource, [int]$Attempts = 3, [int]$TimeoutSec = 30)
    $script:tokenCalls.Add("$Resource attempts=$Attempts timeout=$TimeoutSec")
    if ($script:failToken) { throw "Could not get a managed identity token for $Resource." }
    return "token"
}

$jobId = "5b8a3960-e8ab-45f6-bec6-567df8467d1a"
# The stand-in reads the case from the subscription segment of the path.
$account = { param($case) "/subscriptions/$case/resourceGroups/rg/providers/Microsoft.Automation/automationAccounts/aa" }
$results = [ordered]@{}
foreach ($case in @("scheduler", "user", "nostarter", "denied")) { $results[$case] = Get-TvRunTrigger -JobId $jobId -AccountId (& $account $case) }
$clock = [Diagnostics.Stopwatch]::StartNew()
$results["stall"] = Get-TvRunTrigger -JobId $jobId -AccountId (& $account "stall")
$stallSeconds = $clock.Elapsed.TotalSeconds
$before = $script:tokenCalls.Count
$results["nojob"] = Get-TvRunTrigger -JobId "" -AccountId (& $account "scheduler")
$results["noaccount"] = Get-TvRunTrigger -JobId $jobId -AccountId $null
$skippedCalls = $script:tokenCalls.Count - $before
$script:failToken = $true
$results["notoken"] = Get-TvRunTrigger -JobId $jobId -AccountId (& $account "user")
Stop-Job $server -ErrorAction SilentlyContinue
Remove-Job $server -Force -ErrorAction SilentlyContinue
[Console]::Out.Write((ConvertTo-Json -Depth 5 -Compress ([ordered]@{ results = $results; stallSeconds = $stallSeconds; skippedCalls = $skippedCalls; tokenCalls = @($script:tokenCalls) })))
