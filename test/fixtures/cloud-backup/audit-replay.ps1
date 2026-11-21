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
$script:calls = [System.Collections.Generic.List[object]]::new()
function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes)
    $script:calls.Add(@{ uri = $Uri; method = $Method; condition = $Headers["If-None-Match"] })
    if ($Uri -like "*comp=list*") {
        $names = @($script:blobs.Keys | Where-Object { $_ -like "*/audit-receipts/$tenantId/*" } | ForEach-Object { ([uri]$_).AbsolutePath.Substring("/tenuvault-backup-results/".Length) })
        $xml = ($names | ForEach-Object { "<Blob><Name>$_</Name></Blob>" }) -join ""
        return @{ Text = "<EnumerationResults><Blobs>$xml</Blobs><NextMarker /></EnumerationResults>" }
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
$script:denied = $false
$replay = Invoke-TvAuditReplay $context
$replayAgain = Invoke-TvAuditReplay $context
[Console]::WriteLine((@{
    blobs = $script:blobs; calls = $script:calls; pending = $pending
    replay = $replay; replayAgain = $replayAgain; output = @($output | ForEach-Object { [string]$_ })
} | ConvertTo-Json -Compress -Depth 8))
