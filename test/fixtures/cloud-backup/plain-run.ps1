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
$script:failReportList = $false
$script:failCompliance = $false
$script:omit = $false
$script:policyMissing = $false
$script:failOmittedRead = $false
$script:changeDuringCapture = $false
$script:control = $null
$script:etag = 0

function Get-TvManagedIdentityToken {
    param([string]$Resource)
    $script:calls.Add([pscustomobject]@{ uri = "token:$Resource"; method = "Token"; contentType = $null; ifNoneMatch = $null; body = $null })
    if ($script:failGraphToken -and $Resource -like "https://graph.microsoft.com*") { throw "Could not get a managed identity token for $Resource." }
    return "token"
}

function Invoke-TvHttp {
    param([string]$Uri, [string]$Token, [string]$Method = "Get", [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType, [long]$MaxBytes = 0, [DateTime]$DispatchDeadline)
    if ($script:failReportList -and $Uri -like "*comp=list*") { throw [InvalidOperationException]::new("storage listing is unavailable") }
    if ($script:failCompliance -and $Uri -like "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies*") { throw [TvHttpError]::new(500, "HTTP 500") }
    $body = if ($null -ne $BodyBytes) { [Text.Encoding]::UTF8.GetString($BodyBytes) } else { $null }
    $script:calls.Add([pscustomobject]@{ uri = $Uri; method = $Method; contentType = $ContentType; ifNoneMatch = $Headers["If-None-Match"]; ifMatch = $Headers["If-Match"]; body = $body })
    if ($Uri -like "*/.tenuvault-control/*") {
        if ($Uri.EndsWith("secret-omission.json")) {
            if ($Method -eq "Put") {
                if (($null -ne $script:control -and $Headers["If-None-Match"] -eq "*") -or
                    ($Headers["If-Match"] -and $Headers["If-Match"] -ne [string]$script:etag)) { throw [TvHttpError]::new(412, "HTTP 412") }
                $script:control = $body
                $script:etag++
                return @{ Status = 201 }
            }
            if ($null -eq $script:control) { throw [TvHttpError]::new(404, "HTTP 404") }
            $text = $script:control
        } else {
            if (-not $script:omit) { throw [TvHttpError]::new(404, "HTTP 404") }
            $text = '{}'
        }
        return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text; ETag = [string]$script:etag }
    }
    $text = '{"value":[]}'
    if ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations") {
        $text = '{"value":[{"id":"cfg-1","displayName":"Baseline Wi-Fi"}]}'
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeviceIdentities") {
        # A list-only type: the entry is the snapshot, with status fields and secrets left out.
        $text = '{"value":[{"id":"ap-1","serialNumber":"SN-0001","manufacturer":"Contoso","model":"Laptop 7","groupTag":"Sales","displayName":null,"userPrincipalName":"","lastContactedDateTime":"2026-11-01T10:00:00Z","enrollmentState":"enrolled","deviceAccountPassword":"secret","productKey":"PK-1","managedDeviceId":"md-1"}]}'
    } elseif ($Uri -like "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/cfg-1*") {
        if ($script:changeDuringCapture) {
            $script:control = '{"version":1,"tenantId":"11111111-2222-3333-4444-555555555555","generation":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","enabled":true,"scripts":false}'
            $script:etag++
        }
        if ($script:failDetail) { throw [TvHttpError]::new(401, "HTTP 401") }
        if ($script:failOmittedRead) { throw [TvHttpError]::new(400, "omission-test-value-397c6d") }
        $text = '{"@odata.context":"x","id":"cfg-1","displayName":"Baseline Wi-Fi","lastModifiedDateTime":"2026-11-01T10:00:00Z","assignments":[]}'
        if ($script:omit) {
            $text = '{"id":"cfg-1","displayName":"Baseline Wi-Fi","omaSettings":[{"@odata.type":"#microsoft.graph.omaSettingString","isEncrypted":true,"value":"omission-test-value-397c6d","secretReferenceValueId":"omission-test-secret-reference","omaUri":"./Secret"}],"settings":[{"@odata.type":"#microsoft.graph.deviceManagementConfigurationSecretSettingValue","value":"omission-test-value-397c6d"}]}'
        }
    }
    return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text }
}

# 1. A successful run.
$output = @(Invoke-TvBackup)
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


# Exercise the cloud producer with omission, a missing enrolled policy, and an error with an operand.
$script:omit = $true
foreach ($case in @("on", "missing", "graphError")) {
    $script:calls.Clear()
    $script:OutcomeSent = $false
    $script:control = if ($case -ne "missing") { '{"version":1,"tenantId":"11111111-2222-3333-4444-555555555555","generation":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","enabled":true,"scripts":false}' }
    $script:etag++
    $script:failOmittedRead = $case -eq "graphError"
    $errorText = $null
    $output = @()
    try { $output = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
    Write-Output (@{ calls = @($script:calls.ToArray()); output = @($output); error = $errorText } | ConvertTo-Json -Compress -Depth 5)
}


# Switch policy after the old producer starts to read snapshots, before it can publish.
$script:calls.Clear()
$script:OutcomeSent = $false
$script:omit = $false
$script:failOmittedRead = $false
$script:changeDuringCapture = $true
$script:control = $null
$errorText = $null
try { $null = @(Invoke-TvBackup) } catch { $errorText = $_.Exception.Message }
Write-Output (@{ calls = @($script:calls.ToArray()); error = $errorText } | ConvertTo-Json -Compress -Depth 5)
