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
      * writes the tenant's configuration as Automation variables with a per tenant suffix, so one
        Automation account can back up several tenants, each with its own schedule
      * creates an Azure Key Vault (RBAC), stores the TenuVault backup recovery key as the secret
        "tenuvault-recovery-key" (you paste it at a hidden prompt; it is never printed or taken as
        a parameter), and lets the managed identity read only that vault's secrets
      * creates the intune-backups container when missing and gives the identity the custom role
        "TenuVault Backup Writer" on that container only: read and write blobs, no delete. The
        runbook therefore cannot remove backups; retention runs on the next desktop backup made
        with an admin's sign-in, or through a storage lifecycle rule
      * links the runbook to a daily or weekly schedule in the timezone you choose
      * with -AlertEmail, creates an Azure Monitor action group and a metric alert on failed
        Automation jobs, before the schedule is linked. Without it, -NoFailureAlert is the
        explicit opt out. Setup refuses to guess: a backup that fails silently is worse than none.

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
    variables, and lists what stays behind on purpose (Automation account, Key Vault, roles,
    backups) and what to revoke by hand.

    Needs Az.Accounts, Az.Resources, Az.Automation, Az.Storage and Az.KeyVault, plus an account
    that can create Automation accounts, Key Vaults and role assignments (Owner, or Contributor
    plus User Access Administrator, on the resource group).

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

.PARAMETER GrantGraphRoles
    Assign the Graph application roles to the managed identity now. Needs Global Administrator.

.PARAMETER GraphRolesGranted
    Say that a Global Administrator already assigned the roles listed by an earlier run, so the
    schedule can be linked.

.PARAMETER Remove
    Remove this tenant's schedule link, schedule and variables, then list the rest.

.EXAMPLE
    ./New-TenuVaultCloudBackup.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -StorageAccountName tvbkp1234567890ab -Location westeurope -TimeZone Europe/Berlin -Time 02:00 -AlertEmail ops@contoso.com -GrantGraphRoles
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$StorageAccountName,
    [string]$SubscriptionId,
    [string]$ResourceGroupName = "rg-tenuvault-backups",
    [string]$Location,
    [string]$AutomationAccountName = "aa-tenuvault",
    [string]$KeyVaultName,
    [ValidateSet("Daily", "Weekly")][string]$Frequency = "Daily",
    [string]$Time = "02:00",
    [DayOfWeek]$WeekDay = [DayOfWeek]::Sunday,
    [string]$TimeZone = "UTC",
    [ValidateSet("everything", "policies")][string]$Scope = "policies",
    [string]$ExcludedFolders,
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
$runbookPath = Join-Path $PSScriptRoot "runbooks/Invoke-TenuVaultBackup.ps1"
$tenantKey = $TenantId.Substring(0, [Math]::Min(8, $TenantId.Length)).ToLowerInvariant()
$scheduleName = "TenuVaultBackup-$tenantKey"
$secretName = "tenuvault-recovery-key"
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
    "TenuVaultTenantId-$tenantKey", "TenuVaultStorageAccount-$tenantKey", "TenuVaultKeyVault-$tenantKey",
    "TenuVaultScope-$tenantKey", "TenuVaultExcludedFolders-$tenantKey", "TenuVaultAppOnlyExcluded-$tenantKey"
)

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

foreach ($module in "Az.Accounts", "Az.Resources", "Az.Automation", "Az.Storage", "Az.KeyVault") {
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
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][string]$Target
    )
    $existing = Get-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleName -Scope $Scope |
        Where-Object { $_.Scope -eq $Scope }
    if ($existing) {
        Write-Host "$Target already has '$RoleName'."
    } elseif ($PSCmdlet.ShouldProcess($Scope, "Assign '$RoleName' to $Target")) {
        Write-Host "Assigning '$RoleName' to $Target..."
        New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionName $RoleName -Scope $Scope | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Remove mode: this tenant's schedule link, schedule and variables go away. The
# account, vault, roles and backups stay, because another tenant may use them.
# ---------------------------------------------------------------------------

if ($Remove) {
    $account = Get-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName -ErrorAction SilentlyContinue
    if (-not $account) {
        Write-Host "Automation account '$AutomationAccountName' was not found in '$ResourceGroupName'. Nothing to remove."
        return
    }
    $principalId = Get-TenuVaultAutomationPrincipalId
    try {
        Unregister-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName -Force -ErrorAction Stop | Out-Null
    } catch { }
    $schedule = Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction SilentlyContinue
    if ($schedule -and $PSCmdlet.ShouldProcess($scheduleName, "Remove schedule")) {
        Remove-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName -Force | Out-Null
    }
    foreach ($name in $variableNames) {
        $variable = Get-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $name -ErrorAction SilentlyContinue
        if ($variable -and $PSCmdlet.ShouldProcess($name, "Remove Automation variable")) {
            Remove-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -Name $name | Out-Null
        }
    }
    Write-Host ""
    Write-Host "Cloud backup schedule and variables for tenant $TenantId removed." -ForegroundColor Green
    Write-Host "Left in place on purpose: Automation account '$AutomationAccountName' and runbook '$runbookName'"
    Write-Host "(other tenants may use them), the Key Vault and its '$secretName' secret, storage account"
    Write-Host "'$StorageAccountName' with every backup, and the role assignments."
    Write-Host "When the Automation account is no longer used by any tenant, revoke these Graph roles"
    Write-Host "from its managed identity (Entra ID > Enterprise applications > Permissions):"
    foreach ($role in $graphRoleNames) { Write-Host "  * $role" }
    if ($principalId) { Write-Host "Managed identity object (principal) id: $principalId" }
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

$storageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue
if (-not $storageAccount) {
    $storageAccount = Get-AzStorageAccount -ErrorAction SilentlyContinue | Where-Object { $_.StorageAccountName -eq $StorageAccountName } | Select-Object -First 1
}
if (-not $storageAccount) {
    throw "Storage account '$StorageAccountName' was not found in this subscription. Create it first, for example with New-TenuVaultStorage.ps1."
}

$storageContext = New-AzStorageContext -StorageAccountName $StorageAccountName -UseConnectedAccount
$container = Get-AzStorageContainer -Name $backupContainer -Context $storageContext -ErrorAction SilentlyContinue
if (-not $container) {
    Write-Host "Creating container '$backupContainer'..."
    if ($PSCmdlet.ShouldProcess($backupContainer, "Create storage container")) {
        New-AzStorageContainer -Name $backupContainer -Context $storageContext -Permission Off | Out-Null
    }
}

if ($principalId) {
    $groupScope = $resourceGroup.ResourceId
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
            $definition.Actions = @()
            $definition.DataActions = $dataActions
            $definition.AssignableScopes = @($groupScope)
            $role = New-AzRoleDefinition -Role $definition
        }
    } else {
        $extra = @($role.DataActions | Where-Object { $dataActions -notcontains $_ }) + @($role.Actions)
        if ($extra) { throw "The existing role '$writerRoleName' allows more than writing backups ($($extra -join ', ')). Remove those permissions or delete the role, then run the script again." }
        if ($role.AssignableScopes -notcontains $groupScope -and $PSCmdlet.ShouldProcess($writerRoleName, "Allow assignments in $ResourceGroupName")) {
            $role.AssignableScopes.Add($groupScope)
            $role = Set-AzRoleDefinition -Role $role
        }
    }
    if ($role) {
        Add-TenuVaultRoleAssignment -ObjectId $principalId -RoleName $writerRoleName `
            -Scope "$($storageAccount.Id)/blobServices/default/containers/$backupContainer" -Target "the cloud backup identity"
    }
}

# ---------------------------------------------------------------------------
# Key Vault: the recovery key the runbook seals backups with
# ---------------------------------------------------------------------------

if (-not $KeyVaultName) {
    $suffix = ([Guid]::NewGuid().ToString("N")).Substring(0, 6)
    $existingVault = Get-AzKeyVault -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue |
        Where-Object { $_.VaultName -like "kv-tenuvault-*" } | Select-Object -First 1
    $KeyVaultName = if ($existingVault) { $existingVault.VaultName } else { "kv-tenuvault-$suffix" }
}
$vault = Get-AzKeyVault -VaultName $KeyVaultName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
if (-not $vault) {
    Write-Host "Creating Key Vault '$KeyVaultName' (RBAC authorization, soft delete)..."
    if ($PSCmdlet.ShouldProcess($KeyVaultName, "Create Key Vault")) {
        $vault = New-AzKeyVault -VaultName $KeyVaultName -ResourceGroupName $ResourceGroupName `
            -Location $Location -EnableRbacAuthorization -SoftDeleteRetentionInDays 30
    }
}
if ($vault) {
    $currentUserId = (Get-AzADUser -SignedIn -ErrorAction SilentlyContinue).Id
    if ($currentUserId) {
        Add-TenuVaultRoleAssignment -ObjectId $currentUserId -RoleName "Key Vault Secrets Officer" -Scope $vault.ResourceId -Target "you"
    }
    if ($principalId) {
        Add-TenuVaultRoleAssignment -ObjectId $principalId -RoleName "Key Vault Secrets User" -Scope $vault.ResourceId -Target "the cloud backup identity"
    }
    $existingSecret = Get-AzKeyVaultSecret -VaultName $KeyVaultName -Name $secretName -ErrorAction SilentlyContinue
    if (-not $existingSecret -and -not $WhatIfPreference) {
        Write-Host "Paste the tenant's TenuVault backup recovery key (Settings > Storage and recovery >"
        Write-Host "Save recovery key in the desktop app). It is stored as the Key Vault secret"
        Write-Host "'$secretName' and never printed. Anyone who can read this secret can read every"
        Write-Host "backup in the storage account, so keep the vault's roles as set by this script."
        $secure = Read-Host "Recovery key (TVK2...)" -AsSecureString
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        if ($plain.Trim() -notmatch '^TVK[12]\.[A-Za-z0-9_.-]+$') {
            throw "That is not a TenuVault recovery key (expected TVK2. or TVK1.). Nothing was stored. Run the script again."
        }
        if ($PSCmdlet.ShouldProcess($secretName, "Store the recovery key in Key Vault")) {
            Set-AzKeyVaultSecret -VaultName $KeyVaultName -Name $secretName -SecretValue (ConvertTo-SecureString $plain.Trim() -AsPlainText -Force) | Out-Null
            Write-Host "Recovery key stored. New role assignments can take a few minutes to apply."
        }
        $plain = $null
    } else {
        Write-Host "Key Vault secret '$secretName' already exists; keeping it."
    }
}

# ---------------------------------------------------------------------------
# Runbook import and publish. A rerun is the upgrade path.
# ---------------------------------------------------------------------------

if ($PSCmdlet.ShouldProcess($runbookName, "Import and publish runbook")) {
    Write-Host "Importing runbook '$runbookName'..."
    Import-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName `
        -Path $runbookPath -Type PowerShell72 -Description "TenuVault scheduled Intune backup in Azure" -Force | Out-Null
    Publish-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName | Out-Null
}

Write-Host "Writing Automation variables for this tenant (suffix -$tenantKey)..."
Set-TenuVaultAutomationVariable -Name "TenuVaultTenantId-$tenantKey" -Value $TenantId
Set-TenuVaultAutomationVariable -Name "TenuVaultStorageAccount-$tenantKey" -Value $StorageAccountName
Set-TenuVaultAutomationVariable -Name "TenuVaultKeyVault-$tenantKey" -Value $KeyVaultName
Set-TenuVaultAutomationVariable -Name "TenuVaultScope-$tenantKey" -Value $Scope
Set-TenuVaultAutomationVariable -Name "TenuVaultExcludedFolders-$tenantKey" -Value $ExcludedFolders
Set-TenuVaultAutomationVariable -Name "TenuVaultAppOnlyExcluded-$tenantKey" -Value $appOnlyExcluded

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
Write-Host "  Runbook:             $runbookName (published)"
Write-Host "  Storage account:     $StorageAccountName (container '$backupContainer', writer role has no delete)"
Write-Host "  Key Vault:           $KeyVaultName (secret '$secretName')"
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
    Write-Host ""
    Write-Host "Test it now instead of waiting for the first night: in the Azure portal open the"
    Write-Host "Automation account, Runbooks > $runbookName > Start, set TENANTKEY to $tenantKey, and"
    Write-Host "watch the job output. The backup then appears in TenuVault under Backup History."
}

Write-Host ""
Write-Host "--- TenuVault cloud backup setup (paste into TenuVault) ---"
Write-Host "tenantId=$TenantId"
Write-Host "subscriptionId=$($context.Subscription.Id)"
Write-Host "resourceGroup=$ResourceGroupName"
Write-Host "automationAccount=$AutomationAccountName"
Write-Host "storageAccount=$StorageAccountName"
Write-Host "keyVault=$KeyVaultName"
Write-Host "scheduleName=$scheduleName"
Write-Host "frequency=$($Frequency.ToLowerInvariant())"
Write-Host "time=$Time"
Write-Host "weekDay=$WeekDay"
Write-Host "timeZone=$TimeZone"
Write-Host "tenantKey=$tenantKey"
Write-Host "linked=$($linked.ToString().ToLowerInvariant())"
Write-Host "--- End of TenuVault cloud backup setup ---"


