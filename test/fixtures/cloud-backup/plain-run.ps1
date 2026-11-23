<#
.SYNOPSIS
    Runs Invoke-TvBackup from the cloud backup runbook against mocked tokens, Graph and storage,
    and writes one JSON line per scenario with every HTTP call the run made.
#>
[CmdletBinding()]
param([string]$RunbookPath, [switch]$SecondaryCopyTests)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultBackup.ps1"
}
. $RunbookPath -LibraryOnly
$invokeRunbookHttp = ${function:Invoke-TvHttp}

[Environment]::SetEnvironmentVariable("TenuVaultTenantId", "11111111-2222-3333-4444-555555555555")
[Environment]::SetEnvironmentVariable("TenuVaultStorageAccount", "stcontoso")
# A setup from before 1.2.0 still has this variable; the runbook must not read the vault it names.
[Environment]::SetEnvironmentVariable("TenuVaultKeyVault", "kv-tenuvault-abc123")

$script:calls = [System.Collections.Generic.List[object]]::new()
$script:failGraphToken = $false
$script:failDetail = $false
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
    if ($SecondaryCopyTests -and $Uri -like "*.blob.core.windows.net/*") {
        $targetUri = [uri]$Uri
        if ($Method -eq "Put" -and $targetUri.AbsolutePath -match "/backup-") {
            if ($Headers["x-ms-copy-source"]) {
                if ($Token -ne "token" -or $Headers["x-ms-copy-source-authorization"] -ne "Bearer token" -or
                    $Headers["x-ms-source-if-match"] -ne '"0x8D9126CC8255C5D"' -or $Headers["If-None-Match"] -ne "*" -or $BodyBytes.Length -ne 0) {
                    throw "Unexpected copy authentication or conditions."
                }
                if ($script:copyScenario -eq "denied" -and $targetUri.AbsolutePath -like "*/Baseline*") {
                    throw [TvHttpError]::new(403, "HTTP 403 AuthorizationPermissionMismatch")
                }
                if ($script:copyScenario -eq "manifest-denied" -and $targetUri.AbsolutePath -like "*/metadata.json") {
                    throw [TvHttpError]::new(403, "HTTP 403 AuthorizationPermissionMismatch")
                }
                $length = $script:backupBlobs[$Headers["x-ms-copy-source"]]
                if ($script:copyScenario -eq "wrong-size" -and $targetUri.AbsolutePath -like "*/Baseline*") { $length++ }
                $script:backupBlobs[$Uri] = $length
                if ($script:copyScenario -eq "data-retry" -and $targetUri.AbsolutePath -like "*/Baseline*") {
                    # The service committed the blob before reporting a retryable error. Run the
                    # real HTTP retry code, with Azure rejecting the retried create-only request.
                    return & $invokeRunbookHttp @PSBoundParameters
                }
                return @{ Status = 201 }
            }
            $script:backupBlobs[$Uri] = $BodyBytes.Length
        } elseif ($targetUri.Query -like "*comp=list&prefix=*") {
            $container = $targetUri.GetLeftPart([UriPartial]::Path) + "/"
            $prefix = [uri]::UnescapeDataString(($targetUri.Query -split "prefix=")[1].Split("&")[0])
            $matching = @($script:backupBlobs.Keys | Where-Object { $_.StartsWith($container + $prefix) } | Sort-Object)
            $next = ""
            if ($targetUri.Query -like "*&marker=page%2B2*") {
                $matching = @($matching | Select-Object -Skip 1)
            } elseif ($matching.Count -gt 1) {
                $matching = @($matching[0])
                $next = "page+2"
            }
            $blobs = foreach ($key in $matching) {
                $name = [Security.SecurityElement]::Escape([uri]::UnescapeDataString($key.Substring($container.Length)))
                "<Blob><Name>$name</Name><Properties><Content-Length>$($script:backupBlobs[$key])</Content-Length><Etag>0x8D9126CC8255C5D</Etag></Properties></Blob>"
            }
            return @{ Status = 200; Text = "<EnumerationResults><Blobs>$blobs</Blobs><NextMarker>$next</NextMarker></EnumerationResults>" }
        }
    }
    if ($script:failAuditReceipt -and $Uri -like "*/tenuvault-backup-results/audit-receipts/*") { throw [TvHttpError]::new(403, "Audit receipt denied") }
    $text = '{"value":[]}'
    if ($Uri -like "*/tenuvault-backup-results?*comp=list*") {
        $text = "<EnumerationResults><Blobs /><NextMarker /></EnumerationResults>"
    } elseif (($Uri -like "*/tenuvault-backup-results/audit-*/*" -or $Uri -like "*/intune-backups/cloud-backup-status-*") -and $Method -eq "Get") {
        throw [TvHttpError]::new(404, "HTTP 404")
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations") {
        $text = '{"value":[{"id":"cfg-1","displayName":"Baseline Wi-Fi"}]}'
    } elseif ($Uri -eq "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeviceIdentities") {
        # A list-only type: the entry is the snapshot, with status fields and secrets left out.
        $text = '{"value":[{"id":"ap-1","serialNumber":"SN-0001","manufacturer":"Contoso","model":"Laptop 7","groupTag":"Sales","displayName":null,"userPrincipalName":"","lastContactedDateTime":"2026-11-01T10:00:00Z","enrollmentState":"enrolled","deviceAccountPassword":"secret","productKey":"PK-1","managedDeviceId":"md-1"}]}'
    } elseif ($Uri -like "*getOmaSettingPlainTextValue*") {
        throw [TvHttpError]::new(403, "No access to plaintext")
    } elseif ($Uri -like "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/cfg-1*") {
        if ($script:failDetail) { throw [TvHttpError]::new(401, "HTTP 401") }
        $text = '{"@odata.context":"x","id":"cfg-1","displayName":"Baseline Wi-Fi","lastModifiedDateTime":"2026-11-01T10:00:00Z","assignments":[]}'
        if ($script:maskOma -and $Uri -match "/cfg-1(?:\?|$)") {
            $text = '{"id":"cfg-1","displayName":"Baseline Wi-Fi","omaSettings":[{"@odata.type":"#microsoft.graph.omaSettingString","isEncrypted":true,"value":"****","secretReferenceValueId":"sample"}],"assignments":[]}'
        }
    }
    return @{ Status = 200; Bytes = [Text.Encoding]::UTF8.GetBytes($text); Text = $text }
}

if ($SecondaryCopyTests) {
    $secondaryId = "/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rg-copy/providers/Microsoft.Storage/storageAccounts/stcontosorecovery/blobServices/default/containers/backup-copies"
    $script:CopyHttpClient = [pscustomobject]@{ Attempts = 0 }
    $script:CopyHttpClient | Add-Member -MemberType ScriptMethod -Name SendAsync -Value {
        $this.Attempts++
        $status = if ($this.Attempts -eq 1) { 503 } else { 412 }
        $response = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$status)
        if ($status -eq 412) {
            $response.Content = [System.Net.Http.StringContent]::new("<Error><Code>ConditionNotMet</Code></Error>")
        }
        $task = [System.Threading.Tasks.TaskCompletionSource[System.Net.Http.HttpResponseMessage]]::new()
        $task.SetResult($response)
        return $task.Task
    }
    foreach ($scenario in "verified", "denied", "wrong-size", "primary-warnings", "data-retry", "manifest-denied", "malformed", "off") {
        $target = switch ($scenario) {
            "malformed" { $secondaryId.Replace("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ("-" * 36)) }
            "off" { "off" }
            default { $secondaryId }
        }
        [Environment]::SetEnvironmentVariable("TenuVaultSecondaryStorage", $target)
        $script:copyScenario = $scenario
        $script:CopyHttpClient.Attempts = 0
        $script:backupBlobs = @{}
        $script:calls.Clear()
        $script:OutcomeSent = $false
        $script:failCompliance = $scenario -eq "primary-warnings"
        $errorText = $null
        $output = @()
        try { $output = @(Invoke-TvBackup 3>&1) } catch { $errorText = $_.Exception.Message }
        @{ scenario = $scenario; calls = @($script:calls.ToArray()); error = $errorText; copyAttempts = $script:CopyHttpClient.Attempts
           output = @($output | ForEach-Object { [string]$_ }) } | ConvertTo-Json -Compress -Depth 5
    }
    return
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
