param([switch]$Paged, [switch]$Budgeted, [switch]$Aged)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$tenantId = "11111111-2222-3333-4444-555555555555"
$principalId = "22222222-2222-2222-2222-222222222222"
$claims = @{ tid = $tenantId; oid = $principalId } | ConvertTo-Json -Compress
$token = "header.$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($claims)).TrimEnd('=').Replace('+', '-').Replace('/', '_')).tokenCanary"
$context = @{ TenantId = $tenantId; StorageAccount = "stcontoso"; StorageToken = $token; AuditPending = 0 }
$script:blobs = @{}
$script:loseAuditResponse = $true
$script:denied = $true
$script:syntheticPages = 0
$script:calls = [System.Collections.Generic.List[object]]::new()
function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes, [int]$BudgetMs)
    $script:calls.Add(@{ uri = $Uri; method = $Method; condition = $Headers["If-None-Match"] })
    if ($Uri -like "*comp=list*") {
        $prefix = [uri]::UnescapeDataString([regex]::Match($Uri, 'prefix=([^&]*)').Groups[1].Value)
        $marker = [uri]::UnescapeDataString([regex]::Match($Uri, 'marker=([^&]*)').Groups[1].Value)
        if ($Budgeted -and $prefix.EndsWith([DateTime]::UtcNow.ToString("yyyy-MM-dd") + "-")) {
            $script:syntheticPages++
            $page = if ($marker) { [int]$marker + 1 } else { 1 }
            $next = if ($page -lt 1400) { $page }
            return @{ Text = "<EnumerationResults><Blobs /><NextMarker>$next</NextMarker></EnumerationResults>" }
        }
        $names = @($script:blobs.Keys | Where-Object { $_ -like "*/tenuvault-backup-results/*" } | ForEach-Object { ([uri]$_).AbsolutePath.Substring("/tenuvault-backup-results/".Length) } |
            Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } | Sort-Object)
        if ($marker) { $names = @($names | Where-Object { [string]::CompareOrdinal($_, $marker) -gt 0 }) }
        $limit = if ($Paged) { 2 } else { 20 }
        $next = if ($names.Count -gt $limit) { $names[$limit - 1] } else { "" }
        $xml = ($names | Select-Object -First $limit | ForEach-Object { "<Blob><Name>$_</Name></Blob>" }) -join ""
        return @{ Text = "<EnumerationResults><Blobs>$xml</Blobs><NextMarker>$next</NextMarker></EnumerationResults>" }
    }
    if ($Method -eq "Put") {
        if ($Uri -like "*/audit-logs/*" -and $script:denied) { throw [TvHttpError]::new(403, "secretCanaryAclMessage") }
        if ($script:blobs.ContainsKey($Uri) -and $Headers["If-None-Match"] -eq "*") { throw [TvHttpError]::new(403, "create only") }
        $script:blobs[$Uri] = [Text.Encoding]::UTF8.GetString($BodyBytes)
        if ($Uri -like "*/audit-logs/*" -and $script:loseAuditResponse) {
            $script:loseAuditResponse = $false
            throw [TvHttpError]::new(0, "lost response")
        }
        return @{ Status = 201 }
    }
    if (-not $script:blobs.ContainsKey($Uri)) { throw [TvHttpError]::new(404, "missing") }
    return @{ Status = 200; Text = $script:blobs[$Uri] }
}
$runId = "33333333-3333-3333-3333-333333333333"
$output = @(Write-TvTerminalAudit $context $runId "CompletedWithWarnings" "backup-2026-11-20-120000" 10 1 "scheduled" "BACKUP_WARNINGS" 3>&1)
$pending = $context.AuditPending
if ($Budgeted -or $Aged) {
    $script:calls.Clear()
    $replay = Invoke-TvAuditReplay $context 3>$null
    $firstRequests = $script:calls.Count
    $script:calls.Clear()
    $replayAgain = if ($Aged) { Invoke-TvAuditReplay $context -Today ([DateTime]::UtcNow.Date.AddDays(15)) 3>$null }
        else { Invoke-TvAuditReplay $context 3>$null }
    if ($Aged) {
        $script:denied = $false
        $operator = Invoke-TvAuditReplay $context -Today ([DateTime]::UtcNow.Date.AddDays(15)) -IncludeOlder 3>$null
    }
} elseif ($Paged) {
    foreach ($number in 1..4) {
        $additional = "44444444-4444-4444-4444-44444444444$number"
        $file = New-TvAuditFile $context $additional "Success" "" 0 0 "scheduled"
        $script:blobs["https://stcontoso.blob.core.windows.net/tenuvault-backup-results/audit-receipts/$tenantId/$($file.date)-$additional.json"] =
            (@{ delivered = ($number -in @(1, 2)); file = $file } | ConvertTo-Json -Compress -Depth 12)
    }
    $old = [DateTime]::UtcNow.AddDays(-50).ToString("yyyy-MM-dd")
    $script:blobs["https://stcontoso.blob.core.windows.net/tenuvault-backup-results/audit-receipts/$tenantId/$old-55555555-5555-5555-5555-555555555555.json"] = '{"delivered":false}'
    $replay = Invoke-TvAuditReplay $context 3>$null
    $script:denied = $false
    $replayAgain = Invoke-TvAuditReplay $context
} else {
    $script:denied = $false
    $replay = Invoke-TvAuditReplay $context
    $replayAgain = Invoke-TvAuditReplay $context
}
[Console]::WriteLine((@{
    blobs = $script:blobs; calls = $script:calls; pending = $pending
    replay = $replay; replayAgain = $replayAgain; firstRequests = $firstRequests; operator = $operator; output = @($output | ForEach-Object { [string]$_ })
} | ConvertTo-Json -Compress -Depth 8))
