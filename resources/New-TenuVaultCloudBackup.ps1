<#
.SYNOPSIS
    Sets up scheduled TenuVault Intune backups that run in Azure, not on an admin's computer.

.DESCRIPTION
    Creates everything the Invoke-TenuVaultBackup runbook needs, in the customer's own tenant and
    subscription. Nothing is created in a TenuVault tenant and no backup leaves the customer's
    storage account.

      * creates or reuses a resource group and an Azure Automation account with a system assigned
        managed identity, imports the sibling runbook runbooks/Invoke-TenuVaultBackup.ps1 and
        publishes it (running the script again upgrades the published runbook)
      * writes the tenant's configuration as Automation variables with a per tenant suffix. One
        Automation account serves the one Entra tenant its managed identity belongs to
      * creates the intune-backups container when missing and gives the identity the custom role
        "TenuVault Backup Writer" on that container only: read and write blobs, no delete. The
        runbook therefore cannot remove backups; retention runs on the next desktop backup made
        with an admin's sign-in (an age-based lifecycle rule is no substitute: it lacks the
        desktop protections, see the cloud backup guide)
      * creates the container tenuvault-backup-results when missing and gives the identity the
        same write-only role there, so each run can leave its result (status, folder name,
        counts, failed type names, time; never policy content) for the notification watcher to
        alert on. A container of its own: the identity never gets write access to the
        watcher's state
      * links the runbook to a daily or weekly schedule in the timezone you choose
      * with -AlertEmail, creates an Azure Monitor action group and a metric alert on failed
        Automation jobs, before the schedule is linked. Without it, -NoFailureAlert is the
        explicit opt out. Setup refuses to guess: a backup that fails silently is worse than none.

    Backups are written as plain JSON. TenuVault does not encrypt backups in your storage account:
    Azure encrypts it at rest and your Azure role assignments decide who can read it, so setup needs
    no Key Vault and no recovery key. Setups made before runbook 1.2.0 created a Key Vault
    (kv-tenuvault-<suffix>) for the recovery key. Running this script again is the upgrade: it
    republishes the runbook and rewrites the variables in place. Once the published runbook reads
    back as 1.2.0 or later, it removes the tenant's old TenuVaultKeyVault variable and names the
    old vault. Delete it once no TenuVault setup in this or any other Automation account still has
    a TenuVaultKeyVault variable; the script checks this account and names the tenants that still
    have one. Backups made before the upgrade stay sealed and open in TenuVault with the recovery key.

    Microsoft Graph application roles are the one part Azure RBAC cannot grant. With
    -GrantGraphRoles (Global Administrator) the script assigns the read-only DeviceManagement
    roles to the managed identity, the same set as the desktop Backup Reader, and prints a consent
    receipt. Without it, the script prints the exact list for a Global Administrator and the
    schedule stays unlinked until you run it again with -GrantGraphRoles or -GraphRolesGranted
    after granting them by hand.

    DeviceCategories and DeviceCleanupRules need DeviceManagementManagedDevices.Read.All, which
    also exposes the device inventory. It is off by default: cloud backups then leave those two
    types out (recorded as AppOnlyExcludedTypes), exactly like the Backup Reader. Pass
    -IncludeDeviceCategories after that decision has been made for the tenant.

    With -Remove, the script deletes this tenant's schedule link, schedule and Automation
    variables, and lists what stays behind on purpose (Automation account, roles, backups) and
    what to revoke by hand. When the tenant's schedule link, schedule and variables read back as
    gone, and no tenant in this Automation account still has a TenuVaultKeyVault variable, it
    names the Key Vault of an earlier setup for deletion under the same rule; otherwise it says
    what is left, what could not be checked or which tenants still have the variable, and to
    keep the vault.

    Needs Az.Accounts, Az.Resources, Az.Automation and Az.Storage, plus an account
    that can create Automation accounts and role assignments (Owner, or Contributor
    plus User Access Administrator, on the Automation resource group and, when it differs, on
    the storage account's resource group). The storage resource group access must include
    Microsoft.Authorization/roleAssignments/write and, when the writer role is created or its
    assignable scopes are updated, Microsoft.Authorization/roleDefinitions/write. The account
    must also hold a blob data role such as Storage Blob Data Contributor on the storage account,
    because the container check and creation below use the signed-in account (management roles
    alone include no data access).

.PARAMETER TenantId
    Entra tenant id (GUID) to back up. The storage account and Automation account do not have to
    live in this tenant for an MSP setup, but the managed identity's Graph roles must be granted
    in the tenant that holds the identity; the script refuses a mismatched Az context tenant.

.PARAMETER StorageAccountName
    Storage account that holds (or will hold) the intune-backups container. Create it first, for
    example with New-TenuVaultStorage.ps1. It must be the account the tenant uses in TenuVault.

.PARAMETER Time
    Local time of day the backup runs, "HH:mm". Default 02:00.

.PARAMETER WeekDay
    Day of the week for a weekly schedule. Default Sunday.

.PARAMETER TimeZone
    IANA timezone for the schedule, for example Europe/Berlin. Default UTC. Daylight saving
    follows the timezone, not a fixed offset.

.PARAMETER Scope
    everything, or policies (everything except apps, the desktop default). Default policies.

.PARAMETER ExcludedFolders
    Comma separated type folders to leave out. Wins over -Scope.

.PARAMETER TenantName
    The tenant's name as change reports show it, in titles, the email subject and the file
    name, at most 200 characters. A rerun without it keeps the name an earlier setup saved;
    pass -TenantName '' to name the tenant by its id again. Without any, reports use the id.

.PARAMETER ChangeReport
    Off (default), Names or Full. With Names or Full, every complete backup is compared with the
    previous complete plain backup of the tenant, and a change report (what changed, setting by
    setting, and who changed it from the Intune audit log) is left in the 'tenuvault-backup-results'
    container for the notification watcher to send by email. Names lists which settings changed
    without their values; Full includes the values. Secret values are never included. Like the
    backups, the report is plain JSON; it is deleted once sent, or unsent after 7 days. Backups
    sealed before runbook 1.2.0 cannot be opened in Azure and are never compared. A rerun
    without -ChangeReport keeps the level an earlier setup chose (off when none did).

.PARAMETER ChangeReportWithoutActors
    Leave out who made each change (user principal names are personal data). Pass
    -ChangeReportWithoutActors:$false to name them again. A rerun without it keeps the earlier choice.

.PARAMETER GrantGraphRoles
    Assign the Graph application roles to the managed identity now. Needs Global Administrator.

.PARAMETER GraphRolesGranted
    Say that a Global Administrator already assigned the roles listed by an earlier run, so the
    schedule can be linked.

.PARAMETER Remove
    Remove this tenant's schedule link, schedule and variables, then list the rest.

.EXAMPLE
    ./New-TenuVaultCloudBackup.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -ResourceGroupName rg-tenuvault-backups -StorageAccountName tvbkp1234567890ab -Location westeurope -TimeZone Europe/Berlin -Time 02:00 -AlertEmail ops@contoso.com -GrantGraphRoles
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$StorageAccountName,
    [string]$SubscriptionId,
    [string]$ResourceGroupName = "rg-tenuvault-backups",
    [string]$Location,
    [string]$AutomationAccountName = "aa-tenuvault",
    [ValidateSet("Daily", "Weekly")][string]$Frequency = "Daily",
    [string]$Time = "02:00",
    [DayOfWeek]$WeekDay = [DayOfWeek]::Sunday,
    [string]$TimeZone = "UTC",
    [ValidateSet("everything", "policies")][string]$Scope = "policies",
    [string]$ExcludedFolders,
    [string]$TenantName,
    [ValidateSet("Off", "Names", "Full")][string]$ChangeReport = "Off",
    [switch]$ChangeReportWithoutActors,
    [string]$AlertEmail,
    [switch]$NoFailureAlert,
    [switch]$IncludeDeviceCategories,
    [switch]$GrantGraphRoles,
    [switch]$GraphRolesGranted,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$runbookName = "Invoke-TenuVaultBackup"
$backupContainer = "intune-backups"
# Each run leaves its result note here for the notification watcher. Not the watcher's state
# container: write access there would let this identity rewrite the watcher's state.
$outcomeContainer = "tenuvault-backup-results"
$runbookPath = Join-Path $PSScriptRoot "runbooks/Invoke-TenuVaultBackup.ps1"
$tenantKey = $TenantId.Substring(0, [Math]::Min(8, $TenantId.Length)).ToLowerInvariant()
$scheduleName = "TenuVaultBackup-$tenantKey"
$writerRoleName = "TenuVault Backup Writer"

$graphRoleNames = @(
    "DeviceManagementConfiguration.Read.All",
    "DeviceManagementApps.Read.All",
    "DeviceManagementServiceConfig.Read.All",
    "DeviceManagementScripts.Read.All",
    "DeviceManagementRBAC.Read.All"
)
if ($IncludeDeviceCategories) { $graphRoleNames += "DeviceManagementManagedDevices.Read.All" }
$appOnlyExcluded = if ($IncludeDeviceCategories) { "" } else { "DeviceCategories,DeviceCleanupRules" }

$variableNames = @(
    "TenuVaultTenantId-$tenantKey", "TenuVaultStorageAccount-$tenantKey",
    "TenuVaultScope-$tenantKey", "TenuVaultExcludedFolders-$tenantKey", "TenuVaultAppOnlyExcluded-$tenantKey",
    "TenuVaultChangeReport-$tenantKey", "TenuVaultChangeReportActors-$tenantKey", "TenuVaultTenantName-$tenantKey"
)
# Setups before runbook 1.2.0 also wrote the Key Vault that held the recovery key. The runbook
# no longer reads it; a rerun or -Remove deletes that variable.
$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"
# The first runbook that writes plain backups and reads no Key Vault.
$plainRunbookVersion = "1.2.0"
# The first runbook with the TRIGGER parameter that records a run started by hand as Manual.
$triggerRunbookVersion = "1.4.0"
# A rerun without -ChangeReport or -ChangeReportWithoutActors keeps what an earlier setup chose,
# so an upgrade with an older command never turns a report off or its actors back on.
$changeReportPassed = $PSBoundParameters.ContainsKey("ChangeReport")
$changeReportActorsPassed = $PSBoundParameters.ContainsKey("ChangeReportWithoutActors")
# Like the report choice: omitted keeps the saved name, an empty -TenantName clears it.
$tenantNamePassed = $PSBoundParameters.ContainsKey("TenantName")

# Validate every input before the first Azure write.
if ($TenantId -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    throw "'$TenantId' is not a tenant id. Pass the tenant (directory) id GUID."
}
if ($StorageAccountName -notmatch '^[a-z0-9]{3,24}$') {
    throw "Storage account name '$StorageAccountName' is invalid: use 3 to 24 lower case letters and digits."
}
if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "-Time '$Time' is invalid: use HH:mm, for example 02:00."
}
if ($AlertEmail -and $AlertEmail -notmatch "^[^@\s]+@[^@\s]+$") {
    throw "-AlertEmail '$AlertEmail' is not an email address."
}
if ($AlertEmail -and $NoFailureAlert) {
    throw "-AlertEmail and -NoFailureAlert contradict each other. Pass only one of them."
}
if (-not $Remove -and -not $AlertEmail -and -not $NoFailureAlert) {
    throw "Decide how failed cloud backups will be noticed before anything is created: pass -AlertEmail <address> to create an Azure Monitor failure alert, or -NoFailureAlert to explicitly accept that failed runs are only visible in the Automation job list and in TenuVault. Nothing was written."
}
if ($GrantGraphRoles -and $GraphRolesGranted) {
    throw "-GrantGraphRoles and -GraphRolesGranted contradict each other. Pass only one of them."
}
if ((-not $Remove) -and -not (Test-Path $runbookPath)) {
    throw "Runbook file not found: $runbookPath. Keep this script next to the runbooks folder from the TenuVault release."
}

foreach ($module in "Az.Accounts", "Az.Resources", "Az.Automation", "Az.Storage") {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "Installing $module for the current user..."
        Install-Module $module -Scope CurrentUser -Force -AllowClobber
    }
}

if (-not (Get-AzContext)) { Connect-AzAccount | Out-Null }
if ($SubscriptionId) { Set-AzContext -Subscription $SubscriptionId | Out-Null }
$context = Get-AzContext
Write-Host "Subscription: $($context.Subscription.Name) ($($context.Subscription.Id))"

$contextTenantId = [string]$context.Tenant.Id
if ($contextTenantId.ToLowerInvariant() -ne $TenantId.ToLowerInvariant()) {
    throw "The current Az context tenant is '$(if ($contextTenantId) { $contextTenantId } else { '<empty>' })', but -TenantId is $TenantId. Run Connect-AzAccount -Tenant $TenantId (and select the right subscription), then run this script again. Nothing was written."
}

function Set-TenuVaultAutomationVariable {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value,
        [bool]$Encrypted = $false
    )
    $existing = Get-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $Name -ErrorAction SilentlyContinue
    if ($existing) {
        if ($PSCmdlet.ShouldProcess($Name, "Update Automation variable")) {
            Set-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -Name $Name `
                -Encrypted:$Encrypted -Value $Value | Out-Null
        }
    } elseif ($PSCmdlet.ShouldProcess($Name, "Create Automation variable")) {
        New-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $Name `
            -Encrypted:$Encrypted -Value $Value | Out-Null
    }
}

function Get-TenuVaultAutomationPrincipalId {
    $resource = Get-AzResource -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName `
        -ResourceType "Microsoft.Automation/automationAccounts" -ErrorAction SilentlyContinue
    if ($resource -and $resource.Identity -and $resource.Identity.PrincipalId) {
        return [string]$resource.Identity.PrincipalId
    }
    return $null
}

function Add-TenuVaultRoleAssignment {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$ObjectId,
        [Parameter(Mandatory)][string]$RoleName,
        [string]$RoleDefinitionId,
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][string]$Target
    )
    $existing = Get-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleName -Scope $Scope |
        Where-Object { $_.Scope -eq $Scope }
    if ($existing) {
        Write-Host "$Target already has '$RoleName'."
    } elseif ($PSCmdlet.ShouldProcess($Scope, "Assign '$RoleName' to $Target")) {
        Write-Host "Assigning '$RoleName' to $Target..."
        # Custom role names do not reliably resolve in New-AzRoleAssignment; use a known id
        # directly so a just-created role does not depend on a second name lookup.
        if ($RoleDefinitionId) {
            New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionId $RoleDefinitionId -Scope $Scope | Out-Null
        } else {
            $definition = Get-AzRoleDefinition -Name $RoleName -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($definition) {
                New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionId $definition.Id -Scope $Scope | Out-Null
            } else {
                New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleName -Scope $Scope | Out-Null
            }
        }
    }
}

# Every variable of the Automation account, name to value, from one complete list (the cmdlet
# follows every page). Error is set when the list failed, and then no variable may be called
# absent. A lookup by name cannot decide that: Az.Automation reports any failed read of one
# variable (403, 500, not only 404) as ResourceNotFoundException.
function Get-TenuVaultAutomationVariables {
    try {
        $all = @(Get-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -ErrorAction Stop)
    } catch {
        return @{ Variables = @{}; Error = $_.Exception.Message }
    }
    $variables = @{}
    foreach ($variable in $all) { if ($variable -and $variable.Name) { $variables[[string]$variable.Name] = $variable.Value } }
    return @{ Variables = $variables; Error = $null }
}

# The Key Vault of a setup before runbook 1.2.0: the one this tenant's old variable names, and
# any kv-tenuvault-* vault in the Automation resource group, where those setups created it.
function Get-TenuVaultLegacyKeyVaults {
    $names = [System.Collections.Generic.List[string]]::new()
    $listed = Get-TenuVaultAutomationVariables
    $value = "$($listed.Variables[$legacyKeyVaultVariable])".Trim('"')
    if ($value) { $names.Add($value) }
    $vaults = Get-AzResource -ResourceGroupName $ResourceGroupName -ResourceType "Microsoft.KeyVault/vaults" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "kv-tenuvault-*" }
    foreach ($vault in @($vaults)) { if ($vault -and -not $names.Contains($vault.Name)) { $names.Add($vault.Name) } }
    return @($names)
}

# Whether a failed Az lookup means the resource does not exist. Only that counts as absent; an
# auth, transport or service error leaves the state unknown. Az.Automation keeps the status for
# schedules and job schedules, but not for variables, so variables are never decided by this.
function Test-TenuVaultNotFound {
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)
    for ($exception = $ErrorRecord.Exception; $exception; $exception = $exception.InnerException) {
        if ($exception.GetType().Name -eq "ResourceNotFoundException") { return $true }
        $response = $exception.PSObject.Properties["Response"]
        if ($response -and $response.Value -and [int]$response.Value.StatusCode -eq 404) { return $true }
    }
    return $false
}

# The tenant keys whose TenuVaultKeyVault variable is still in this Automation account, or
# Error when the variables could not be listed.
function Get-TenuVaultKeyVaultUsers {
    $listed = Get-TenuVaultAutomationVariables
    if ($listed.Error) { return @{ Keys = @(); Error = $listed.Error } }
    $keys = @($listed.Variables.Keys | Where-Object { $_ -like "TenuVaultKeyVault-*" } | ForEach-Object { $_.Substring("TenuVaultKeyVault-".Length) } | Sort-Object -Unique)
    return @{ Keys = $keys; Error = $null }
}

# $KeptBecause names why the vault may still be read (the runbook was not verified as plain, or
# this tenant's setup was not verified as removed). Without it, deletion advice is given only
# when no tenant in this Automation account still has a TenuVaultKeyVault variable.
function Write-TenuVaultLegacyKeyVaultNote {
    param([string[]]$Names, [string]$KeptBecause)
    if (-not $Names) { return }
    if (-not $KeptBecause) {
        $users = Get-TenuVaultKeyVaultUsers
        if ($users.Error) {
            $KeptBecause = "the variables of Automation account '$AutomationAccountName' could not be read to check which setups still use it ($($users.Error))"
        } elseif ($users.Keys.Count) {
            $KeptBecause = "tenant key(s) $($users.Keys -join ', ') in Automation account '$AutomationAccountName' still have a TenuVaultKeyVault variable; run this script for those tenants too"
        }
    }
    Write-Host ""
    if ($KeptBecause) {
        Write-Host "Keep Key Vault $($Names -join ', '): $KeptBecause, so a setup may still read it." -ForegroundColor Yellow
        Write-Host "Run this script again to finish; it reports when this setup no longer needs the vault." -ForegroundColor Yellow
        return
    }
    Write-Host "This setup no longer needs Key Vault $($Names -join ', ') from an earlier setup, and no tenant in"
    Write-Host "Automation account '$AutomationAccountName' still has a TenuVaultKeyVault variable. Delete the vault once no"
    Write-Host "TenuVault setup in this or any other Automation account still has a TenuVaultKeyVault variable, in the"
    Write-Host "portal or with Remove-AzKeyVault. Deleting it also removes its role assignments. Keep the recovery"
    Write-Host "key saved: backups made before the upgrade stay sealed with it and open in TenuVault with it."
}

# The version the published runbook carries, read back from Azure, or $null when it cannot be read.
function Get-TenuVaultPublishedRunbookVersion {
    $folder = Join-Path ([IO.Path]::GetTempPath()) "tenuvault-runbook-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    try {
        Export-AzAutomationRunbook -ResourceGroupName $ResourceGroupName -AutomationAccountName $AutomationAccountName `
            -Name $runbookName -Slot Published -OutputFolder $folder -Force -Confirm:$false -ErrorAction Stop | Out-Null
        $file = Get-ChildItem -Path $folder -Filter "*.ps1" -File | Select-Object -First 1
        if (-not $file) { return $null }
        $match = [regex]::Match((Get-Content -Raw -Path $file.FullName), '\$script:RunbookVersion = "(\d+\.\d+\.\d+)"')
        if ($match.Success) { return $match.Groups[1].Value }
        return $null
    } catch {
        Write-Host "Could not read back the published runbook: $($_.Exception.Message)"
        return $null
    } finally {
        Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# How to test the linked schedule now. TRIGGER exists from runbook $triggerRunbookVersion on: an older
# published runbook (a declined or failed publish) has no such field in the portal's Start pane.
function Write-TenuVaultTestRunHint {
    param([Parameter(Mandatory)][object]$Runbook)
    Write-Host ""
    Write-Host "Test it now instead of waiting for the first night: in the Azure portal open the"
    if ($Runbook.Version -and [version]$Runbook.Version -ge [version]$triggerRunbookVersion) {
        Write-Host "Automation account, Runbooks > $runbookName > Start, set TENANTKEY to $tenantKey and"
        Write-Host "TRIGGER to Manual, and watch the job output. The backup then appears in TenuVault under"
        Write-Host "Backup History, marked Manual; without TRIGGER it is marked Scheduled like nightly runs."
    } else {
        $why = if ($Runbook.Version) { "the published runbook is version $($Runbook.Version), older than $triggerRunbookVersion" } else { "the published runbook could not be read back as $triggerRunbookVersion or later" }
        Write-Host "Automation account, Runbooks > $runbookName > Start, set TENANTKEY to $tenantKey, and"
        Write-Host "watch the job output. The backup then appears in TenuVault under Backup History, marked"
        Write-Host "Scheduled: $why, so it has no TRIGGER to record a run started by hand."
        Write-Host "Run this script again and let it publish the runbook; then a run started with TRIGGER set"
        Write-Host "to Manual is recorded as Manual."
    }
}

# Imports and publishes the sibling runbook, then reads the published runbook back. Plain is true
# only when Azure now runs a runbook of $plainRunbookVersion or later, whatever was confirmed.
function Publish-TenuVaultRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    if (-not $PSCmdlet.ShouldProcess($runbookName, "Import and publish runbook")) {
        return @{ Plain = $false; Version = $null; Reason = "the runbook import and publish was not approved" }
    }
    Write-Host "Importing runbook '$runbookName'..."
    # Approved once above: the import's own confirmation must not decide differently.
    Import-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName `
        -Path $runbookPath -Type PowerShell72 -Description "TenuVault scheduled Intune backup in Azure" -Force -Confirm:$false | Out-Null
    Publish-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName | Out-Null
    $version = Get-TenuVaultPublishedRunbookVersion
    if (-not $version) { return @{ Plain = $false; Version = $null; Reason = "the published runbook could not be read back or carries no TenuVault version" } }
    if ([version]$version -lt [version]$plainRunbookVersion) {
        return @{ Plain = $false; Version = $version; Reason = "the published runbook is still version $version, older than $plainRunbookVersion" }
    }
    return @{ Plain = $true; Version = $version; Reason = $null }
}

# Drops the Key Vault variable of a setup before runbook 1.2.0, but only once the published runbook
# was read back as one that no longer reads it: an older published runbook still needs the variable.
function Remove-TenuVaultLegacyKeyVaultVariable {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][hashtable]$Runbook)
    $listed = Get-TenuVaultAutomationVariables
    if ($listed.Error) {
        Write-Host "Kept '$legacyKeyVaultVariable' if it exists: the Automation account's variables could not be listed ($($listed.Error)). Run this script again to finish the upgrade."
        return
    }
    if (-not $listed.Variables.ContainsKey($legacyKeyVaultVariable)) { return }
    if (-not $Runbook.Plain) {
        Write-Host "Kept '$legacyKeyVaultVariable': $($Runbook.Reason). Run this script again to finish the upgrade."
        return
    }
    if ($PSCmdlet.ShouldProcess($legacyKeyVaultVariable, "Remove Automation variable (no longer read)")) {
        Remove-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $legacyKeyVaultVariable -Confirm:$false | Out-Null
    }
}

# What of this tenant's setup is still in Azure: the schedule link, the schedule and the variables.
# Left lists what exists; Unknown lists what could not be checked (any lookup error but not found).
function Get-TenuVaultTenantSetupLeft {
    $left = [System.Collections.Generic.List[string]]::new()
    $unknown = [System.Collections.Generic.List[string]]::new()
    $probe = {
        param([string]$Label, [scriptblock]$Read)
        try {
            if (& $Read) { $left.Add($Label) }
        } catch {
            if (-not (Test-TenuVaultNotFound $_)) { $unknown.Add("$Label ($($_.Exception.Message))") }
        }
    }
    & $probe "the link of '$runbookName' to '$scheduleName'" {
        Get-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName -AutomationAccountName $AutomationAccountName `
            -RunbookName $runbookName -ScheduleName $scheduleName -ErrorAction Stop
    }
    & $probe "schedule '$scheduleName'" {
        Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction Stop
    }
    # A variable is gone only when one complete list succeeded without it.
    $listed = Get-TenuVaultAutomationVariables
    foreach ($name in @($variableNames) + $legacyKeyVaultVariable) {
        if ($listed.Error) { $unknown.Add("variable '$name' ($($listed.Error))") }
        elseif ($listed.Variables.ContainsKey($name)) { $left.Add("variable '$name'") }
    }
    return @{ Left = @($left); Unknown = @($unknown) }
}

# -Remove: this tenant's schedule link, schedule and variables go away, then what is left is read back.
function Remove-TenuVaultCloudBackupSetup {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    $account = Get-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName -ErrorAction SilentlyContinue
    if (-not $account) {
        Write-Host "Automation account '$AutomationAccountName' was not found in '$ResourceGroupName'. Nothing to remove."
        return
    }
    $principalId = Get-TenuVaultAutomationPrincipalId
    $legacyKeyVaults = Get-TenuVaultLegacyKeyVaults
    if ($PSCmdlet.ShouldProcess("$runbookName on $scheduleName", "Unlink runbook from schedule")) {
        try {
            Unregister-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
                -ScheduleName $scheduleName -Force -Confirm:$false -ErrorAction Stop | Out-Null
        } catch { }
    }
    $schedule = Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction SilentlyContinue
    if ($schedule -and $PSCmdlet.ShouldProcess($scheduleName, "Remove schedule")) {
        Remove-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName -Force -Confirm:$false | Out-Null
    }
    # Which variables exist comes from the list; when it fails, every one is attempted.
    $listed = Get-TenuVaultAutomationVariables
    foreach ($name in @($variableNames) + $legacyKeyVaultVariable) {
        if (-not $listed.Error -and -not $listed.Variables.ContainsKey($name)) { continue }
        if ($PSCmdlet.ShouldProcess($name, "Remove Automation variable")) {
            try {
                Remove-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
                    -AutomationAccountName $AutomationAccountName -Name $name -Confirm:$false -ErrorAction Stop | Out-Null
            } catch {
                Write-Host "Could not remove variable '$name': $($_.Exception.Message)"
            }
        }
    }
    # Read back instead of trusting the prompts: a declined or failed step leaves the setup running.
    $state = Get-TenuVaultTenantSetupLeft
    Write-Host ""
    if ($state.Left.Count) {
        Write-Host "Cloud backups for tenant $TenantId were not fully removed. Still in place: $($state.Left -join ', ')." -ForegroundColor Yellow
        Write-Host "Run this script with -Remove again to finish."
    }
    if ($state.Unknown.Count) {
        Write-Host "The removal could not be verified. Could not check: $($state.Unknown -join '; ')." -ForegroundColor Yellow
        Write-Host "Run this script with -Remove again once Azure answers."
    }
    if (-not $state.Left.Count -and -not $state.Unknown.Count) {
        Write-Host "Cloud backup schedule and variables for tenant $TenantId removed." -ForegroundColor Green
    }
    Write-Host "Left in place on purpose: Automation account '$AutomationAccountName' and runbook '$runbookName'"
    Write-Host "(other tenants may use them), storage account '$StorageAccountName' with every backup,"
    Write-Host "and the role assignments."
    Write-Host "When the Automation account is no longer used by any tenant, revoke these Graph roles"
    Write-Host "from its managed identity (Entra ID > Enterprise applications > Permissions):"
    foreach ($role in $graphRoleNames) { Write-Host "  * $role" }
    if ($principalId) { Write-Host "Managed identity object (principal) id: $principalId" }
    $keptBecause = if ($state.Left.Count) { "this tenant's cloud backup setup was not fully removed" } elseif ($state.Unknown.Count) { "the removal of this tenant's cloud backup setup could not be verified" } else { $null }
    Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults -KeptBecause $keptBecause
}

function Assert-TenuVaultAuthorizationActions {
    param(
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][string[]]$RequiredActions
    )
    if (-not (Get-Command Invoke-AzRestMethod -ErrorAction SilentlyContinue)) {
        throw "Invoke-AzRestMethod is not available, so setup cannot verify role-management access in the storage resource group. Install or update Az.Accounts. Nothing was written."
    }
    $response = Invoke-AzRestMethod -Method Get -Path "$Scope/providers/Microsoft.Authorization/permissions?api-version=2015-07-01"
    $permissions = @(($response.Content | ConvertFrom-Json).value)
    $missing = @()
    foreach ($requiredAction in $RequiredActions) {
        $allowed = $false
        foreach ($permission in $permissions) {
            $granted = @($permission.actions | Where-Object { $requiredAction -like $_ }).Count -gt 0
            $denied = @($permission.notActions | Where-Object { $requiredAction -like $_ }).Count -gt 0
            if ($granted -and -not $denied) { $allowed = $true; break }
        }
        if (-not $allowed) { $missing += $requiredAction }
    }
    if ($missing) {
        throw "The signed-in account cannot manage the TenuVault Backup Writer role in the storage resource group ($Scope). Missing: $($missing -join ', '). Use Owner, or Contributor plus User Access Administrator, on that resource group as well as on the Automation resource group. Nothing was written."
    }
}

# Check storage role-management access before the first Azure resource write. The role
# definition write is only needed when the shared writer role does not yet allow this scope.
$storageAccount = $null
if (-not $Remove) {
    $storageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue
    if (-not $storageAccount) {
        $storageAccount = Get-AzStorageAccount -ErrorAction SilentlyContinue | Where-Object { $_.StorageAccountName -eq $StorageAccountName } | Select-Object -First 1
    }
    if (-not $storageAccount) {
        throw "Storage account '$StorageAccountName' was not found in this subscription. Create it first, for example with New-TenuVaultStorage.ps1. Nothing was written."
    }
    $storageGroupScope = ($storageAccount.Id -split '/providers/')[0]
    $requiredStorageActions = @("Microsoft.Authorization/roleAssignments/write")
    $existingWriterRole = Get-AzRoleDefinition -Name $writerRoleName -ErrorAction SilentlyContinue
    if (-not $existingWriterRole -or $existingWriterRole.AssignableScopes -notcontains $storageGroupScope) {
        $requiredStorageActions += "Microsoft.Authorization/roleDefinitions/write"
    }
    Assert-TenuVaultAuthorizationActions -Scope $storageGroupScope -RequiredActions $requiredStorageActions
}

# ---------------------------------------------------------------------------
# Remove mode: this tenant's schedule link, schedule and variables go away. The
# account, roles and backups stay, because another tenant may use them.
# ---------------------------------------------------------------------------

if ($Remove) {
    Remove-TenuVaultCloudBackupSetup
    return
}

# ---------------------------------------------------------------------------
# Resource group and Automation account
# ---------------------------------------------------------------------------

$resourceGroup = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
if (-not $resourceGroup) {
    if (-not $Location) { throw "Resource group '$ResourceGroupName' does not exist. Pass -Location to create it, for example -Location westeurope." }
    Write-Host "Creating resource group '$ResourceGroupName' in $Location..."
    if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Create resource group")) {
        $resourceGroup = New-AzResourceGroup -Name $ResourceGroupName -Location $Location
    }
}
if (-not $resourceGroup) {
    Write-Host "What if: nothing was created. Run again without -WhatIf."
    return
}
if (-not $Location) { $Location = $resourceGroup.Location }

$automationAccount = Get-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName -ErrorAction SilentlyContinue
if (-not $automationAccount) {
    Write-Host "Creating Automation account '$AutomationAccountName' in $Location with a system assigned identity..."
    if ($PSCmdlet.ShouldProcess($AutomationAccountName, "Create Automation account with system assigned identity")) {
        try {
            $automationAccount = New-AzAutomationAccount -ResourceGroupName $ResourceGroupName `
                -Name $AutomationAccountName -Location $Location -AssignSystemIdentity
        } catch {
            if ($_.Exception.Message -match "Conflict") {
                throw "Azure refused to create Automation account '$AutomationAccountName' in $Location with a Conflict. The usual cause is the regional Automation account quota (as low as 2 accounts per region on many subscription types) or the name already being taken in that region. Run the script again with another -Location or another -AutomationAccountName. Original error: $($_.Exception.Message)"
            }
            throw
        }
    }
} else {
    Write-Host "Automation account '$AutomationAccountName' already exists; checking its identity..."
    if (-not (Get-TenuVaultAutomationPrincipalId)) {
        if ($PSCmdlet.ShouldProcess($AutomationAccountName, "Assign system assigned identity")) {
            Set-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName `
                -AssignSystemIdentity | Out-Null
        }
    }
}
if (-not $automationAccount) {
    Write-Host "What if: nothing was changed. Run again without -WhatIf."
    return
}

$principalId = Get-TenuVaultAutomationPrincipalId
$deadline = [DateTime]::UtcNow.AddMinutes(5)
while (-not $principalId -and [DateTime]::UtcNow -lt $deadline -and -not $WhatIfPreference) {
    Start-Sleep -Seconds 10
    $principalId = Get-TenuVaultAutomationPrincipalId
}
if (-not $principalId -and -not $WhatIfPreference) {
    throw "The system assigned identity of '$AutomationAccountName' did not appear within five minutes. Run the script again."
}
if ($principalId) { Write-Host "Managed identity object (principal) id: $principalId" }

# ---------------------------------------------------------------------------
# Storage: container and the container scoped writer role (no delete)
# ---------------------------------------------------------------------------

$storageContext = New-AzStorageContext -StorageAccountName $StorageAccountName -UseConnectedAccount
$container = Get-AzStorageContainer -Name $backupContainer -Context $storageContext -ErrorAction SilentlyContinue
if (-not $container) {
    Write-Host "Creating container '$backupContainer'..."
    if ($PSCmdlet.ShouldProcess($backupContainer, "Create storage container")) {
        New-AzStorageContainer -Name $backupContainer -Context $storageContext -Permission Off | Out-Null
    }
}
$stateContainer = Get-AzStorageContainer -Name $outcomeContainer -Context $storageContext -ErrorAction SilentlyContinue
if (-not $stateContainer) {
    Write-Host "Creating container '$outcomeContainer' for backup results the notification watcher alerts on..."
    if ($PSCmdlet.ShouldProcess($outcomeContainer, "Create storage container")) {
        New-AzStorageContainer -Name $outcomeContainer -Context $storageContext -Permission Off | Out-Null
    }
}

if ($principalId) {
    # The container assignment lives under the storage account, which may be in another
    # resource group than the Automation account. The role must be assignable there.
    $groupScope = $storageGroupScope
    $dataActions = @(
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"
    )
    $role = Get-AzRoleDefinition -Name $writerRoleName -ErrorAction SilentlyContinue
    if (-not $role) {
        Write-Host "Creating the custom role '$writerRoleName' (read and write blobs, no delete)..."
        if ($PSCmdlet.ShouldProcess($groupScope, "Create custom role $writerRoleName")) {
            $definition = [Microsoft.Azure.Commands.Resources.Models.Authorization.PSRoleDefinition]::new()
            $definition.Name = $writerRoleName
            $definition.Description = "TenuVault Backup Writer: writes backups. Cannot delete blobs, blob versions or containers."
            $definition.IsCustom = $true
            # Az.Resources 10 replaced the flattened Actions/DataActions properties with Permissions.
            if ($definition.PSObject.Properties.Name -contains 'Permissions') {
                $permission = [Microsoft.Azure.Commands.Resources.Models.Authorization.PSPermission]::new()
                $permission.Actions = [System.Collections.Generic.List[string]]::new()
                $permission.NotActions = [System.Collections.Generic.List[string]]::new()
                $permission.DataActions = [System.Collections.Generic.List[string]]::new()
                foreach ($action in $dataActions) { $permission.DataActions.Add($action) }
                $permission.NotDataActions = [System.Collections.Generic.List[string]]::new()
                $definition.Permissions = [System.Collections.Generic.List[Microsoft.Azure.Commands.Resources.Models.Authorization.PSPermission]]::new()
                $definition.Permissions.Add($permission)
            } else {
                $definition.Actions = @()
                $definition.DataActions = $dataActions
            }
            $definition.AssignableScopes = [System.Collections.Generic.List[string]]::new()
            $definition.AssignableScopes.Add($groupScope)
            $role = New-AzRoleDefinition -Role $definition
        }
    } else {
        $existingActions = @()
        $existingDataActions = @()
        if ($role.PSObject.Properties.Name -contains 'Permissions' -and $role.Permissions) {
            foreach ($permission in $role.Permissions) {
                $existingActions += @($permission.Actions)
                $existingDataActions += @($permission.DataActions)
            }
        } else {
            $existingActions = @($role.Actions)
            $existingDataActions = @($role.DataActions)
        }
        $extra = @($existingDataActions | Where-Object { $dataActions -notcontains $_ }) + @($existingActions)
        if ($extra) { throw "The existing role '$writerRoleName' allows more than writing backups ($($extra -join ', ')). Remove those permissions or delete the role, then run the script again." }
        if ($role.AssignableScopes -notcontains $groupScope -and $PSCmdlet.ShouldProcess($writerRoleName, "Allow assignments in $groupScope")) {
            $role.AssignableScopes.Add($groupScope)
            $role = Set-AzRoleDefinition -Role $role
        }
    }
    if ($role) {
        Add-TenuVaultRoleAssignment -ObjectId $principalId -RoleName $writerRoleName `
            -RoleDefinitionId ([string]$role.Id) `
            -Scope "$($storageAccount.Id)/blobServices/default/containers/$backupContainer" -Target "the cloud backup identity"
        # Write only there too: the runbook can add result notes but not delete or read others away.
        Add-TenuVaultRoleAssignment -ObjectId $principalId -RoleName $writerRoleName `
            -RoleDefinitionId ([string]$role.Id) `
            -Scope "$($storageAccount.Id)/blobServices/default/containers/$outcomeContainer" -Target "the cloud backup identity (result notes)"
    }
}

# ---------------------------------------------------------------------------
# Runbook import and publish. A rerun is the upgrade path.
# ---------------------------------------------------------------------------

$runbook = Publish-TenuVaultRunbook

Write-Host "Writing Automation variables for this tenant (suffix -$tenantKey)..."
Set-TenuVaultAutomationVariable -Name "TenuVaultTenantId-$tenantKey" -Value $TenantId
Set-TenuVaultAutomationVariable -Name "TenuVaultStorageAccount-$tenantKey" -Value $StorageAccountName
Set-TenuVaultAutomationVariable -Name "TenuVaultScope-$tenantKey" -Value $Scope
Set-TenuVaultAutomationVariable -Name "TenuVaultExcludedFolders-$tenantKey" -Value $ExcludedFolders
Set-TenuVaultAutomationVariable -Name "TenuVaultAppOnlyExcluded-$tenantKey" -Value $appOnlyExcluded
if ($changeReportPassed) { Set-TenuVaultAutomationVariable -Name "TenuVaultChangeReport-$tenantKey" -Value $ChangeReport.ToLowerInvariant() }
if ($tenantNamePassed) {
    # Cleared to the tenant id, never to an empty value, which the runbook would skip for an
    # unscoped TenuVaultTenantName variable. At most 200 characters, like the app passes it.
    $savedName = if ("$TenantName".Trim()) { "$TenantName".Trim() } else { $TenantId }
    if ($savedName.Length -gt 200) {
        # Never cut between the two halves of a surrogate pair.
        $cut = if ([char]::IsHighSurrogate($savedName[199])) { 199 } else { 200 }
        $savedName = $savedName.Substring(0, $cut).TrimEnd()
    }
    Set-TenuVaultAutomationVariable -Name "TenuVaultTenantName-$tenantKey" -Value $savedName
}
if ($changeReportActorsPassed) { Set-TenuVaultAutomationVariable -Name "TenuVaultChangeReportActors-$tenantKey" -Value $(if ($ChangeReportWithoutActors) { "false" } else { "true" }) }

# Upgrade from a setup before runbook 1.2.0: name the old Key Vault, then drop its variable once
# the published runbook was read back as one that no longer reads it.
$legacyKeyVaults = Get-TenuVaultLegacyKeyVaults
Remove-TenuVaultLegacyKeyVaultVariable -Runbook $runbook

# ---------------------------------------------------------------------------
# Failure alert, before the schedule is linked (same rule as the watcher).
# ---------------------------------------------------------------------------

$alertStatus = $null
if ($NoFailureAlert) { $alertStatus = "disabled by -NoFailureAlert (no Azure Monitor alert will fire)" }
if ($AlertEmail) {
    $actionGroupName = "ag-tenuvault-cloudbackup"
    $metricAlertName = "TenuVault cloud backup failed jobs"
    if (-not (Get-Command Invoke-AzRestMethod -ErrorAction SilentlyContinue)) {
        throw "Invoke-AzRestMethod is not available, so the failure alert for $AlertEmail cannot be created. Install or update Az.Accounts, or pass -NoFailureAlert. The schedule was not linked."
    }
    if ($WhatIfPreference) {
        $alertStatus = "would be created for $AlertEmail (WhatIf: no changes were made)"
    } elseif ($PSCmdlet.ShouldProcess($metricAlertName, "Create failure alert for $AlertEmail")) {
        try {
            $aaResource = Get-AzResource -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName `
                -ResourceType "Microsoft.Automation/automationAccounts" -ErrorAction Stop
            $actionGroupId = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$ResourceGroupName/providers/microsoft.insights/actionGroups/$actionGroupName"
            $actionGroupPayload = @{
                location = "Global"
                properties = @{
                    groupShortName = "tenuvault"
                    enabled = $true
                    emailReceivers = @(@{ name = "TenuVaultAdmins"; emailAddress = $AlertEmail; useCommonAlertSchema = $true })
                }
            } | ConvertTo-Json -Depth 10
            [void](Invoke-AzRestMethod -Method Put -Path "$actionGroupId`?api-version=2023-01-01" -Payload $actionGroupPayload)
            $metricAlertPayload = @{
                location = "global"
                properties = @{
                    description = "TenuVault cloud backup Automation jobs are failing."
                    severity = 3
                    enabled = $true
                    scopes = @($aaResource.ResourceId)
                    evaluationFrequency = "PT15M"
                    windowSize = "PT1H"
                    targetResourceType = "Microsoft.Automation/automationAccounts"
                    targetResourceRegion = $Location
                    criteria = @{
                        "odata.type" = "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria"
                        allOf = @(@{
                            name = "FailedJobs"; metricName = "TotalJob"
                            metricNamespace = "Microsoft.Automation/automationAccounts"
                            operator = "GreaterThan"; threshold = 0; timeAggregation = "Total"
                            dimensions = @(@{ name = "Status"; operator = "Include"; values = @("Failed") })
                            criterionType = "StaticThresholdCriterion"
                        })
                    }
                    actions = @(@{ actionGroupId = $actionGroupId })
                }
            } | ConvertTo-Json -Depth 12
            $metricAlertId = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$ResourceGroupName/providers/microsoft.insights/metricAlerts/$([uri]::EscapeDataString($metricAlertName))"
            [void](Invoke-AzRestMethod -Method Put -Path "$metricAlertId`?api-version=2018-03-01" -Payload $metricAlertPayload)
            $alertStatus = "action group '$actionGroupName' and metric alert '$metricAlertName' in place for $AlertEmail"
        } catch {
            throw "Creating the failure alert for $AlertEmail failed, so the schedule was not linked. Fix the cause and run this script again, or pass -NoFailureAlert. Cause: $($_.Exception.Message)"
        }
    }
}

# ---------------------------------------------------------------------------
# Graph application roles, the part Azure RBAC cannot grant. Without them the
# schedule stays unlinked, because every run would fail the same way.
# ---------------------------------------------------------------------------

$consentReceipt = $null
if ($GrantGraphRoles) {
    if (-not $principalId) { throw "Cannot grant Graph roles: the managed identity principal id is unknown." }
    if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
        Write-Host "Installing Microsoft.Graph.Authentication for the current user..."
        Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module Microsoft.Graph.Authentication
    Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All", "Application.Read.All" -TenantId $TenantId -NoWelcome
    $mgContext = Get-MgContext
    $graphSpUri = "https://graph.microsoft.com/v1.0/servicePrincipals?%24filter=$([uri]::EscapeDataString("appId eq '00000003-0000-0000-c000-000000000000'"))"
    $graphSp = @((Invoke-MgGraphRequest -Method Get -Uri $graphSpUri).value) | Select-Object -First 1
    if (-not $graphSp) { throw "The Microsoft Graph service principal was not found in tenant $TenantId." }
    $assignmentsUri = "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments"
    $existingAssignments = @((Invoke-MgGraphRequest -Method Get -Uri $assignmentsUri).value)
    foreach ($roleName in $graphRoleNames) {
        $role = @($graphSp.appRoles) | Where-Object { $_.value -eq $roleName -and @($_.allowedMemberTypes) -contains "Application" } | Select-Object -First 1
        if (-not $role) { throw "Graph application role '$roleName' was not found on the Microsoft Graph service principal." }
        $already = @($existingAssignments | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graphSp.id }).Count -gt 0
        if ($already) {
            Write-Host "Graph role '$roleName' is already assigned."
        } elseif ($PSCmdlet.ShouldProcess($principalId, "Assign Graph role '$roleName'")) {
            $body = @{ principalId = $principalId; resourceId = $graphSp.id; appRoleId = $role.id } | ConvertTo-Json -Compress
            Invoke-MgGraphRequest -Method Post -Uri $assignmentsUri -Body $body -ContentType "application/json" | Out-Null
            Write-Host "Graph role '$roleName' assigned."
        }
    }
    $consentReceipt = [pscustomobject][ordered]@{
        Actor = $mgContext.Account; TenantId = $TenantId; PrincipalId = $principalId
        Roles = $graphRoleNames
        Timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    }
}

# ---------------------------------------------------------------------------
# Schedule and link. Automation schedules cannot be edited in place, so a
# changed time or frequency replaces the schedule and its link.
# ---------------------------------------------------------------------------

$linked = $false
if ($GrantGraphRoles -or $GraphRolesGranted) {
    $tz = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZone)
    $nowLocal = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
    $hour, $minute = $Time -split ":"
    $next = [DateTime]::new($nowLocal.Year, $nowLocal.Month, $nowLocal.Day, [int]$hour, [int]$minute, 0)
    if ($Frequency -eq "Weekly") {
        while ($next.DayOfWeek -ne $WeekDay -or $next -le $nowLocal.AddMinutes(10)) { $next = $next.AddDays(1) }
    } elseif ($next -le $nowLocal.AddMinutes(10)) { $next = $next.AddDays(1) }
    $startTime = [DateTimeOffset]::new($next, $tz.GetUtcOffset($next))

    $existingSchedule = Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction SilentlyContinue
    if ($existingSchedule -and $PSCmdlet.ShouldProcess($scheduleName, "Replace schedule")) {
        try {
            Unregister-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
                -ScheduleName $scheduleName -Force -ErrorAction Stop | Out-Null
        } catch { }
        Remove-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName -Force | Out-Null
        $existingSchedule = $null
    }
    if (-not $existingSchedule) {
        Write-Host "Creating schedule '$scheduleName' ($Frequency at $Time $TimeZone, first run $($startTime.ToString('u')))..."
        if ($PSCmdlet.ShouldProcess($scheduleName, "Create schedule")) {
            $scheduleParams = @{
                ResourceGroupName = $ResourceGroupName; AutomationAccountName = $AutomationAccountName
                Name = $scheduleName; StartTime = $startTime; TimeZone = $TimeZone
            }
            if ($Frequency -eq "Daily") { $scheduleParams.DayInterval = 1 }
            else { $scheduleParams.WeekInterval = 1; $scheduleParams.DaysOfWeek = @($WeekDay) }
            [void](New-AzAutomationSchedule @scheduleParams)
        }
    }
    if ($PSCmdlet.ShouldProcess($runbookName, "Link runbook to schedule '$scheduleName'")) {
        Register-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName -Parameters @{ TenantKey = $tenantKey } | Out-Null
        $linked = $true
    }
}

# ---------------------------------------------------------------------------
# Summary and next steps. The block between the markers is read by the desktop
# app when an admin pastes this output back into the cloud setup step.
# ---------------------------------------------------------------------------

Write-Host ""
if ($WhatIfPreference) {
    Write-Host "What if: no changes were made by guarded operations." -ForegroundColor Yellow
} else {
    Write-Host "Done. TenuVault cloud backups for this tenant:" -ForegroundColor Green
}
Write-Host "  Automation account:  $AutomationAccountName (resource group $ResourceGroupName, $Location)"
Write-Host "  Runbook:             $runbookName ($(if ($runbook.Plain) { "published, version $($runbook.Version)" } else { $runbook.Reason }))"
Write-Host "  Storage account:     $StorageAccountName (container '$backupContainer', writer role has no delete)"
Write-Host "  Backup results:      '$outcomeContainer' (result notes for the notification watcher, same writer role)"
Write-Host "  Encryption:          Azure encryption at rest; backups are plain JSON, readable by whoever your role assignments allow"
$changeReportSummary = if (-not $changeReportPassed) { "unchanged (as an earlier setup chose; off when none did)" } else { switch ($ChangeReport) { 'Off' { 'off' } 'Names' { 'names only, sent by the notification watcher' } default { 'with setting values, sent by the notification watcher' } } }
if ($changeReportActorsPassed) { $changeReportSummary += $(if ($ChangeReportWithoutActors) { ', without who made each change' } else { ', naming who made each change' }) }
Write-Host "  Change reports:      $changeReportSummary"
if ($principalId) { Write-Host "  Managed identity:    $principalId" }
if ($alertStatus) { Write-Host "  Failure alert:       $alertStatus" }
Write-Host "  Schedule:            $(if ($linked) { "$Frequency at $Time $TimeZone ('$scheduleName')" } else { 'not linked yet' })"
Write-Host "  Scope:               $(if ($ExcludedFolders) { "custom, leaving out $ExcludedFolders" } else { $Scope })$(if ($appOnlyExcluded) { "; cloud backups leave out $appOnlyExcluded (no device inventory permission)" })"

if ($consentReceipt) {
    Write-Host ""
    Write-Host "Consent receipt (keep with your change record):"
    Write-Host "  Actor:      $($consentReceipt.Actor)"
    Write-Host "  Tenant:     $($consentReceipt.TenantId)"
    Write-Host "  Principal:  $($consentReceipt.PrincipalId)"
    Write-Host "  Roles:      $($consentReceipt.Roles -join ', ')"
    Write-Host "  Timestamp:  $($consentReceipt.Timestamp)"
}

if (-not $linked) {
    Write-Host ""
    Write-Host "Graph roles were not granted by this run, so the schedule is not linked yet." -ForegroundColor Yellow
    Write-Host "A Global Administrator must assign these Microsoft Graph application roles to the" -ForegroundColor Yellow
    Write-Host "Automation account's managed identity, then run this script again with -GraphRolesGranted," -ForegroundColor Yellow
    Write-Host "or run it with -GrantGraphRoles as a Global Administrator:" -ForegroundColor Yellow
    foreach ($role in $graphRoleNames) { Write-Host "  * $role" -ForegroundColor Yellow }
} else {
    Write-TenuVaultTestRunHint -Runbook $runbook
}

Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults -KeptBecause $runbook.Reason

Write-Host ""
Write-Host "--- TenuVault cloud backup setup (paste into TenuVault) ---"
Write-Host "tenantId=$TenantId"
Write-Host "subscriptionId=$($context.Subscription.Id)"
Write-Host "resourceGroup=$ResourceGroupName"
Write-Host "automationAccount=$AutomationAccountName"
Write-Host "storageAccount=$StorageAccountName"
Write-Host "scheduleName=$scheduleName"
Write-Host "frequency=$($Frequency.ToLowerInvariant())"
Write-Host "time=$Time"
Write-Host "weekDay=$WeekDay"
Write-Host "timeZone=$TimeZone"
Write-Host "tenantKey=$tenantKey"
Write-Host "linked=$($linked.ToString().ToLowerInvariant())"
Write-Host "--- End of TenuVault cloud backup setup ---"


