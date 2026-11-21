<#
.SYNOPSIS
    Runs the upgrade step and the -Remove step of New-TenuVaultCloudBackup.ps1 on a setup from
    before runbook 1.2.0, against mocked Az cmdlets that keep the runbook's draft and published
    content, and writes one JSON line per scenario.
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$SetupPath, [switch]$RbacQuota, [switch]$AuditRoleOnly)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
if (-not $SetupPath) { $SetupPath = Join-Path $repoRoot "resources/New-TenuVaultCloudBackup.ps1" }

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "The setup script does not parse." }
# The script's own functions, defined here without running the script.
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
# The script's own upgrade step, from the runbook import to the failure alert, run as written.
$text = $ast.Extent.Text
$start = $text.IndexOf("# Runbook import and publish")
$end = $text.IndexOf("# Failure alert")
if ($start -lt 0 -or $end -le $start) { throw "The upgrade step markers were not found." }
$upgradeStep = [scriptblock]::Create($text.Substring($start, $end - $start))
$scheduleStart = $text.IndexOf('# Schedule and link.')
$scheduleEnd = $text.IndexOf('# Summary and next steps.')
$scheduleParameters = @'
[CmdletBinding(SupportsShouldProcess)]
param([string]$Time = "02:00", [switch]$GraphRolesGranted)
'@
$scheduleStep = [scriptblock]::Create($scheduleParameters + "`n" + $text.Substring($scheduleStart, $scheduleEnd - $scheduleStart))

$ResourceGroupName = "rg-tenuvault-backups"
$AutomationAccountName = "aa-tenuvault"
$runbookName = "Invoke-TenuVaultBackup"
$runbookPath = Join-Path (Split-Path -Parent $SetupPath) "runbooks/Invoke-TenuVaultBackup.ps1"
$TenantId = "11111111-2222-3333-4444-555555555555"
$tenantKey = "11111111"
$scheduleName = "TenuVaultBackup-$tenantKey"
$StorageAccountName = "stcontoso"
$Scope = "policies"
$ExcludedFolders = ""
$appOnlyExcluded = "DeviceCategories,DeviceCleanupRules"
$graphRoleNames = @("DeviceManagementConfiguration.Read.All")
$ChangeReport = "Off"
$ChangeReportWithoutActors = $false
$TenantName = ""
# Whether the setup command passed -ChangeReport and -ChangeReportWithoutActors.
$changeReportPassed = $false
$changeReportActorsPassed = $false
$tenantNamePassed = $false
$variableNames = @(
    "TenuVaultTenantId-$tenantKey", "TenuVaultStorageAccount-$tenantKey",
    "TenuVaultScope-$tenantKey", "TenuVaultExcludedFolders-$tenantKey", "TenuVaultAppOnlyExcluded-$tenantKey",
    "TenuVaultChangeReport-$tenantKey", "TenuVaultChangeReportActors-$tenantKey", "TenuVaultTenantName-$tenantKey"
)
$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"
$plainRunbookVersion = "1.2.0"
$triggerRunbookVersion = "1.4.0"
$auditContainer = "audit-logs"
$writerRoleName = "TenuVault Backup Writer"
$backupContainer = "intune-backups"
$storageGroupScope = "/subscriptions/demo/resourceGroups/$ResourceGroupName"
$storageAccount = @{ Id = "$storageGroupScope/providers/Microsoft.Storage/storageAccounts/$StorageAccountName" }
$storageContext = @{}
$principalId = "00000000-0000-0000-0000-00000000aaaa"
$TimeZone = "UTC"
$Frequency = "Daily"
$WeekDay = [DayOfWeek]::Sunday
$oldRunbook = '$script:RunbookVersion = "1.1.0"'

# Az.Automation reports a missing resource as this exception type, written as a non-terminating error.
class ResourceNotFoundException : System.Exception {
    ResourceNotFoundException([string]$message) : base($message) { }
}
function Write-MockError {
    param([Parameter(Mandatory)]$Cmdlet, [Parameter(Mandatory)][System.Exception]$Exception)
    $Cmdlet.WriteError([System.Management.Automation.ErrorRecord]::new($Exception, "MockError", "NotSpecified", $null))
}
# Any lookup error that is not "not found": Azure did not answer, or refused the read.
function New-OutageException { [System.Net.Http.HttpRequestException]::new("The SSL connection could not be established.") }

# Mocked Azure state.
$script:variables = @{}
$script:actions = [System.Collections.Generic.List[string]]::new()
$script:variableWrites = [System.Collections.Generic.List[string]]::new()
$script:draft = $null
$script:published = $null
$script:schedule = $false
$script:link = $false
$script:declineImport = $false
$script:publishBehavior = "publish"
$script:declineVariable = $null
$script:failLookups = $false
$script:failList = $false
$script:failNextList = $false
$script:translatedVariable = $null

function Import-AzAutomationRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, $Path, $Type, $Description, [switch]$Force)
    $script:actions.Add("import confirm=$(if ($PSBoundParameters.ContainsKey('Confirm')) { [bool]$PSBoundParameters['Confirm'] } else { 'unset' })")
    # The cmdlet asks for its own confirmation; a declined one imports nothing.
    if ($script:declineImport) { return }
    $script:draft = Get-Content -Raw -Path $Path
}
function Publish-AzAutomationRunbook {
    param($ResourceGroupName, $AutomationAccountName, $Name)
    $script:actions.Add("publish")
    if ($script:publishBehavior -eq "throw") { throw "Publishing the runbook failed." }
    if ($script:publishBehavior -eq "nothing") { return }
    $script:published = $script:draft
}
function Export-AzAutomationRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, $Slot, $OutputFolder, [switch]$Force)
    $script:actions.Add("export $Slot")
    if ($null -eq $script:published) { throw "The runbook has no published content." }
    Set-Content -Path (Join-Path $OutputFolder "$Name.ps1") -Value $script:published
    return Get-Item -Path $OutputFolder
}
function Get-AzAutomationVariable {
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    if (-not $Name) {
        if ($script:failNextList) { $script:failNextList = $false; Write-MockError $PSCmdlet (New-OutageException); return }
        if ($script:failLookups -or $script:failList) { Write-MockError $PSCmdlet (New-OutageException); return }
        return @($script:variables.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $script:variables[$_] } })
    }
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    # AutomationPSClient.GetVariable turns every ErrorResponseException (403, 500) into "not found".
    if ($Name -eq $script:translatedVariable) { Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Variable $Name not found.")); return }
    if ($script:variables.ContainsKey($Name)) { return [pscustomobject]@{ Name = $Name; Value = $script:variables[$Name] } }
    Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Variable $Name not found."))
}
function Set-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variableWrites.Add($Name); $script:variables[$Name] = $Value }
function New-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variableWrites.Add($Name); $script:variables[$Name] = $Value }
function Remove-AzAutomationVariable {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    # A variable whose own confirmation the admin declines stays.
    if ($Name -eq $script:declineVariable) { $script:actions.Add("declined remove $Name"); return }
    $script:actions.Add("remove $Name")
    [void]$script:variables.Remove($Name)
}
function Get-AzResource {
    param($ResourceGroupName, $Name, $ResourceType, $ErrorAction)
    if ($ResourceType -eq "Microsoft.KeyVault/vaults") { return [pscustomobject]@{ Name = "kv-tenuvault-abc123" } }
    return [pscustomobject]@{ Identity = [pscustomobject]@{ PrincipalId = "00000000-0000-0000-0000-00000000aaaa" } }
}
function Get-AzAutomationAccount { param($ResourceGroupName, $Name, $ErrorAction) [pscustomobject]@{ AutomationAccountName = $Name } }
function Unregister-AzAutomationScheduledRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName, [switch]$Force)
    $script:actions.Add("unlink")
    $script:link = $false
}
function Get-AzAutomationScheduledRunbook {
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName)
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    if (-not $script:link) { Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Job schedule for $RunbookName and $ScheduleName not found.")); return }
    [pscustomobject]@{ RunbookName = $RunbookName; ScheduleName = $ScheduleName }
}
function Get-AzAutomationSchedule {
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    if ($script:schedule) {
        return $script:scheduleSettings
    }
    Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Schedule $Name not found."))
}
function Remove-AzAutomationSchedule {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, [switch]$Force)
    $script:actions.Add("remove schedule")
    $script:schedule = $false
}

function Set-AzAutomationSchedule {
    param($ResourceGroupName, $AutomationAccountName, $Name, [bool]$IsEnabled, $ErrorAction)
    $script:scheduleSettings.IsEnabled = $IsEnabled
    $script:actions.Add("schedule enabled=$IsEnabled")
}
function New-AzAutomationSchedule {
    param($ResourceGroupName, $AutomationAccountName, $Name, $StartTime, $TimeZone, $DayInterval, $WeekInterval, $DaysOfWeek)
    $script:schedule = $true
    $script:scheduleSettings = @{ Name = $Name; IsEnabled = $true; TimeZone = $TimeZone
        StartTime = $StartTime; Frequency = $(if ($WeekInterval) { "Week" } else { "Day" }); DaysOfWeek = @($DaysOfWeek) }
    $script:actions.Add("create schedule")
}
function Register-AzAutomationScheduledRunbook {
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName, $Parameters)
    $script:link = $true
    $script:actions.Add("link")
}
function Get-AzStorageContainer {
    param($Name, $Context, $ErrorAction)
    if ($Name -ne "audit-logs") { return @{ Name = $Name } }
}
function New-AzStorageContainer {
    param($Name, $Context, $Permission)
    if ($script:auditFailure -eq "container") { throw "Audit container creation denied" }
}
function Get-AzRoleDefinition {
    param($Name, $ErrorAction)
    if ($Name -eq $writerRoleName) {
        return @{ Id = "existing-writer-role"; AssignableScopes = @($storageGroupScope); Actions = @(); DataActions = @(
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"
        ) }
    }
}
function Get-AzRoleAssignment { param($ObjectId, $RoleDefinitionId, $Scope, $ErrorAction) }
function Add-MockedRoleAssignment([string]$Container) {
    $script:actions.Add("grant $Container")
    if ($script:roleSlots -le 0) { throw "RoleAssignmentLimitExceeded" }
    $script:roleSlots--
}
function New-AzRoleAssignment {
    param($ObjectId, $RoleDefinitionId, $Scope)
    Add-MockedRoleAssignment (($Scope -split "/")[-1])
}
function Invoke-AzRestMethod {
    param($Method, $Path, $Payload)
    if ($Method -eq "Get") { return @{ StatusCode = 200; Content = '{"value":[{"actions":["*"],"notActions":[]}]}' } }
    if ($Path -match '/roleDefinitions/' -and $script:auditFailure -eq "role-definition") { return @{ StatusCode = 403 } }
    if ($Path -match '/roleAssignments/' -and $script:auditFailure -eq "role-assignment") { return @{ StatusCode = 403 } }
    if ($RbacQuota -and $Path -match '/audit-logs/.*/roleAssignments/') { Add-MockedRoleAssignment "audit-logs" }
    return @{ StatusCode = 201 }
}

# A setup from before 1.2.0: its published runbook (and an older draft) read the vault through the variable.
function Reset-OldSetup {
    $script:variables = @{ $legacyKeyVaultVariable = "kv-tenuvault-abc123" }
    foreach ($name in $variableNames) { $script:variables[$name] = "x" }
    $script:variables["TenuVaultStorageAccount-$tenantKey"] = $StorageAccountName
    $script:actions.Clear()
    $script:variableWrites.Clear()
    $script:draft = $oldRunbook
    $script:published = $oldRunbook
    $script:schedule = $true
    $script:scheduleSettings = @{ Name = $scheduleName; IsEnabled = $true; TimeZone = "Europe/Berlin"
        StartTime = [DateTimeOffset]::Parse("2026-11-25T09:00:00+01:00"); Frequency = "Week"; DaysOfWeek = @("Wednesday") }
    $script:auditFailure = $null
    $script:link = $true
    $script:declineImport = $false
    $script:publishBehavior = "publish"
    $script:declineVariable = $null
    $script:failLookups = $false
    $script:failList = $false
    $script:translatedVariable = $null
}
# Tenant B (22222222) shares the Automation account and still has its vault variable.
function Add-TenantB { $script:variables["TenuVaultKeyVault-22222222"] = "kv-tenuvault-abc123" }

function Write-Scenario {
    param([string]$Name, [object]$Runbook, [object]$ErrorText, [object[]]$Output)
    Write-Output (@{
        scenario = $Name
        plain = if ($Runbook) { [bool]$Runbook.Plain } else { $false }
        reason = if ($Runbook) { $Runbook.Reason } else { $null }
        error = $ErrorText
        actions = @($script:actions.ToArray())
        legacyVariableKept = $script:variables.ContainsKey($legacyKeyVaultVariable)
        changeReport = $script:variables["TenuVaultChangeReport-$tenantKey"]
        changeReportActors = $script:variables["TenuVaultChangeReportActors-$tenantKey"]
        omissionBinding = $script:variables["TenuVaultOmissionAccount-$tenantKey"]
        storageAccount = $script:variables["TenuVaultStorageAccount-$tenantKey"]
        tenantName = $script:variables["TenuVaultTenantName-$tenantKey"]
        variables = @($script:variables.Keys | Sort-Object)
        variableWrites = $script:variableWrites.ToArray()
        scope = $script:variables["TenuVaultScope-$tenantKey"]
        exclusions = $script:variables["TenuVaultExcludedFolders-$tenantKey"]
        appOnlyExcluded = $script:variables["TenuVaultAppOnlyExcluded-$tenantKey"]
        schedule = $script:schedule
        enabled = $script:scheduleSettings.IsEnabled
        scheduleSettings = @{
            timeZone = $script:scheduleSettings.TimeZone
            frequency = $script:scheduleSettings.Frequency
            time = $script:scheduleSettings.StartTime.ToString("HH:mm")
            days = @($script:scheduleSettings.DaysOfWeek | ForEach-Object { [string]$_ })
        }
        link = $script:link
        output = @($Output | ForEach-Object { [string]$_ })
    } | ConvertTo-Json -Compress -Depth 5)
}

if ($RbacQuota) {
    # Run the full setup against a new tenant setup with just enough quota for main's grants.
    function Get-Module { param([switch]$ListAvailable, $Name) $true }
    function Get-AzContext { @{ Subscription = @{ Name = "Demo"; Id = "demo" }; Tenant = @{ Id = $TenantId } } }
    function Get-AzResourceGroup { param($Name, $ErrorAction) @{ Location = "westus" } }
    function Get-AzStorageAccount {
        param($ResourceGroupName, $Name, $ErrorAction)
        @{ Id = "/subscriptions/demo/resourceGroups/$ResourceGroupName/providers/Microsoft.Storage/storageAccounts/$Name" }
    }
    function New-AzStorageContext { param($StorageAccountName, [switch]$UseConnectedAccount) @{} }
    $script:roleSlots = 2
    $arguments = @{ TenantId = $TenantId; StorageAccountName = $StorageAccountName; GraphRolesGranted = $true; NoFailureAlert = $true }
    if ($AuditRoleOnly) { $arguments.AuditRoleOnly = $true }
    $output = @(. $SetupPath @arguments 3>&1 6>&1)
    @{ actions = @($script:actions); published = [bool]$script:published; schedule = $script:schedule; linked = $script:link
        output = @($output | ForEach-Object { [string]$_ }) } | ConvertTo-Json -Compress
    return
}

# Upgrade runs: approved, the outer step declined, the import's own prompt declined with an old
# draft present, the publish throwing, and a publish that leaves the older version published.
foreach ($scenario in "approved", "outer-declined", "import-declined", "publish-throws", "published-older", "upgrade-tenant-b-remains", "upgrade-list-fails", "upgrade-vault-read-translated") {
    Reset-OldSetup
    # The by-name read of the vault variable comes back as "not found" although the variable exists.
    if ($scenario -eq "upgrade-vault-read-translated") { $script:translatedVariable = $legacyKeyVaultVariable }
    if ($scenario -eq "upgrade-tenant-b-remains") { Add-TenantB }
    if ($scenario -eq "upgrade-list-fails") { $script:failList = $true }
    $PSDefaultParameterValues = @{}
    if ($scenario -eq "outer-declined") { $PSDefaultParameterValues["Publish-TenuVaultRunbook:WhatIf"] = $true }
    if ($scenario -eq "import-declined") { $script:declineImport = $true }
    if ($scenario -eq "publish-throws") { $script:publishBehavior = "throw" }
    if ($scenario -eq "published-older") { $script:publishBehavior = "nothing" }
    $runbook = $null
    $errorText = $null
    $output = @()
    try {
        $output = @(. $upgradeStep 3>&1 6>&1)
        $output += @(Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults -KeptBecause $runbook.Reason 6>&1)
        # The test run hint the summary prints once the schedule is linked.
        $output += @(Write-TenuVaultTestRunHint -Runbook $runbook 6>&1)
    } catch { $errorText = $_.Exception.Message }
    $PSDefaultParameterValues = @{}
    Write-Scenario -Name $scenario -Runbook $runbook -ErrorText $errorText -Output $output
}

# Reruns with change reports set up before (names, without actors): a command without the change
# report parameters keeps both and the saved tenant name; one that passes them sets both, and an
# empty -TenantName names the tenant by its id again.
foreach ($scenario in "rerun-keeps-report", "rerun-sets-report") {
    Reset-OldSetup
    $script:variables["TenuVaultChangeReport-$tenantKey"] = "names"
    $script:variables["TenuVaultChangeReportActors-$tenantKey"] = "false"
    $script:variables["TenuVaultTenantName-$tenantKey"] = "Contoso"
    $changeReportPassed = $scenario -eq "rerun-sets-report"
    $changeReportActorsPassed = $changeReportPassed
    $tenantNamePassed = $changeReportPassed
    $TenantName = ""
    $ChangeReport = "Full"
    $ChangeReportWithoutActors = $false
    $runbook = $null
    $errorText = $null
    $output = @()
    try { $output = @(. $upgradeStep 3>&1 6>&1) } catch { $errorText = $_.Exception.Message }
    $changeReportPassed = $false
    $changeReportActorsPassed = $false
    $tenantNamePassed = $false
    $ChangeReport = "Off"
    Write-Scenario -Name $scenario -Runbook $runbook -ErrorText $errorText -Output $output
}

function Invoke-LinkedUpgrade {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$Scenario, [hashtable]$ScheduleArguments = @{}, [string]$Scope = "policies")
    $runbook = $null
    $errorText = $null
    $output = @()
    try {
        $output += @(. $upgradeStep 3>&1 6>&1)
        $output += @(& $scheduleStep @ScheduleArguments 3>&1 6>&1)
    } catch { $errorText = $_.Exception.Message }
    Write-Scenario -Name $Scenario -Runbook $runbook -ErrorText $errorText -Output $output
}

Reset-OldSetup
$script:variables["TenuVaultScope-$tenantKey"] = "everything"
$script:variables["TenuVaultExcludedFolders-$tenantKey"] = "ConfigurationPolicies,Apps"
$script:variables["TenuVaultAppOnlyExcluded-$tenantKey"] = ""
Invoke-LinkedUpgrade -Scenario "linked-upgrade"

Reset-OldSetup
$script:variables["TenuVaultScope-$tenantKey"] = "policies"
$script:variables["TenuVaultExcludedFolders-$tenantKey"] = "ConfigurationPolicies,Apps"
$script:variables["TenuVaultAppOnlyExcluded-$tenantKey"] = ""
Invoke-LinkedUpgrade -Scenario "linked-upgrade-everything" -Scope "everything"

Reset-OldSetup
$script:scheduleSettings.IsEnabled = $false
$script:variables["TenuVaultAuditPausedSchedule-$tenantKey"] = $scheduleName
Invoke-LinkedUpgrade -Scenario "disabled-stale-marker"
$script:actions.Clear()
Invoke-LinkedUpgrade -Scenario "disabled-time-override" -ScheduleArguments @{ Time = "10:00" }
$script:actions.Clear()
Invoke-LinkedUpgrade -Scenario "disabled-explicit-replacement" -ScheduleArguments @{ Time = "10:00"; GraphRolesGranted = $true }

foreach ($failure in "container", "role-definition", "role-assignment") {
    Reset-OldSetup
    $script:schedule = $false
    $script:link = $false
    $script:auditFailure = $failure
    Invoke-LinkedUpgrade -Scenario "audit-$failure-denied" -ScheduleArguments @{ GraphRolesGranted = $true }
}

# -Remove runs: complete, -WhatIf, one variable's own confirmation declined, -WhatIf while every
# lookup fails, a complete removal whose variable list fails, and tenant B still on the vault.
foreach ($scenario in "remove-complete", "remove-whatif", "remove-variable-declined", "remove-whatif-lookups-fail", "remove-list-fails", "remove-tenant-b-remains", "remove-scope-read-403-declined", "remove-scope-read-500") {
    Reset-OldSetup
    if ($scenario -eq "remove-variable-declined") { $script:declineVariable = "TenuVaultScope-$tenantKey" }
    if ($scenario -eq "remove-whatif-lookups-fail") { $script:failLookups = $true }
    if ($scenario -eq "remove-list-fails") { $script:failList = $true }
    if ($scenario -eq "remove-tenant-b-remains") { Add-TenantB }
    # The by-name read of TenuVaultScope fails with 403 or 500 and comes back as "not found", while the list still shows it.
    if ($scenario -like "remove-scope-read-*") { $script:translatedVariable = "TenuVaultScope-$tenantKey" }
    if ($scenario -eq "remove-scope-read-403-declined") { $script:declineVariable = "TenuVaultScope-$tenantKey" }
    $output = if ($scenario -like "remove-whatif*") { @(Remove-TenuVaultCloudBackupSetup -WhatIf 6>&1) } else { @(Remove-TenuVaultCloudBackupSetup 6>&1) }
    Write-Scenario -Name $scenario -Output $output
}


# Use the actual upgrade step for a storage move. The data-plane fake grants access to the
# previous account only for the copy case, and records where the original policy was written.
$backupContainer = "intune-backups"
$script:migrationPolicy = '{"version":1,"tenantId":"11111111-2222-3333-4444-555555555555","enabled":true,"scripts":false,"generation":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}'
function Get-AzAccessToken { param($ResourceUrl) @{ Token = "storage-token" } }
function Invoke-WebRequest {
    param($Uri, $Authentication, $Token, $Headers, $Method, $ContentType, $Body, $TimeoutSec, [switch]$SkipHttpErrorCheck)
    if (-not $Uri.EndsWith("/intune-backups/.tenuvault-control/$TenantId/secret-omission.json")) { throw "Unexpected policy path." }
    if ($Method -eq "Put") {
        if ($Uri -notlike "https://stcontoso.*" -or $Headers["If-None-Match"] -ne "*" -or $Body -cne $script:migrationPolicy) { throw "Unsafe copy request." }
        if ($script:variables["TenuVaultStorageAccount-$tenantKey"] -ne "stprevious") { throw "Storage account changed before the policy was copied." }
        $script:actions.Add("copy-policy")
        return @{ StatusCode = 201 }
    }
    if ($script:destinationPolicy -and $Uri -like "https://stcontoso.*") { return @{ Content = $script:destinationPolicy } }
    if ($script:denyPrevious -or $Uri -notlike "https://stprevious.*") { throw "Access denied." }
    return @{ Content = $script:migrationPolicy }
}
foreach ($scenario in "move-copies-policy", "move-copies-off", "move-quiet-on-denied", "move-warns-on-denied", "move-keeps-destination", "move-keeps-off", "move-continues-on-list-error", "fresh-recovers-after-list-error", "fresh-continues-on-list-error", "upgrade-preserves-binding", "upgrade-creates-binding", "upgrade-keeps-unreadable-binding") {
    Reset-OldSetup
    $runbook = $null
    $script:variables["TenuVaultStorageAccount-$tenantKey"] = if ($scenario.StartsWith("move")) { "stprevious" } else { $StorageAccountName }
    if ($scenario -notin @("upgrade-creates-binding", "move-quiet-on-denied")) {
        $script:variables["TenuVaultOmissionAccount-$tenantKey"] = "stprevious"
    }
    if ($scenario -in @("upgrade-keeps-unreadable-binding", "move-continues-on-list-error")) {
        $script:translatedVariable = "TenuVaultOmissionAccount-$tenantKey"
        $script:failList = $true
    }
    if ($scenario.StartsWith("fresh")) {
        $script:variables.Clear()
        $script:failNextList = $true
        $script:failList = $scenario -eq "fresh-continues-on-list-error"
    }
    $script:migrationPolicy = $script:migrationPolicy.Replace('"enabled":false', '"enabled":true')
    if ($scenario -eq "move-copies-off") { $script:migrationPolicy = $script:migrationPolicy.Replace('"enabled":true', '"enabled":false') }
    $script:denyPrevious = $scenario -in @("move-warns-on-denied", "move-quiet-on-denied", "move-keeps-destination", "move-keeps-off", "move-continues-on-list-error")
    $script:destinationPolicy = if ($scenario -eq "move-keeps-destination") { $script:migrationPolicy } elseif ($scenario -eq "move-keeps-off") { $script:migrationPolicy.Replace('"enabled":true', '"enabled":false') }
    $output = @()
    $errorText = $null
    try { $output = @(. $upgradeStep 3>&1 6>&1) } catch { $errorText = $_.Exception.Message }
    Write-Scenario -Name $scenario -Runbook $runbook -ErrorText $errorText -Output $output
}
