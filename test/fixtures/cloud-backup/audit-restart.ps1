param(
    [string]$RunbookPath = (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1"),
    [switch]$ParityOnly,
    [switch]$TimingOnly
)
$ErrorActionPreference = "Stop"
. $RunbookPath -LibraryOnly

$env:TenuVaultTenantId = "11111111-2222-3333-4444-555555555555"
$env:TenuVaultStorageAccount = "stcontoso"
$env:TenuVaultExcludedFolders = (Get-TvTypes | Where-Object { $_.Folder -ne "DeviceCategories" }).Folder -join ","
$PSPrivateMetadata = @{ JobId = [guid]"99999999-9999-4999-8999-999999999999" }
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:blobs = @{}
$script:backupBase = "https://stcontoso.blob.core.windows.net/intune-backups"
$script:resultBase = "https://stcontoso.blob.core.windows.net/tenuvault-backup-results"
$script:statusUri = "$script:backupBase/cloud-backup-status-11111111.json"

# Skip retry backoff in the fixture, but keep the runbook's retry loops and HTTP parsing.
function Start-Sleep { param([double]$Seconds) }
$script:identityCalls = 0
function Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [string]$Method, [int]$TimeoutSec)
    $script:identityCalls++
    if ($script:identityCalls -lt 3) { throw "Identity endpoint temporarily unavailable" }
    return @{ access_token = "token" }
}
$identityToken = Get-TvManagedIdentityToken "https://storage.azure.com/"
function Get-TvManagedIdentityToken { param([string]$Resource) return "token" }

function New-Response {
    param([int]$Status, [string]$Text)
    $response = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$Status)
    $response.Content = [System.Net.Http.StringContent]::new($Text)
    $response.Headers.ETag = [System.Net.Http.Headers.EntityTagHeaderValue]::new('"version"')
    return [System.Threading.Tasks.Task]::FromResult($response)
}
function Get-RequestHeader {
    param($Request, [string]$Name)
    if ($Request.Headers.Contains($Name)) { return [string]::Join(",", $Request.Headers.GetValues($Name)) }
}

function Publish-OtherRun {
    if ($script:otherRunPublished) { return }
    $script:otherRunPublished = $true
    $script:notesAtOtherWrite = @($script:blobs.Keys | Where-Object { $_ -like "*/cloud-backup-outcomes/*" }).Count
    $script:blobs[$script:statusUri] = '{"LastStatus":"Failed","BackupFolder":"backup-other-run"}'
}

$script:HttpClient.Dispose()
$script:HttpClient = [pscustomobject]@{}
$script:HttpClient | Add-Member ScriptMethod SendAsync {
    param($Request, $Completion, $Cancellation)
    $uri = $Request.RequestUri.AbsoluteUri
    $method = $Request.Method.Method
    $ifNoneMatch = Get-RequestHeader $Request "If-None-Match"
    $body = if ($Request.Content) { $Request.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
    $script:calls.Add(@{ uri = $uri; method = $method; condition = Get-RequestHeader $Request "If-Match"; ifNoneMatch = $ifNoneMatch; body = $body })
    if ($script:scenario -eq "stalledTerminal" -and $method -eq "Put" -and $uri.EndsWith("/terminal.json")) {
        Publish-OtherRun
        if ($Cancellation -and $Cancellation.CanBeCanceled) {
            [System.Threading.Tasks.Task]::Delay(8000, $Cancellation).GetAwaiter().GetResult()
        }
        throw "Terminal audit request timed out"
    }
    if ($script:scenario -eq "stalledStart" -and $method -eq "Put" -and $uri.EndsWith("/start.json")) {
        if (-not $Cancellation -or -not $Cancellation.CanBeCanceled) { throw "Start checkpoint had no deadline" }
        [System.Threading.Tasks.Task]::Delay(8000, $Cancellation).GetAwaiter().GetResult()
    }
    if ($script:scenario -eq "stalledStart" -and $uri -like "*/deviceManagement/deviceCategories") {
        $script:graphAtMs = $script:captureClock.ElapsedMilliseconds
    }
    if ($script:scenario -eq "transportDown") { throw "Transport unavailable" }
    if ($script:scenario -eq "resultsDenied" -and $uri.StartsWith($script:resultBase)) { return New-Response 403 "Results container denied" }
    if ($script:scenario -eq "receiptDenied" -and $uri -like "*/audit-receipts/*") { return New-Response 403 "Receipt denied" }
    if ($script:scenario -eq "startDenied" -and $uri.EndsWith("/start.json")) { return New-Response 403 "Start denied" }
    if ($script:scenario -eq "terminalReadDenied" -and $uri.EndsWith("/terminal.json") -and $method -eq "Get") { return New-Response 403 "Terminal read denied" }
    if ($uri -like "https://graph.microsoft.com/*") {
        if ($script:scenario -eq "graph401" -or ($script:scenario -eq "failedWatcher" -and $uri -like "*/deviceManagement/deviceCategories/*")) {
            return New-Response 401 "Graph denied"
        }
        if ($script:scenario -in @("page429", "page503", "pageCancelled")) {
            if ($uri.EndsWith("/deviceManagement/deviceCategories")) {
                return New-Response 200 '{"value":[{"id":"category-1","displayName":"Example"}],"@odata.nextLink":"https://graph.microsoft.com/beta/deviceManagement/deviceCategories?page=2"}'
            }
            if ($uri.EndsWith("/deviceManagement/deviceCategories?page=2")) {
                if ($script:scenario -eq "pageCancelled") { throw [OperationCanceledException]::new("Graph request was cancelled") }
                return New-Response ([int]$script:scenario.Substring(4)) "Graph temporarily unavailable"
            }
        }
        if ($uri -like "*/deviceManagement/deviceCategories/*") { return New-Response 200 '{"id":"category-1","displayName":"Example"}' }
        if ($uri -like "*/deviceManagement/deviceCategories") { return New-Response 200 '{"value":[{"id":"category-1","displayName":"Example"}]}' }
        return New-Response 200 '{"value":[]}'
    }
    if ($uri -like "*comp=list*") {
        $prefix = [uri]::UnescapeDataString([regex]::Match($uri, '[?&]prefix=([^&]*)').Groups[1].Value)
        $marker = [uri]::UnescapeDataString([regex]::Match($uri, '[?&]marker=([^&]*)').Groups[1].Value)
        $names = @($script:blobs.Keys | Where-Object { $_.StartsWith("$script:resultBase/$prefix") } |
            ForEach-Object { $_.Substring($script:resultBase.Length + 1) } | Sort-Object |
            Where-Object { [string]::CompareOrdinal($_, $marker) -gt 0 })
        $limit = 5
        $next = if ($names.Count -gt $limit) { $names[$limit - 1] }
        $items = ($names | Select-Object -First $limit | ForEach-Object { "<Blob><Name>$_</Name></Blob>" }) -join ""
        return New-Response 200 "<EnumerationResults><Blobs>$items</Blobs><NextMarker>$next</NextMarker></EnumerationResults>"
    }
    if ($uri.EndsWith("/metadata.json") -and $script:scenario -eq "manifest503") {
        if ($method -eq "Get") { return New-Response 503 "Manifest read-back unavailable" }
        # Only the normal PUT fails. Main exhausts its retries and leaves a create-only Failed manifest.
        if ($method -eq "Put" -and $ifNoneMatch -ne "*") { return New-Response 503 "Manifest storage unavailable" }
        if ($method -eq "Put" -and $ifNoneMatch -eq "*" -and ($body | ConvertFrom-Json).Status -ne "Failed") {
            return New-Response 503 "Manifest storage unavailable"
        }
    }
    if ($method -eq "Put") {
        if ($uri -eq $script:statusUri -and $script:scenario -eq "status503") { return New-Response 503 "Schedule status storage unavailable" }
        if ($uri -like "*/audit-logs/*") {
            if ($script:scenario -eq "auditWriteDenied") { return New-Response 403 "Audit create denied" }
            if (-not $ifNoneMatch) { return New-Response 403 "Overwrite denied" }
        }
        if ($ifNoneMatch -eq "*" -and $script:blobs.ContainsKey($uri)) { return New-Response 412 "Already exists" }
        $script:blobs[$uri] = $body
        return New-Response 201 ""
    }
    if (-not $script:blobs.ContainsKey($uri)) { return New-Response 404 "Blob not found" }
    return New-Response 200 $script:blobs[$uri]
}

function Invoke-Probe {
    param([string]$Scenario, [switch]$Restart)
    if ($Restart) { Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds 1050 }
    $script:scenario = $Scenario
    $script:calls.Clear()
    $script:OutcomeSent = $false
    $message = $null
    $output = [System.Collections.Generic.List[string]]::new()
    $jobErrors = [System.Collections.Generic.List[string]]::new()
    try {
        Invoke-TvBackup 2>&1 3>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $jobErrors.Add([string]$_) }
            $output.Add([string]$_)
        }
    } catch { $message = $_.Exception.Message }
    return @{ calls = $script:calls.ToArray(); error = $message; jobErrors = $jobErrors.ToArray(); output = $output.ToArray(); blobs = $script:blobs.Clone() }
}

if ($TimingOnly) {
    $script:captureClock = [Diagnostics.Stopwatch]::StartNew()
    $capture = Invoke-Probe "stalledStart"
    $script:blobs.Clear()
    $schedule = Invoke-Probe "stalledTerminal"
    # Main has no terminal audit request. Simulate the second run after the first run's publication.
    Publish-OtherRun
    $result = @{
        capture = @{ error = $capture.error; graphAtMs = $script:graphAtMs; calls = $capture.calls }
        schedule = @{ error = $schedule.error; notesAtOtherWrite = $script:notesAtOtherWrite
            status = ($script:blobs[$script:statusUri] | ConvertFrom-Json); calls = $schedule.calls }
    }
    [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 10))
    return
}

$cursorUri = "$script:resultBase/audit-cursors/$env:TenuVaultTenantId.json"
$script:blobs[$cursorUri] = '{"olderCount":"invalid","days":{}}'
$results = @{ corruptCursor = @(Invoke-Probe "normal") }
$script:blobs.Clear()
$results.manifest503 = @(Invoke-Probe "manifest503")

$script:blobs.Clear()
$script:blobs[$script:statusUri] = @{ TenantId = $env:TenuVaultTenantId; LastStatus = "Failed"; LastRunAt = "2099-01-01T00:00:00.000Z" } | ConvertTo-Json -Compress
$results.statusRestart = @((Invoke-Probe "status503"), (Invoke-Probe "normal" -Restart))
$script:blobs.Clear()
$results.watcherRestart = @((Invoke-Probe "failedWatcher"), (Invoke-Probe "normal" -Restart))

if (-not $ParityOnly) {
    $script:blobs.Clear()
    $first = Invoke-Probe "normal"
    foreach ($uri in @($script:blobs.Keys)) {
        if ($uri.EndsWith("/terminal.json") -or $uri -like "*/audit-receipts/*" -or $uri -like "*/audit-logs/*" -or $uri -like "*/audit-status/*") { $script:blobs.Remove($uri) }
    }
    $interrupted = $script:blobs.Clone()
    $results.interrupted = @($first, (Invoke-Probe "normal" -Restart))
    $script:blobs = $interrupted.Clone()
    $results.terminalReadDenied = Invoke-Probe "terminalReadDenied" -Restart

    foreach ($name in @("startDenied", "resultsDenied", "graph401", "receiptDenied", "auditWriteDenied")) {
        $script:blobs.Clear()
        $results[$name] = Invoke-Probe $name
    }

    $script:scenario = "normal"
    $context = @{ TenantId = $env:TenuVaultTenantId; StorageAccount = $env:TenuVaultStorageAccount; StorageToken = "token" }
    $results.orphanReplay = Invoke-TvAuditReplay $context
    $results.orphanBlobs = $script:blobs.Clone()

    $script:blobs.Clear()
    $older = [DateTime]::UtcNow.AddHours(-5)
    $folder = "backup-$(ConvertTo-TvFolderTimestamp $older)"
    $run = "33333333-3333-3333-3333-333333333333"
    $start = @{ runId = $run; folder = $folder; startedAt = $older.ToString("o"); trigger = "manual"; principalId = "22222222-2222-2222-2222-222222222222" }
    $script:blobs["$script:resultBase/audit-runs/$env:TenuVaultTenantId/$run/start.json"] = $start | ConvertTo-Json -Compress
    $script:calls.Clear()
    $results.agedStart = @{ replay = Invoke-TvAuditReplay $context; blobs = $script:blobs.Clone(); calls = $script:calls.ToArray(); start = $start }

    $results.identity = @{ token = $identityToken; calls = $script:identityCalls }
    $script:scenario = "transportDown"
    $script:calls.Clear()
    $context.AuditBudget = @{ Clock = [System.Diagnostics.Stopwatch]::StartNew(); Seconds = 1; Requests = 1 }
    try { [void](Invoke-TvAuditStorage $context "audit-logs" "/test.json") } catch { }
    $context.Remove("AuditBudget")
    $budgetedCalls = $script:calls.Count
    try { [void](Invoke-TvHttp -Uri "https://stcontoso.blob.core.windows.net/audit-logs/test.json" -Token "token") } catch { }
    $results.transport = @{ budgeted = $budgetedCalls; unbudgeted = ($script:calls.Count - $budgetedCalls) }

    foreach ($name in @("page429", "page503", "pageCancelled")) {
        $script:blobs.Clear()
        $results[$name] = Invoke-Probe $name
    }
}
[Console]::WriteLine(($results | ConvertTo-Json -Compress -Depth 10))
