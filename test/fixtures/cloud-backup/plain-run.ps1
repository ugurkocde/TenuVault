<#
.SYNOPSIS
    Runs Invoke-TvBackup from the cloud backup runbook against mocked tokens, Graph and storage,
    and writes one JSON line per scenario with every HTTP call the run made.
#>
[CmdletBinding()]
param([string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultBackup.ps1"
}
. $RunbookPath -LibraryOnly

[Environment]::SetEnvironmentVariable("TenuVaultTenantId", "11111111-2222-3333-4444-555555555555")
[Environment]::SetEnvironmentVariable("TenuVaultStorageAccount", "stcontoso")
# A setup from before 1.2.0 still has this variable; the runbook must not read the vault it names.
[Environment]::SetEnvironmentVariable("TenuVaultKeyVault", "kv-tenuvault-abc123")

$script:calls = [System.Collections.Generic.List[object]]::new()
$script:failGraphToken = $false
$script:failDetail = $false
$script:timeoutDetail = $false
$script:secondListPage = $null
$script:failReportList = $false
$script:failCompliance = $false
$script:maskOma = $false
$script:failAuditReceipt = $false

function Get-TvManagedIdentityToken {
    param([string]$Resource)
    $script:calls.Add([pscustomobject]@{ uri = "token:$Resource"; method = "Token"; contentType = $null; ifNoneMatch = $null; body = $null })
    if ($script:failGraphToken -and $Resource -like "https://graph.microsoft.com*") { throw "Could not get a managed identity token for $Resource." }
    return "token"
}

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes = 0)
    if ($script:failReportList -and $Uri -like "*/intune-backups?*comp=list*") { throw [InvalidOperationException]::new("storage listing is unavailable") }
    if ($script:failCompliance -and $Uri -like "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies*") { throw [TvHttpError]::new(500, "HTTP 500") }
    $body = if ($null -ne $BodyBytes) { [Text.Encoding]::UTF8.GetString($BodyBytes) } else { $null }
    $script:calls.Add([pscustomobject]@{ uri = $Uri; method = $Method; contentType = $ContentType; ifNoneMatch = $Headers["If-None-Match"]; body = $body })
    if ($script:failAuditReceipt -and $Uri -like "*/tenuvault-backup-results/audit-receipts/*") { throw [TvHttpError]::new(403, "Audit receipt denied") }
    $text = '{"value":[]}'
    if ($Uri -like "*/tenuvault-backup-results?*comp=list*") {
        $text = "<EnumerationResults><Blobs /><NextMarker /></EnumerationResults>"
    } elseif (($Uri -like "*/tenuvault-backup-results/audit-*/*" -or $Uri -like "*/intune-backups/cloud-backup-status-*") -and $Method -eq "Get") {
        throw [TvHttpError]::new(404, "HTTP 404")
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations") {
        $text = '{"value":[{"id":"cfg-1","displayName":"Baseline Wi-Fi"}]}'
        if ($null -ne $script:secondListPage) {
            $text = '{"value":[],"@odata.nextLink":"https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?page=2"}'
        }
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?page=2") {
        $text = $script:secondListPage
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeviceIdentities") {
        # A list-only type: the entry is the snapshot, with status fields and secrets left out.
        $text = '{"value":[{"id":"ap-1","serialNumber":"SN-0001","manufacturer":"Contoso","model":"Laptop 7","groupTag":"Sales","displayName":null,"userPrincipalName":"","lastContactedDateTime":"2026-11-01T10:00:00Z","enrollmentState":"enrolled","deviceAccountPassword":"secret","productKey":"PK-1","managedDeviceId":"md-1"}]}'
    } elseif ($Uri -like "*getOmaSettingPlainTextValue*") {
        throw [TvHttpError]::new(403, "No access to plaintext")
    } elseif ($Uri -like "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/cfg-1*") {
        if ($script:timeoutDetail) { throw [TimeoutException]::new("Detail call timed out") }
        if ($script:failDetail) { throw [TvHttpError]::new(401, "HTTP 401") }
        $text = '{"@odata.context":"x","id":"cfg-1","displayName":"Baseline Wi-Fi","lastModifiedDateTime":"2026-11-01T10:00:00Z","assignments":[]}'
        if ($script:maskOma -and $Uri -match "/cfg-1(?:\?|$)") {
            $text = '{"id":"cfg-1","displayName":"Baseline Wi-Fi","omaSettings":[{"@odata.type":"#microsoft.graph.omaSettingString","isEncrypted":true,"value":"****","secretReferenceValueId":"sample"}],"assignments":[]}'
        }
    }
    return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text }
}

# 1. A successful run.
$output = @(Invoke-TvBackup)
$baselineCalls = $script:calls.ToArray()
$baselineManifestWrite = $baselineCalls | Where-Object { $_.method -eq "Put" -and $_.uri -like "*/metadata.json" }
Write-Output (@{ calls = @($script:calls.ToArray()); output = $output } | ConvertTo-Json -Compress -Depth 5)

# 2. The Graph token fails: the run still records its status and leaves a note.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:failGraphToken = $true
$errorText = $null
try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 3. The run claims its folder, then Graph refuses: it records a failed manifest.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:failGraphToken = $false
$script:failDetail = $true
$errorText = $null
try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 4. Change reports on, and the report step meets an unexpected storage error: the backup still
#    succeeds and the job output says why there is no report.
[Environment]::SetEnvironmentVariable("TenuVaultChangeReport", "names")
$script:calls.Clear()
$script:OutcomeSent = $false
$script:failDetail = $false
$script:failReportList = $true
$errorText = $null
$output = @()
try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); output = @($output | ForEach-Object { [string]$_ }); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 5. Change reports on and a backup with warnings: no report, and the job output says so.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:failReportList = $false
$script:failCompliance = $true
$errorText = $null
$output = @()
try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
[Environment]::SetEnvironmentVariable("TenuVaultChangeReport", $null)
Write-Output (@{ calls = @($script:calls.ToArray()); output = @($output | ForEach-Object { [string]$_ }); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 6. and 7. Started by hand with TRIGGER Manual, and with a value that is neither Manual nor
#    Scheduled: the backup records manual, or scheduled with a warning line in the job output.
foreach ($value in @("Manual", "Nightly")) {
    $script:calls.Clear()
    $script:OutcomeSent = $false
    $script:failCompliance = $false
    $Trigger = $value
    $errorText = $null
    $output = @()
    try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
    Write-Output (@{ calls = @($script:calls.ToArray()); output = @($output | ForEach-Object { [string]$_ }); error = $errorText } | ConvertTo-Json -Compress -Depth 5)
}

# 8. A readable profile with a secret whose plaintext is refused.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:maskOma = $true
[Environment]::SetEnvironmentVariable("TenuVaultChangeReport", "names")
$Trigger = "Manual"
$errorText = $null
$output = @()
try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); output = @($output | ForEach-Object { [string]$_ }); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 9. A successful backup still checks for an earlier backup for its report when the audit receipt is denied.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:maskOma = $false
$script:failAuditReceipt = $true
[Environment]::SetEnvironmentVariable("TenuVaultChangeReport", "names")
$errorText = $null
$output = [System.Collections.Generic.List[string]]::new()
try { Invoke-TvBackup 2>&1 | ForEach-Object { $output.Add([string]$_) } } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); output = $output.ToArray(); error = $errorText } | ConvertTo-Json -Compress -Depth 5)

# 10. A detail read times out. 11 through 15. Lists with malformed or empty final pages.
# Compare the actual manifests from each capture.
$script:failAuditReceipt = $false
[Environment]::SetEnvironmentVariable("TenuVaultChangeReport", $null)
$before = ConvertFrom-TvJson $baselineManifestWrite.body
$older = @{ Name = "older"; Metadata = $before }
foreach ($page in @($null, '{}', '{"value":null}', '{"value":{"id":"cfg-2"}}', '{"value":[],"@odata.nextLink":false}', '{"value":[]}')) {
    $script:calls.Clear()
    $script:OutcomeSent = $false
    $script:timeoutDetail = $null -eq $page
    $script:secondListPage = $page
    $output = @(Invoke-TvBackup)
    $newerWrite = $script:calls | Where-Object { $_.method -eq "Put" -and $_.uri -like "*/metadata.json" }
    $newer = @{ Name = "newer"; Metadata = ConvertFrom-TvJson $newerWrite.body }
    $compared = Get-TvBackupDrifts -Older $older -Newer $newer -Types (Get-TvTypes) -ReadItem {
        param($backup, $file)
        $root = if ($backup -eq "older") { $baselineManifestWrite.uri } else { $newerWrite.uri }
        $escapedFile = ($file.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        $uri = $root -replace 'metadata.json$', $escapedFile
        $reads = if ($backup -eq "older") { $baselineCalls } else { $script:calls }
        $write = $reads | Where-Object { $_.method -eq "Put" -and $_.uri -eq $uri }
        if ($write) { return ConvertFrom-TvJson $write.body }
        return $null
    }
    Write-Output (@{ calls = @($script:calls.ToArray()); output = $output; compared = $compared } | ConvertTo-Json -Compress -Depth 10)
}
