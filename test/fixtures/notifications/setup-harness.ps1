# Runs New-TenuVaultNotificationWatcher.ps1 against in-memory stand-ins for the Az cmdlets it
# calls, several times in a row, and prints the resulting schedules, links, variables and
# alerts.json after each run as one JSON line. The watcher tests read those lines to check
# schedule changes, removal and the alerts file without an Azure subscription.
param([Parameter(Mandatory)][string]$Scenario)

$ErrorActionPreference = "Stop"
$setup = Join-Path $PSScriptRoot "../../../resources/New-TenuVaultNotificationWatcher.ps1"
$tenant = "11111111-1111-1111-1111-111111111111"

$global:TvSchedules = [ordered]@{}
$global:TvLinks = [System.Collections.Generic.List[string]]::new()
$global:TvVariables = @{}
$global:TvBlobs = @{}
$global:TvBlobTypes = @{}
$global:TvNow = [DateTime]::UtcNow

function global:Get-Module { param([switch]$ListAvailable, [string]$Name) [pscustomobject]@{ Name = $Name } }
function global:Get-AzContext { [pscustomobject]@{ Subscription = [pscustomobject]@{ Name = "Lab"; Id = "sub" }; Tenant = [pscustomobject]@{ Id = $tenant }; Account = "admin" } }
function global:Set-AzContext { }
function global:Get-AzResourceGroup { [pscustomobject]@{ Location = "westeurope" } }
function global:Get-AzAutomationAccount { [pscustomobject]@{ AutomationAccountName = "aa" } }
function global:Get-AzResource { [pscustomobject]@{ Identity = [pscustomobject]@{ PrincipalId = "principal" }; ResourceId = "/aa" } }
function global:Get-AzStorageAccount { [pscustomobject]@{ StorageAccountName = "tvlab"; Id = "/sa" } }
function global:New-AzStorageContext { [pscustomobject]@{ Name = "context" } }
function global:Get-AzStorageContainer { [pscustomobject]@{ Name = "container" } }
function global:Get-AzRoleAssignment { param($ObjectId, $RoleDefinitionName, $Scope) [pscustomobject]@{ Scope = $Scope } }
function global:Import-AzAutomationRunbook { }
function global:Publish-AzAutomationRunbook { }
function global:Remove-AzAutomationRunbook { }
function global:Get-AzAutomationRunbook { [pscustomobject]@{ Name = "runbook" } }

function global:Get-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name) if ($global:TvVariables.ContainsKey($Name)) { [pscustomobject]@{ Name = $Name } } }
function global:Set-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, [switch]$Encrypted, $Value) $global:TvVariables[$Name] = [string]$Value }
function global:New-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, [switch]$Encrypted, $Value) $global:TvVariables[$Name] = [string]$Value }
function global:Remove-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name) $global:TvVariables.Remove($Name) }

function global:Set-AzStorageBlobContent {
    param($File, $Container, $Blob, $Context, [hashtable]$Properties, [switch]$Force)
    $global:TvBlobs["$Container/$Blob"] = [IO.File]::ReadAllText($File, [Text.Encoding]::UTF8)
    $global:TvBlobTypes["$Container/$Blob"] = $Properties.ContentType
}
function global:Get-AzStorageBlob {
    param($Container, $Blob, $Context)
    if ($global:TvBlobForbidden) { Write-Error "This request is not authorized to perform this operation using this permission." ; return }
    if ($global:TvBlobs.ContainsKey("$Container/$Blob")) { return [pscustomobject]@{ Name = $Blob } }
    Write-Error "The specified blob does not exist."
}
function global:Remove-AzStorageBlob { param($Container, $Blob, $Context, [switch]$Force) $global:TvBlobs.Remove("$Container/$Blob") }

function global:Get-AzAutomationSchedule {
    param($ResourceGroupName, $AutomationAccountName, $Name)
    if ($Name) { if ($global:TvSchedules.Contains($Name)) { return $global:TvSchedules[$Name] } else { Write-Error "Schedule $Name not found." } }
    else { return @($global:TvSchedules.Values) }
}
function global:New-AzAutomationSchedule {
    param($ResourceGroupName, $AutomationAccountName, $Name, [DateTime]$StartTime, [int]$HourInterval, $TimeZone)
    if ($StartTime -lt $global:TvNow.AddMinutes(5)) { throw "The start time of the schedule must be at least 5 minutes after the time you create the schedule." }
    if ($global:TvSchedules.Contains($Name)) { throw "A schedule named $Name already exists." }
    $schedule = [pscustomobject]@{ Name = $Name; Frequency = "Hour"; Interval = $HourInterval; StartTime = [DateTimeOffset]::new([DateTime]::SpecifyKind($StartTime, [DateTimeKind]::Utc)) }
    $global:TvSchedules[$Name] = $schedule
    return $schedule
}
function global:Remove-AzAutomationSchedule {
    param($ResourceGroupName, $AutomationAccountName, $Name, [switch]$Force)
    if ($global:TvLinks.Contains($Name)) { throw "Schedule $Name is still linked." }
    $global:TvSchedules.Remove($Name)
}
function global:Get-AzAutomationScheduledRunbook {
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName)
    if ($global:TvLinks.Contains($ScheduleName)) { return [pscustomobject]@{ ScheduleName = $ScheduleName } }
    throw "No link to $ScheduleName."
}
function global:Register-AzAutomationScheduledRunbook {
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName)
    if (-not $global:TvSchedules.Contains($ScheduleName)) { throw "Schedule $ScheduleName does not exist." }
    $global:TvLinks.Add($ScheduleName)
}
function global:Unregister-AzAutomationScheduledRunbook {
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName, [switch]$Force)
    if (-not $global:TvLinks.Remove($ScheduleName)) { throw "No link to $ScheduleName." }
}

function Invoke-Setup {
    param([hashtable]$Extra = @{})
    $params = @{ TenantId = $tenant; StorageAccountName = "tvlab"; NoFailureAlert = $true } + $Extra
    & $setup @params 6>$null | Out-Null
    $schedules = @($global:TvSchedules.Values | ForEach-Object {
        [ordered]@{ name = $_.Name; interval = $_.Interval; minute = $_.StartTime.UtcDateTime.Minute; linked = $global:TvLinks.Contains($_.Name); startsInMinutes = [Math]::Round(($_.StartTime.UtcDateTime - [DateTime]::UtcNow).TotalMinutes, 1) }
    })
    $state = [ordered]@{
        schedules = $schedules
        links = @($global:TvLinks)
        alertRulesVariable = $global:TvVariables["TenuVaultAlertRules"]
        alertsBlob = $global:TvBlobs["tenuvault-notification-state/alerts.json"]
        alertsBlobType = $global:TvBlobTypes["tenuvault-notification-state/alerts.json"]
    }
    Write-Output (ConvertTo-Json $state -Depth 6 -Compress)
}

function Invoke-Failing {
    param([hashtable]$Extra)
    try { Invoke-Setup $Extra | Out-Null; Write-Output '{"error":null}' }
    catch { Write-Output (ConvertTo-Json @{ error = $_.Exception.Message } -Compress) }
}

$alertsPath = Join-Path ([IO.Path]::GetTempPath()) ("tv-alerts-" + [Guid]::NewGuid().ToString("N") + ".json")
$alertsText = '{"schema":"tenuvault.watcher-alerts/v1","alerts":[{"id":"a1","title":"Compliance","eventTypes":["intune.change"],"minSeverity":"info","destinations":["teams"],"delivery":"each","conditions":{"changeTypes":[],"categories":[],"policyNames":["Windows 11 - Compliance"],"policyNameMatch":"exact","settingNames":[],"excludeActors":[]}}]}'
[IO.File]::WriteAllText($alertsPath, $alertsText, [Text.UTF8Encoding]::new($false))

try {
    switch ($Scenario) {
        "schedules" {
            # A schedule of someone else with a similar name is never touched.
            $global:TvSchedules["TenuVaultNotificationCheck-7"] = [pscustomobject]@{ Name = "TenuVaultNotificationCheck-7"; Frequency = "Hour"; Interval = 1; StartTime = [DateTimeOffset]::UtcNow.AddHours(1) }
            Invoke-Setup
            Invoke-Setup @{ ScheduleIntervalMinutes = 15 }
            Invoke-Setup @{ ScheduleIntervalMinutes = 15 }
            Invoke-Setup @{ ScheduleIntervalMinutes = 30 }
            Invoke-Setup
            Invoke-Setup @{ ScheduleIntervalHours = 4 }
            Invoke-Setup @{ ScheduleIntervalMinutes = 20 }
            Invoke-Setup @{ Remove = $true }
        }
        "conflict" {
            Invoke-Failing @{ ScheduleIntervalMinutes = 15; ScheduleIntervalHours = 2 }
        }
        "alerts" {
            $global:TvVariables["TenuVaultAlertRules"] = '{"schema":"tenuvault.watcher-alerts/v1","alerts":[]}'
            Invoke-Setup
            Invoke-Setup @{ AlertRulesPath = $alertsPath }
            Invoke-Setup
            Invoke-Setup @{ AlertRulesPath = "" }
        }
        "forbidden" {
            Invoke-Setup @{ AlertRulesPath = $alertsPath } | Out-Null
            $global:TvBlobForbidden = $true
            Invoke-Failing @{ AlertRulesPath = "" }
            Write-Output (ConvertTo-Json @{ kept = $global:TvBlobs.ContainsKey("tenuvault-notification-state/alerts.json") } -Compress)
        }
        default { throw "Unknown scenario $Scenario" }
    }
} finally {
    Remove-Item -LiteralPath $alertsPath -Force -ErrorAction SilentlyContinue
}
