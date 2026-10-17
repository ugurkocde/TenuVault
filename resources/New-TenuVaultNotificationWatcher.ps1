<#
.SYNOPSIS
    Creates the Azure Automation watcher that sends TenuVault notifications when the
    desktop app is closed.

.DESCRIPTION
    Run this script as an Azure administrator. The script:

      * creates or reuses a resource group and an Azure Automation account with a
        system assigned managed identity
      * imports the sibling runbook runbooks/Invoke-TenuVaultNotificationCheck.ps1
        and publishes it (running the script again upgrades the published runbook)
      * creates the tenuvault-notification-state container in the backup storage
        account for watcher state and heartbeat blobs
      * grants the managed identity "Storage Blob Data Reader" on the intune-backups
        container only, and "Storage Blob Data Contributor" on the
        tenuvault-notification-state container only
      * writes the TenuVault configuration values as Automation variables, with the
        webhook URL, webhook secret and Teams URL stored encrypted when provided
      * links the runbook to a recurring schedule (hourly by default)
      * with -GrantGraphRoles, also assigns the Microsoft Graph application roles
        the identity needs (DeviceManagementApps.Read.All, plus Mail.Send with
        -IncludeMailSend) and prints a consent receipt. No group read role is
        granted: the runbook never resolves groups, mail recipients are plain
        addresses

    Without -GrantGraphRoles a Global Administrator must assign those Graph roles to
    the managed identity before the watcher can read audit events. The script prints
    the exact roles either way.

    Running the script again with the same parameters changes nothing that already
    matches, except that the runbook draft is refreshed from the sibling file and
    published again, which is how watcher upgrades ship.

    With -Remove the script deletes the schedule link, the schedule, the runbook and
    the Automation variables, and lists the Graph application roles to revoke by
    hand. The Automation account, the storage account and the state container are
    left in place.

    The script needs Az.Accounts, Az.Resources, Az.Automation and Az.Storage, plus an
    account that can create Automation accounts and assign roles (for example Owner,
    or Contributor plus User Access Administrator on the resource group).
    -GrantGraphRoles additionally needs Microsoft.Graph.Authentication and a Global
    Administrator account.

.PARAMETER TenantId
    Entra tenant id (GUID) the watcher reports on. Stored in the Automation variable
    TenuVaultTenantId. The runbook refuses to run when its saved state belongs to
    another tenant.

.PARAMETER StorageAccountName
    The storage account that holds the intune-backups container (see
    New-TenuVaultStorage.ps1). The state container is created in the same account.

.PARAMETER SubscriptionId
    Subscription to create the resources in. Defaults to the current Az context.

.PARAMETER ResourceGroupName
    Resource group for the Automation account, created when missing.
    Default: "rg-tenuvault-backups".

.PARAMETER Location
    Azure region, required when the resource group or the Automation account is
    created. An existing resource group keeps its region.

.PARAMETER AutomationAccountName
    Name of the Automation account. Default: "aa-tenuvault-notifications".

.PARAMETER TenantName
    Optional friendly tenant name shown in notification titles.

.PARAMETER ScheduleIntervalHours
    How often the watcher runs, in hours. Default: 1.

.PARAMETER WebhookUrl
    Optional https URL that receives the canonical JSON envelope per event. Stored
    as an encrypted Automation variable.

.PARAMETER WebhookSecret
    Optional shared secret. When set, deliveries carry an HMAC SHA256 signature in
    the X-TenuVault-Signature header with the signing time in
    X-TenuVault-Timestamp. Stored as an encrypted Automation variable.

.PARAMETER TeamsWebhookUrl
    Optional Teams Workflows webhook URL that receives an Adaptive Card per event.
    Stored as an encrypted Automation variable.

.PARAMETER MailSender
    Optional mailbox the watcher sends mail from, with Mail.Send granted through
    -IncludeMailSend. Restrict that role to this mailbox with an Exchange
    application access policy afterwards, then run the runbook once with
    -VerifyMailOnly to unlock mail delivery.

.PARAMETER MailRecipients
    Optional mail recipients for notification mail.

.PARAMETER MailProbeMailbox
    Optional mailbox outside the Exchange application access policy scope. The
    -VerifyMailOnly run must fail to send as this mailbox, which proves Mail.Send
    is restricted to -MailSender.

.PARAMETER AlertEmail
    Email address for failure alerting. When set, an Azure Monitor action group
    with this receiver and a metric alert for failed Automation jobs are created
    or updated through ARM REST calls, before the schedule is linked. When alert
    creation fails the script stops: the watcher does not run on a schedule
    without its failure alert. One of -AlertEmail or -NoFailureAlert is
    required: without either the script stops before writing anything, because
    a watcher that fails silently is worse than no watcher.

.PARAMETER NoFailureAlert
    Explicitly accept having no Azure Monitor failure alert for the watcher.
    Failed scheduled runs will then only be visible in the Automation job list
    and in a stale heartbeat.json inside the state container.

.PARAMETER MissedBackupHours
    Emit a backup.missed event when the newest backup folder is older than this
    many hours. Default: 48.

.PARAMETER IncludeActor
    Include the actor UPN of Intune changes in digests. Off by default: actor names
    are personal data and most channels are read by a wider group than Intune
    admins.

.PARAMETER GrantGraphRoles
    Assign the Graph application roles to the managed identity now (needs Global
    Administrator) and print a consent receipt.

.PARAMETER IncludeMailSend
    With -GrantGraphRoles, also assign Mail.Send so the watcher can send mail from
    -MailSender. Requires -MailSender and -MailRecipients: the script stops before
    granting anything when either is missing.

.PARAMETER Remove
    Remove the schedule link, schedule, runbook and Automation variables, then list
    the Graph application roles to revoke manually.

.EXAMPLE
    ./New-TenuVaultNotificationWatcher.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -StorageAccountName tvbkp1234567890ab -Location westeurope -TeamsWebhookUrl "https://..." -AlertEmail ops@contoso.com

.EXAMPLE
    ./New-TenuVaultNotificationWatcher.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -StorageAccountName tvbkp1234567890ab -GrantGraphRoles -IncludeMailSend -MailSender tenuvault@contoso.com -MailRecipients ops@contoso.com -AlertEmail ops@contoso.com
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$StorageAccountName,
    [string]$SubscriptionId,
    [string]$ResourceGroupName = "rg-tenuvault-backups",
    [string]$Location,
    [string]$AutomationAccountName = "aa-tenuvault-notifications",
    [string]$TenantName,
    [ValidateRange(1, 168)][int]$ScheduleIntervalHours = 1,
    [string]$WebhookUrl,
    [string]$WebhookSecret,
    [string]$TeamsWebhookUrl,
    [string]$MailSender,
    [string[]]$MailRecipients,
    [string]$MailProbeMailbox,
    [string]$AlertEmail,
    [switch]$NoFailureAlert,
    [ValidateRange(1, 8760)][int]$MissedBackupHours = 48,
    [switch]$IncludeActor,
    [switch]$GrantGraphRoles,
    [switch]$IncludeMailSend,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$runbookName = "Invoke-TenuVaultNotificationCheck"
$scheduleName = "TenuVaultNotificationCheck"
$stateContainer = "tenuvault-notification-state"
$backupContainer = "intune-backups"
$runbookPath = Join-Path $PSScriptRoot "runbooks/Invoke-TenuVaultNotificationCheck.ps1"

$automationVariableNames = @(
    "TenuVaultTenantId", "TenuVaultTenantName", "TenuVaultStorageAccount",
    "TenuVaultWebhookUrl", "TenuVaultWebhookSecret", "TenuVaultTeamsWebhookUrl",
    "TenuVaultMailSender", "TenuVaultMailRecipients", "TenuVaultMailProbeMailbox",
    "TenuVaultMissedBackupHours", "TenuVaultIncludeActor", "TenuVaultConfigVersion"
)

$graphRoleNames = @("DeviceManagementApps.Read.All")
if ($IncludeMailSend) { $graphRoleNames += "Mail.Send" }

# Validate every input before the first Azure write, so a typo cannot leave a half
# configured watcher behind.
if ($TenantId -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    throw "'$TenantId' is not a tenant id. Pass the tenant (directory) id GUID."
}
if ($StorageAccountName -notmatch '^[a-z0-9]{3,24}$') {
    throw "Storage account name '$StorageAccountName' is invalid: use 3 to 24 lower case letters and digits."
}
foreach ($pair in @(@("WebhookUrl", $WebhookUrl), @("TeamsWebhookUrl", $TeamsWebhookUrl))) {
    if ($pair[1] -and $pair[1] -notmatch "^https://") {
        throw "-$($pair[0]) must use https. Notification deliveries carry tenant names and change summaries."
    }
}
if ($MailSender -and $MailSender -notmatch "^[^@\s]+@[^@\s]+$") {
    throw "-MailSender '$MailSender' is not an email address or user principal name."
}
foreach ($recipient in $MailRecipients) {
    if ($recipient -notmatch "^[^@\s]+@[^@\s]+$") {
        throw "-MailRecipients entry '$recipient' is not an email address."
    }
}
if ($MailProbeMailbox -and $MailProbeMailbox -notmatch "^[^@\s]+@[^@\s]+$") {
    throw "-MailProbeMailbox '$MailProbeMailbox' is not an email address or user principal name."
}
if ($AlertEmail -and $AlertEmail -notmatch "^[^@\s]+@[^@\s]+$") {
    throw "-AlertEmail '$AlertEmail' is not an email address."
}
if ($IncludeMailSend -and (-not $MailSender -or -not $MailRecipients)) {
    throw "-IncludeMailSend requires -MailSender and -MailRecipients. Refusing to grant Mail.Send without a named sender mailbox and recipients."
}
if ($AlertEmail -and $NoFailureAlert) {
    throw "-AlertEmail and -NoFailureAlert contradict each other. Pass only one of them."
}
if (-not $Remove -and -not $AlertEmail -and -not $NoFailureAlert) {
    throw "Decide how failed watcher runs will be noticed before anything is created: pass -AlertEmail <address> to create an Azure Monitor failure alert, or -NoFailureAlert to explicitly accept that failed runs are only visible in the Automation job list and a stale heartbeat. Nothing was written."
}
if ((-not $Remove) -and -not (Test-Path $runbookPath)) {
    throw "Runbook file not found: $runbookPath. Keep this script next to the runbooks folder from the TenuVault release."
}
if ($IncludeMailSend -and -not $GrantGraphRoles) {
    Write-Warning "-IncludeMailSend only applies with -GrantGraphRoles. Mail.Send must be assigned to the managed identity before mail delivery works."
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

# The watcher identity, state and consent would land in the wrong directory if the
# signed in context is another tenant than the one being configured. Stop before
# any resource write in that case.
if ($TenantId -match '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    $contextTenantId = [string]$context.Tenant.Id
    if ($contextTenantId.ToLowerInvariant() -ne $TenantId.ToLowerInvariant()) {
        throw "The current Az context tenant is '$(if ($contextTenantId) { $contextTenantId } else { '<empty>' })', but -TenantId is $TenantId. An empty context tenant counts as a mismatch. Run Connect-AzAccount -Tenant $TenantId (and select the right subscription), then run this script again. Nothing was written."
    }
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

# ---------------------------------------------------------------------------
# Remove mode: schedule link, schedule, runbook and variables go away. The
# Automation account, storage and saved state stay, and Graph roles are listed for
# manual revocation because deleting consent is a deliberate admin action.
# ---------------------------------------------------------------------------

if ($Remove) {
    $account = Get-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName -ErrorAction SilentlyContinue
    if (-not $account) {
        Write-Host "Automation account '$AutomationAccountName' was not found in '$ResourceGroupName'. Nothing to remove."
        return
    }
    $principalId = Get-TenuVaultAutomationPrincipalId

    Write-Host "Removing the schedule link and schedule..."
    $linked = $null
    try {
        $linked = Get-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName -ErrorAction Stop
    } catch { $linked = $null }
    if ($linked -and $PSCmdlet.ShouldProcess($scheduleName, "Unregister scheduled runbook")) {
        Unregister-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName -Force | Out-Null
    }
    $schedule = Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction SilentlyContinue
    if ($schedule -and $PSCmdlet.ShouldProcess($scheduleName, "Remove schedule")) {
        Remove-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName -Force | Out-Null
    }

    Write-Host "Removing the runbook..."
    $existingRunbook = Get-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName -ErrorAction SilentlyContinue
    if ($existingRunbook -and $PSCmdlet.ShouldProcess($runbookName, "Remove runbook")) {
        Remove-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $runbookName -Force | Out-Null
    }

    Write-Host "Removing the Automation variables..."
    foreach ($name in $automationVariableNames) {
        $variable = Get-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $name -ErrorAction SilentlyContinue
        if ($variable -and $PSCmdlet.ShouldProcess($name, "Remove Automation variable")) {
            Remove-AzAutomationVariable -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -Name $name | Out-Null
        }
    }

    Write-Host ""
    Write-Host "Watcher schedule, runbook and variables removed." -ForegroundColor Green
    Write-Host "Left in place on purpose: Automation account '$AutomationAccountName', storage account"
    Write-Host "'$StorageAccountName' and the '$stateContainer' state container with state.json and"
    Write-Host "heartbeat.json. Delete them in the portal when the history is no longer needed."
    Write-Host ""
    Write-Host "Revoke these Microsoft Graph application roles from the managed identity manually"
    Write-Host "(Entra ID > Enterprise applications > the Automation account identity > Permissions):"
    foreach ($role in $graphRoleNames) { Write-Host "  * $role" }
    Write-Host "Also check for Mail.Send when an earlier run granted it."
    if ($principalId) { Write-Host "Managed identity object (principal) id: $principalId" }
    Write-Host "The container scoped storage role assignments can be removed in the storage account"
    Write-Host "under Access control (IAM) when the watcher identity is no longer used."
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
    Write-Host "What if: nothing was created. Run again without -WhatIf to create the resource group, Automation account and watcher."
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
                throw "Azure refused to create Automation account '$AutomationAccountName' in $Location with a Conflict. The usual cause is the regional Automation account quota (as low as 2 accounts per region on many subscription types) or the name already being taken in that region. Run the script again with another -Location (for example northeurope) or another -AutomationAccountName. Original error: $($_.Exception.Message)"
            }
            throw
        }
    }
} else {
    Write-Host "Automation account '$AutomationAccountName' already exists; checking its identity..."
    if (-not (Get-TenuVaultAutomationPrincipalId)) {
        Write-Host "Enabling the system assigned identity..."
        if ($PSCmdlet.ShouldProcess($AutomationAccountName, "Assign system assigned identity")) {
            Set-AzAutomationAccount -ResourceGroupName $ResourceGroupName -Name $AutomationAccountName `
                -AssignSystemIdentity | Out-Null
        }
    }
}
if (-not $automationAccount) {
    Write-Host "What if: nothing was changed. Run again without -WhatIf to create the Automation account and watcher."
    return
}

# The identity can take a short while to appear in the resource view after creation.
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
# Storage: state container and container scoped roles
# ---------------------------------------------------------------------------

$storageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue
if (-not $storageAccount) {
    $storageAccount = Get-AzStorageAccount -ErrorAction SilentlyContinue | Where-Object { $_.StorageAccountName -eq $StorageAccountName } | Select-Object -First 1
}
if (-not $storageAccount) {
    throw "Storage account '$StorageAccountName' was not found in this subscription. Create it first, for example with New-TenuVaultStorage.ps1."
}

$storageContext = New-AzStorageContext -StorageAccountName $StorageAccountName -UseConnectedAccount
$container = Get-AzStorageContainer -Name $stateContainer -Context $storageContext -ErrorAction SilentlyContinue
if (-not $container) {
    Write-Host "Creating state container '$stateContainer'..."
    if ($PSCmdlet.ShouldProcess($stateContainer, "Create storage container")) {
        New-AzStorageContainer -Name $stateContainer -Context $storageContext -Permission Off | Out-Null
    }
} else {
    Write-Host "State container '$stateContainer' already exists."
}
$backups = Get-AzStorageContainer -Name $backupContainer -Context $storageContext -ErrorAction SilentlyContinue
if (-not $backups) {
    Write-Warning "Container '$backupContainer' was not found yet. The watcher reads it for the missed backup check; TenuVault creates it with the first Azure backup."
}

if ($principalId) {
    $roleScopes = @(
        @{ Role = "Storage Blob Data Reader"; Scope = "$($storageAccount.Id)/blobServices/default/containers/$backupContainer" },
        @{ Role = "Storage Blob Data Contributor"; Scope = "$($storageAccount.Id)/blobServices/default/containers/$stateContainer" }
    )
    foreach ($entry in $roleScopes) {
        $existingAssignment = Get-AzRoleAssignment -ObjectId $principalId -RoleDefinitionName $entry.Role -Scope $entry.Scope |
            Where-Object { $_.Scope -eq $entry.Scope }
        if ($existingAssignment) {
            Write-Host "Identity already has '$($entry.Role)' on the container scope."
        } elseif ($PSCmdlet.ShouldProcess($entry.Scope, "Assign '$($entry.Role)' to the watcher identity")) {
            Write-Host "Assigning '$($entry.Role)' scoped to one container..."
            New-AzRoleAssignment -ObjectId $principalId -RoleDefinitionName $entry.Role -Scope $entry.Scope | Out-Null
        }
    }
}

# ---------------------------------------------------------------------------
# Runbook import and publish. Reimporting with Force replaces the draft, and the
# publish step makes it live, so a rerun is the upgrade path.
# ---------------------------------------------------------------------------

if ($PSCmdlet.ShouldProcess($runbookName, "Import and publish runbook")) {
    Write-Host "Importing runbook '$runbookName' from the sibling runbooks folder..."
    Import-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName `
        -Path $runbookPath -Type PowerShell -Description "TenuVault notification watcher" -Force | Out-Null
    Write-Host "Publishing runbook '$runbookName'..."
    Publish-AzAutomationRunbook -ResourceGroupName $ResourceGroupName `
        -AutomationAccountName $AutomationAccountName -Name $runbookName | Out-Null
}

# ---------------------------------------------------------------------------
# Automation variables. Plain values are always written. Optional channel values
# are only written when passed, so a rerun without them keeps the saved secrets.
# ---------------------------------------------------------------------------

Write-Host "Writing Automation variables..."
Set-TenuVaultAutomationVariable -Name "TenuVaultTenantId" -Value $TenantId
if ($TenantName) { Set-TenuVaultAutomationVariable -Name "TenuVaultTenantName" -Value $TenantName }
Set-TenuVaultAutomationVariable -Name "TenuVaultStorageAccount" -Value $StorageAccountName
if ($WebhookUrl) { Set-TenuVaultAutomationVariable -Name "TenuVaultWebhookUrl" -Value $WebhookUrl -Encrypted $true }
if ($WebhookSecret) { Set-TenuVaultAutomationVariable -Name "TenuVaultWebhookSecret" -Value $WebhookSecret -Encrypted $true }
if ($TeamsWebhookUrl) { Set-TenuVaultAutomationVariable -Name "TenuVaultTeamsWebhookUrl" -Value $TeamsWebhookUrl -Encrypted $true }
if ($MailSender) { Set-TenuVaultAutomationVariable -Name "TenuVaultMailSender" -Value $MailSender }
if ($MailRecipients) { Set-TenuVaultAutomationVariable -Name "TenuVaultMailRecipients" -Value ($MailRecipients -join ",") }
if ($MailProbeMailbox) { Set-TenuVaultAutomationVariable -Name "TenuVaultMailProbeMailbox" -Value $MailProbeMailbox }
Set-TenuVaultAutomationVariable -Name "TenuVaultMissedBackupHours" -Value ([string]$MissedBackupHours)
Set-TenuVaultAutomationVariable -Name "TenuVaultIncludeActor" -Value $(if ($IncludeActor) { "true" } else { "false" })
Set-TenuVaultAutomationVariable -Name "TenuVaultConfigVersion" -Value "1"

# ---------------------------------------------------------------------------
# Failure alerting, deliberately before the schedule is linked: with -AlertEmail
# the alert must exist first, because a scheduled watcher without a failure
# alert fails silently. The Az.Monitor cmdlets for this were removed in Az 11,
# so the action group and metric alert are written with ARM REST PUT calls.
# PUT also updates resources an earlier run created, including re-scoping an
# existing alert to the Status = Failed criteria.
# ---------------------------------------------------------------------------

$alertStatus = $null
if ($NoFailureAlert) { $alertStatus = "disabled by -NoFailureAlert (no Azure Monitor alert will fire)" }
if ($AlertEmail) {
    $actionGroupName = "ag-tenuvault-watcher"
    $metricAlertName = "TenuVault watcher failed jobs"
    if (-not (Get-Command Invoke-AzRestMethod -ErrorAction SilentlyContinue)) {
        throw "Invoke-AzRestMethod is not available, so the failure alert for $AlertEmail cannot be created. Install or update the Az.Accounts module, or pass -NoFailureAlert to accept a watcher without a failure alert. The schedule was not linked."
    }
    if ($WhatIfPreference) {
        $alertStatus = "would be created for $AlertEmail (WhatIf: no changes were made)"
        Write-Host "What if: action group '$actionGroupName' and metric alert '$metricAlertName' would be created for $AlertEmail."
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
                    emailReceivers = @(
                        @{ name = "TenuVaultAdmins"; emailAddress = $AlertEmail; useCommonAlertSchema = $true }
                    )
                }
            } | ConvertTo-Json -Depth 10
            $actionGroupResponse = Invoke-AzRestMethod -Method Put `
                -Path "$actionGroupId`?api-version=2023-01-01" -Payload $actionGroupPayload
            $actionGroupStatus = 0
            if ($actionGroupResponse -and $actionGroupResponse.PSObject.Properties["StatusCode"]) { $actionGroupStatus = [int]$actionGroupResponse.StatusCode }
            if ($actionGroupStatus -ge 300) { throw "the actionGroups request returned HTTP $actionGroupStatus" }
            Write-Host "Action group '$actionGroupName' in place for $AlertEmail."

            $metricAlertPayload = @{
                location = "global"
                properties = @{
                    description = "TenuVault notification watcher Automation jobs are failing."
                    severity = 3
                    enabled = $true
                    scopes = @($aaResource.ResourceId)
                    evaluationFrequency = "PT15M"
                    windowSize = "PT1H"
                    targetResourceType = "Microsoft.Automation/automationAccounts"
                    targetResourceRegion = $Location
                    criteria = @{
                        "odata.type" = "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria"
                        allOf = @(
                            @{
                                name = "FailedJobs"
                                metricName = "TotalJob"
                                metricNamespace = "Microsoft.Automation/automationAccounts"
                                operator = "GreaterThan"
                                threshold = 0
                                timeAggregation = "Total"
                                dimensions = @(
                                    @{ name = "Status"; operator = "Include"; values = @("Failed") }
                                )
                                criterionType = "StaticThresholdCriterion"
                            }
                        )
                    }
                    actions = @( @{ actionGroupId = $actionGroupId } )
                }
            } | ConvertTo-Json -Depth 12
            $metricAlertId = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$ResourceGroupName/providers/microsoft.insights/metricAlerts/$([uri]::EscapeDataString($metricAlertName))"
            $metricAlertResponse = Invoke-AzRestMethod -Method Put `
                -Path "$metricAlertId`?api-version=2018-03-01" -Payload $metricAlertPayload
            $metricAlertStatus = 0
            if ($metricAlertResponse -and $metricAlertResponse.PSObject.Properties["StatusCode"]) { $metricAlertStatus = [int]$metricAlertResponse.StatusCode }
            if ($metricAlertStatus -ge 300) { throw "the metricAlerts request returned HTTP $metricAlertStatus" }
            Write-Host "Metric alert '$metricAlertName' in place (TotalJob with Status = Failed)."
            $alertStatus = "action group '$actionGroupName' and metric alert '$metricAlertName' in place for $AlertEmail"
        } catch {
            throw "Creating the failure alert for $AlertEmail failed, so the schedule was not linked and the watcher will not run unattended without its alert. Fix the cause and run this script again, or pass -NoFailureAlert to accept a watcher without a failure alert. Cause: $($_.Exception.Message)"
        }
    }
}

# ---------------------------------------------------------------------------
# Schedule and link. Schedule intervals cannot be edited in place, so a schedule
# with a different interval is replaced together with its link.
# ---------------------------------------------------------------------------

$schedule = Get-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
    -AutomationAccountName $AutomationAccountName -Name $scheduleName -ErrorAction SilentlyContinue
$scheduleMatches = $schedule -and $schedule.Frequency -eq "Hour" -and $schedule.Interval -eq $ScheduleIntervalHours
if ($schedule -and -not $scheduleMatches) {
    Write-Host "Replacing schedule '$scheduleName' so it runs every $ScheduleIntervalHours hour(s)..."
    if ($PSCmdlet.ShouldProcess($scheduleName, "Replace schedule")) {
        try {
            Unregister-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
                -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
                -ScheduleName $scheduleName -Force -ErrorAction Stop | Out-Null
        } catch { Write-Host "No existing schedule link to remove." }
        Remove-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName -Force | Out-Null
        $schedule = $null
    }
}
if (-not $schedule) {
    Write-Host "Creating schedule '$scheduleName' (every $ScheduleIntervalHours hour(s), UTC)..."
    if ($PSCmdlet.ShouldProcess($scheduleName, "Create schedule")) {
        $startTime = [DateTime]::UtcNow.AddMinutes(10)
        $schedule = New-AzAutomationSchedule -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -Name $scheduleName `
            -StartTime $startTime -HourInterval $ScheduleIntervalHours -TimeZone "UTC"
    }
}
if ($PSCmdlet.ShouldProcess($runbookName, "Link runbook to schedule '$scheduleName'")) {
    $alreadyLinked = $false
    try {
        $alreadyLinked = [bool](Get-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName -ErrorAction Stop)
    } catch { $alreadyLinked = $false }
    if ($alreadyLinked) {
        Write-Host "Runbook is already linked to schedule '$scheduleName'."
    } else {
        Register-AzAutomationScheduledRunbook -ResourceGroupName $ResourceGroupName `
            -AutomationAccountName $AutomationAccountName -RunbookName $runbookName `
            -ScheduleName $scheduleName | Out-Null
        Write-Host "Runbook linked to schedule '$scheduleName'."
    }
}

# ---------------------------------------------------------------------------
# Optional Graph application roles for the managed identity, through Microsoft
# Graph REST calls with Invoke-MgGraphRequest (same service principal lookup
# pattern as New-TenuVaultDesktopApp.ps1, which resolves roles on the Graph
# service principal before granting). Needs a Global Administrator.
# ---------------------------------------------------------------------------

$consentReceipt = $null
if ($GrantGraphRoles) {
    if (-not $principalId) { throw "Cannot grant Graph roles: the managed identity principal id is unknown." }

    if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
        Write-Host "Installing Microsoft.Graph.Authentication for the current user..."
        try {
            Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
        } catch {
            throw "Could not install Microsoft.Graph.Authentication. Check that the PowerShell Gallery is reachable, then run the script again. $($_.Exception.Message)"
        }
    }
    Import-Module Microsoft.Graph.Authentication
    $connectParams = @{
        Scopes = "AppRoleAssignment.ReadWrite.All", "Application.Read.All"
        TenantId = $TenantId
        NoWelcome = $true
    }
    Connect-MgGraph @connectParams
    $mgContext = Get-MgContext

    $graphSpUri = "https://graph.microsoft.com/v1.0/servicePrincipals?%24filter=$([uri]::EscapeDataString("appId eq '00000003-0000-0000-c000-000000000000'"))"
    $graphSpResponse = Invoke-MgGraphRequest -Method Get -Uri $graphSpUri
    $graphSp = @($graphSpResponse.value) | Select-Object -First 1
    if (-not $graphSp) { throw "The Microsoft Graph service principal was not found in tenant $TenantId." }

    $assignmentsUri = "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments"
    $existingAssignments = @((Invoke-MgGraphRequest -Method Get -Uri $assignmentsUri).value)

    $grantedRoles = @()
    foreach ($roleName in $graphRoleNames) {
        $role = @($graphSp.appRoles) | Where-Object {
            $_.value -eq $roleName -and @($_.allowedMemberTypes) -contains "Application"
        } | Select-Object -First 1
        if (-not $role) { throw "Graph application role '$roleName' was not found on the Microsoft Graph service principal." }
        $alreadyAssigned = @($existingAssignments | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graphSp.id }).Count -gt 0
        if ($alreadyAssigned) {
            Write-Host "Graph role '$roleName' is already assigned to the watcher identity."
        } elseif ($PSCmdlet.ShouldProcess($principalId, "Assign Graph role '$roleName'")) {
            $body = @{ principalId = $principalId; resourceId = $graphSp.id; appRoleId = $role.id } | ConvertTo-Json -Compress
            Invoke-MgGraphRequest -Method Post -Uri $assignmentsUri -Body $body -ContentType "application/json" | Out-Null
            Write-Host "Graph role '$roleName' assigned to the watcher identity."
        }
        $grantedRoles += $roleName
    }

    $consentReceipt = [pscustomobject][ordered]@{
        Actor = $mgContext.Account
        TenantId = $TenantId
        PrincipalId = $principalId
        Roles = $grantedRoles
        Timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    }
}

# ---------------------------------------------------------------------------
# Summary and next steps
# ---------------------------------------------------------------------------

Write-Host ""
if ($WhatIfPreference) {
    Write-Host "What if: no changes were made by guarded operations." -ForegroundColor Yellow
} else {
    Write-Host "Done. The TenuVault notification watcher is in place:" -ForegroundColor Green
}
Write-Host "  Automation account:  $AutomationAccountName (resource group $ResourceGroupName)"
Write-Host "  Runbook:             $runbookName (published, schedule '$scheduleName' every $ScheduleIntervalHours hour(s))"
Write-Host "  Storage account:     $StorageAccountName (state container '$stateContainer')"
if ($principalId) { Write-Host "  Managed identity:    $principalId" }
if ($alertStatus) { Write-Host "  Failure alert:       $alertStatus" }

if ($consentReceipt) {
    Write-Host ""
    Write-Host "Consent receipt (keep with your change record):"
    Write-Host "  Actor:      $($consentReceipt.Actor)"
    Write-Host "  Tenant:     $($consentReceipt.TenantId)"
    Write-Host "  Principal:  $($consentReceipt.PrincipalId)"
    Write-Host "  Roles:      $($consentReceipt.Roles -join ', ')"
    Write-Host "  Timestamp:  $($consentReceipt.Timestamp)"
} else {
    Write-Host ""
    Write-Host "Graph roles were not granted by this run. A Global Administrator must assign these"
    Write-Host "Microsoft Graph application roles to the managed identity before the watcher works,"
    Write-Host "or run this script again with -GrantGraphRoles:"
    foreach ($role in $graphRoleNames) { Write-Host "  * $role" }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Confirm the channel variables in the portal (Automation account > Variables)."
Write-Host "     Webhook, Teams and mail values that were not passed here can be set there, or by"
Write-Host "     running this script again with the matching parameters."
Write-Host "  2. Start the runbook once by hand (Automation account > Runbooks > $runbookName > Start)"
Write-Host "     and check heartbeat.json in the '$stateContainer' container afterwards."
Write-Host "  3. When Mail.Send is granted, limit it to the sender mailbox with an Exchange"
Write-Host "     application access policy (New-ApplicationAccessPolicy) so the identity can only"
Write-Host "     send as that one mailbox, set TenuVaultMailProbeMailbox to a mailbox outside"
Write-Host "     that policy, then start the runbook once with the VerifyMailOnly parameter set."
Write-Host "     Mail stays disabled until that verification records mailVerified in state.json."
Write-Host "  4. Keep storage role assignments permanently active. A PIM eligible assignment that"
Write-Host "     nobody activated makes scheduled watcher runs fail at night."
Write-Host "  5. To upgrade the watcher later, run this script again with the new runbooks folder:"
Write-Host "     the runbook draft is replaced and published in place."
if ($AlertEmail) {
    Write-Host "  6. Failure alerting for $AlertEmail`: $alertStatus."
    Write-Host "     Watch for the action group confirmation email and test the alert once."
}


