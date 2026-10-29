<#
.SYNOPSIS
    Creates the Azure storage account the TenuVault desktop app stores encrypted backups in.

.DESCRIPTION
    Run this script as an Azure administrator, for example when an Intune administrator
    asks for a storage account for TenuVault backups. The script:

      * creates or reuses a resource group and a StorageV2 storage account
      * requires TLS 1.2 and HTTPS, blocks public blob access and shared key authorization
        (TenuVault authenticates with Microsoft Entra tokens only)
      * turns on seven days of soft delete for blobs and containers
      * grants the "Reader" and "Storage Blob Data Contributor" roles on the storage
        account to one security group, so every admin in that group can pick the account
        in TenuVault and store backups in it
      * optionally restricts the storage firewall to named public IP addresses
      * optionally lets the read-only Backup Reader (New-TenuVaultBackupReader.ps1) write
        scheduled backups, without permission to delete or create containers

    Running the script again with the same parameters changes nothing that already
    matches. The script needs Az.Accounts, Az.Resources and Az.Storage and an account
    that can create storage accounts and assign roles in the subscription (for example
    Owner, or Contributor plus User Access Administrator on the resource group).
    Creating a new resource group additionally needs permission to create resource
    groups in the subscription (Microsoft.Resources/subscriptions/resourceGroups/write,
    which Contributor at subscription scope includes).

    Note on PIM: role assignments must be permanently active. An eligible assignment
    that nobody activated makes scheduled backups fail at night.

.PARAMETER AdminGroupId
    Object id of the security group whose members administer Intune with TenuVault.
    The roles are assigned to this group, not to individual accounts.

.PARAMETER SubscriptionId
    Subscription to create the resources in. Defaults to the current Az context.

.PARAMETER ResourceGroupName
    Resource group, created when missing. Default: "rg-tenuvault-backups".

.PARAMETER Location
    Azure region, required when the resource group is created. An existing resource
    group keeps its region. Choose the region your backup data must stay in.

.PARAMETER StorageAccountName
    Globally unique storage account name (3 to 24 lower case letters and digits). When
    omitted, a stable name is derived from the subscription and resource group.

.PARAMETER Sku
    Redundancy. Standard_LRS is the default; use Standard_GRS when these backups are
    the only copy and must survive the loss of a region.

.PARAMETER AllowIpAddresses
    Optional public IP addresses or CIDR ranges for the computers
    that run TenuVault. When set, the addresses are added to the firewall rules and
    the firewall is set to deny by default with trusted Azure services allowed.
    Addresses and virtual network rules that are already on the account are kept, so
    remove rules you no longer want in the portal. When omitted, the network rules
    are left unchanged: a new account then accepts all networks, with Entra sign-in
    plus the roles above as the only gate.

.PARAMETER BackupReaderAppId
    Application (client) ID of the TenuVault Backup Reader. When set, the script also:
      * creates the backup container "intune-backups" (the reader cannot create it)
      * creates the custom role "TenuVault Backup Writer" (read and write blobs, no delete)
        and assigns it to the Backup Reader on that container only
      * turns on blob versioning, so a blob the reader overwrites keeps its previous version,
        and adds a lifecycle rule that removes previous versions after -VersionRetentionDays
    The reader never deletes backups. Retention runs on the next backup made with an admin's
    sign-in. This needs Owner, or Contributor plus User Access Administrator, on the resource
    group: User Access Administrator covers the custom role and its assignment, Contributor
    covers the container, versioning and lifecycle rule.

.PARAMETER VersionRetentionDays
    Days previous blob versions are kept before the lifecycle rule removes them. Only with
    -BackupReaderAppId. Default: 30.

.EXAMPLE
    ./New-TenuVaultStorage.ps1 -AdminGroupId 5f0c... -Location westeurope

.EXAMPLE
    ./New-TenuVaultStorage.ps1 -AdminGroupId 5f0c... -BackupReaderAppId 4f1e...

.EXAMPLE
    ./New-TenuVaultStorage.ps1 -AdminGroupId 5f0c... -Location westeurope -Sku Standard_GRS -AllowIpAddresses 203.0.113.10
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$AdminGroupId,
    [string]$SubscriptionId,
    [string]$ResourceGroupName = "rg-tenuvault-backups",
    [string]$Location,
    [string]$StorageAccountName,
    [ValidateSet("Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Standard_GZRS")]
    [string]$Sku = "Standard_LRS",
    [string[]]$AllowIpAddresses,
    [string]$BackupReaderAppId,
    [ValidateRange(1, 3650)][int]$VersionRetentionDays = 30
)

$ErrorActionPreference = "Stop"

# Validate every input before the first Azure write, so a typo cannot leave a
# half configured account behind (for example a deny-all firewall with no rules).
if ($AdminGroupId -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    throw "'$AdminGroupId' is not a group object id. Pass the object (principal) id of the Intune admin security group."
}
if ($BackupReaderAppId -and $BackupReaderAppId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
    throw "'$BackupReaderAppId' is not an application (client) id. Pass the id New-TenuVaultBackupReader.ps1 printed."
}
# Storage firewall rules accept public IPv4 addresses only: no IPv6, no private
# (RFC 1918) ranges, and no /31 or /32 CIDR (use the individual address instead).
foreach ($entry in $AllowIpAddresses) {
    $parts = $entry.Split("/")
    $parsed = $null
    if ($parts.Count -gt 2 -or -not [Net.IPAddress]::TryParse($parts[0], [ref]$parsed) -or
        $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "'$entry' is not an IPv4 address or CIDR range. Fix -AllowIpAddresses and run the script again."
    }
    $bytes = $parsed.GetAddressBytes()
    if ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)) {
        throw "'$entry' is a private address. Storage firewall rules only accept public internet addresses; use the public address of the network instead."
    }
    if ($parts.Count -eq 2) {
        $prefix = 0
        if (-not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 0 -or $prefix -gt 30) {
            throw "'$entry' has an unsupported CIDR prefix. Use 0 to 30, or pass the individual address without a prefix."
        }
    }
}

foreach ($module in "Az.Accounts", "Az.Resources", "Az.Storage") {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "Installing $module for the current user..."
        Install-Module $module -Scope CurrentUser -Force -AllowClobber
    }
}

if (-not (Get-AzContext)) { Connect-AzAccount | Out-Null }
if ($SubscriptionId) { Set-AzContext -Subscription $SubscriptionId | Out-Null }
$context = Get-AzContext
Write-Host "Subscription: $($context.Subscription.Name) ($($context.Subscription.Id))"

$resourceGroup = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
if (-not $resourceGroup) {
    if (-not $Location) { throw "Resource group '$ResourceGroupName' does not exist. Pass -Location to create it, for example -Location westeurope." }
    Write-Host "Creating resource group '$ResourceGroupName' in $Location..."
    if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Create resource group")) {
        $resourceGroup = New-AzResourceGroup -Name $ResourceGroupName -Location $Location
    }
}
if (-not $resourceGroup) {
    Write-Host "What if: nothing was created. Run again without -WhatIf to create the resource group, storage account and role assignments."
    return
}
if (-not $Location) { $Location = $resourceGroup.Location }

if (-not $StorageAccountName) {
    $seed = "$($context.Subscription.Id)/$ResourceGroupName"
    # ComputeHash and BitConverter exist in .NET Framework 4.8 too, so the generated
    # name is identical in Windows PowerShell 5.1 and PowerShell 7.
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($seed)) } finally { $sha.Dispose() }
    $hash = [BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()
    $StorageAccountName = "tvbkp" + $hash.Substring(0, 12)
}
if ($StorageAccountName -notmatch '^[a-z0-9]{3,24}$') {
    throw "Storage account name '$StorageAccountName' is invalid: use 3 to 24 lower case letters and digits."
}

$secureSettings = @{
    MinimumTlsVersion     = "TLS1_2"
    AllowBlobPublicAccess = $false
    AllowSharedKeyAccess  = $false
    EnableHttpsTrafficOnly = $true
}

$account = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue
if (-not $account) {
    $availability = Get-AzStorageAccountNameAvailability -Name $StorageAccountName
    if (-not $availability.NameAvailable) {
        throw "Storage account name '$StorageAccountName' is not available ($($availability.Reason): $($availability.Message)). Pass another -StorageAccountName."
    }
    Write-Host "Creating storage account '$StorageAccountName' ($Sku, $Location)..."
    if ($PSCmdlet.ShouldProcess($StorageAccountName, "Create storage account")) {
        $account = New-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName `
            -Location $Location -SkuName $Sku -Kind StorageV2 -AccessTier Hot @secureSettings
    }
} else {
    Write-Host "Storage account '$StorageAccountName' already exists; checking its settings..."
    if ($account.Kind -ne "StorageV2") {
        throw "Storage account '$StorageAccountName' is of kind '$($account.Kind)', but TenuVault expects StorageV2. Pass another -StorageAccountName, or upgrade the account and run this script again."
    }
    if ($account.Sku.Name -ne $Sku) {
        Write-Warning "Existing redundancy is $($account.Sku.Name); the requested $Sku is not applied to an existing account and was left unchanged."
    }
    if ($account.AccessTier -ne "Hot") {
        Write-Warning "Existing access tier is $($account.AccessTier); it was left unchanged. TenuVault retention deletes and rewrites blobs often, which suits the Hot tier."
    }
    $needsSecureSettings = $account.MinimumTlsVersion -ne "TLS1_2" -or $account.AllowBlobPublicAccess -ne $false -or `
        $account.AllowSharedKeyAccess -ne $false -or $account.EnableHttpsTrafficOnly -ne $true
    if ($needsSecureSettings -and $PSCmdlet.ShouldProcess($StorageAccountName, "Apply required storage settings")) {
        Set-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName @secureSettings | Out-Null
        $account = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
    }
}

if (-not $account) {
    Write-Host "What if: nothing was changed. Run again without -WhatIf to create the storage account, soft delete settings and role assignments."
    return
}

$blobService = Get-AzStorageBlobServiceProperty -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName
$blobSoftDeleteMatches = $blobService.DeleteRetentionPolicy.Enabled -and $blobService.DeleteRetentionPolicy.Days -eq 7
$containerSoftDeleteMatches = $blobService.ContainerDeleteRetentionPolicy.Enabled -and $blobService.ContainerDeleteRetentionPolicy.Days -eq 7
if (-not $blobSoftDeleteMatches -and $PSCmdlet.ShouldProcess($StorageAccountName, "Enable blob soft delete for 7 days")) {
    Enable-AzStorageBlobDeleteRetentionPolicy -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -RetentionDays 7 | Out-Null
}
if (-not $containerSoftDeleteMatches -and $PSCmdlet.ShouldProcess($StorageAccountName, "Enable container soft delete for 7 days")) {
    Enable-AzStorageContainerDeleteRetentionPolicy -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -RetentionDays 7 | Out-Null
}

$networkRules = Get-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
if ($AllowIpAddresses) {
    Write-Host "Allowing the named addresses and setting the storage firewall to deny by default (existing allowed addresses are kept)..."
    if ($PSCmdlet.ShouldProcess($StorageAccountName, "Set storage firewall to deny by default with the named addresses allowed")) {
        # Add the addresses first and switch the default action last, so a rule Azure
        # rejects can never leave the account deny-all with nobody allowed in.
        $allowedNow = @($networkRules.IpRules | ForEach-Object { $_.IPAddressOrRange })
        foreach ($ip in $AllowIpAddresses) {
            if ($allowedNow -notcontains $ip) {
                Add-AzStorageAccountNetworkRule -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -IPAddressOrRange $ip | Out-Null
            }
        }
        if ($networkRules.DefaultAction -ne "Deny" -or "$($networkRules.Bypass)" -notmatch "AzureServices") {
            Update-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName `
                -DefaultAction Deny -Bypass AzureServices | Out-Null
        }
    }
}

$scope = $account.Id
foreach ($role in "Reader", "Storage Blob Data Contributor") {
    # Only an assignment at the storage account scope counts; inherited assignments are
    # reported as their own scope by Get-AzRoleAssignment when -Scope is given.
    $existing = Get-AzRoleAssignment -ObjectId $AdminGroupId -RoleDefinitionName $role -Scope $scope |
        Where-Object { $_.Scope -eq $scope }
    if ($existing) {
        Write-Host "Group already has '$role' on the storage account."
    } elseif ($PSCmdlet.ShouldProcess($scope, "Assign '$role' to group $AdminGroupId")) {
        Write-Host "Assigning '$role' to the admin group..."
        New-AzRoleAssignment -ObjectId $AdminGroupId -RoleDefinitionName $role -Scope $scope | Out-Null
    }
}

$readerText = $null
if ($BackupReaderAppId) {
    $reader = Get-AzADServicePrincipal -ApplicationId $BackupReaderAppId
    if (-not $reader) { throw "No service principal for application $BackupReaderAppId exists in this tenant. Run New-TenuVaultBackupReader.ps1 first." }
    $container = "intune-backups"
    if (-not (Get-AzRmStorageContainer -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -Name $container -ErrorAction SilentlyContinue)) {
        Write-Host "Creating the backup container '$container'..."
        if ($PSCmdlet.ShouldProcess($StorageAccountName, "Create container $container")) {
            New-AzRmStorageContainer -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -Name $container | Out-Null
        }
    }

    # Write without delete: a stolen Backup Reader certificate cannot remove backups, and versioning
    # keeps what it overwrites. Custom roles are assignable at resource group scope at the narrowest.
    $roleName = "TenuVault Backup Writer"
    $groupScope = $resourceGroup.ResourceId
    $dataActions = @(
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"
    )
    $role = Get-AzRoleDefinition -Name $roleName -ErrorAction SilentlyContinue
    if (-not $role) {
        Write-Host "Creating the custom role '$roleName' (read and write blobs, no delete)..."
        if ($PSCmdlet.ShouldProcess($groupScope, "Create custom role $roleName")) {
            $definition = [Microsoft.Azure.Commands.Resources.Models.Authorization.PSRoleDefinition]::new()
            $definition.Name = $roleName
            $definition.Description = "TenuVault Backup Reader: writes scheduled backups. Cannot delete blobs, blob versions or containers."
            $definition.IsCustom = $true
            $definition.Actions = @()
            $definition.DataActions = $dataActions
            $definition.AssignableScopes = @($groupScope)
            $role = New-AzRoleDefinition -Role $definition
        }
    } else {
        $extra = @($role.DataActions | Where-Object { $dataActions -notcontains $_ }) + @($role.Actions)
        if ($extra) { throw "The existing role '$roleName' allows more than writing backups ($($extra -join ', ')). Remove those permissions or delete the role, then run the script again." }
        if ($role.AssignableScopes -notcontains $groupScope -and $PSCmdlet.ShouldProcess($roleName, "Allow assignments in $ResourceGroupName")) {
            $role.AssignableScopes.Add($groupScope)
            $role = Set-AzRoleDefinition -Role $role
        }
    }

    $containerScope = "$($account.Id)/blobServices/default/containers/$container"
    if ($role) {
        $existing = Get-AzRoleAssignment -ObjectId $reader.Id -RoleDefinitionName $roleName -Scope $containerScope -ErrorAction SilentlyContinue | Where-Object { $_.Scope -eq $containerScope }
        if (-not $existing -and $PSCmdlet.ShouldProcess($containerScope, "Assign '$roleName' to the Backup Reader")) {
            Write-Host "Assigning '$roleName' to the Backup Reader on the container..."
            New-AzRoleAssignment -ObjectId $reader.Id -RoleDefinitionName $roleName -Scope $containerScope | Out-Null
        }
    }
    # Broader roles would let a stolen certificate delete backups; they are reported, not removed.
    $broader = Get-AzRoleAssignment -ObjectId $reader.Id -Scope $account.Id -ErrorAction SilentlyContinue | Where-Object { $_.RoleDefinitionName -ne $roleName }
    foreach ($assignment in $broader) {
        Write-Warning "The Backup Reader also has '$($assignment.RoleDefinitionName)' at $($assignment.Scope). Remove it so the reader cannot delete backups."
    }

    $blobService = Get-AzStorageBlobServiceProperty -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName
    if (-not $blobService.IsVersioningEnabled -and $PSCmdlet.ShouldProcess($StorageAccountName, "Enable blob versioning")) {
        Write-Host "Turning on blob versioning..."
        Update-AzStorageBlobServiceProperty -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -IsVersioningEnabled $true | Out-Null
    }
    # Only previous versions age out; current backups are never deleted by the lifecycle rule.
    $ruleName = "tenuvault-previous-versions"
    $policy = Get-AzStorageAccountManagementPolicy -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -ErrorAction SilentlyContinue
    $rules = @($policy.Rules | Where-Object { $_.Name -ne $ruleName })
    $current = $policy.Rules | Where-Object { $_.Name -eq $ruleName }
    if ((-not $current -or $current.Definition.Actions.Version.Delete.DaysAfterCreationGreaterThan -ne $VersionRetentionDays) -and
        $PSCmdlet.ShouldProcess($StorageAccountName, "Remove previous blob versions after $VersionRetentionDays days")) {
        $action = Add-AzStorageAccountManagementPolicyAction -BlobVersionAction Delete -DaysAfterCreationGreaterThan $VersionRetentionDays
        $filter = New-AzStorageAccountManagementPolicyFilter -PrefixMatch "$container/" -BlobType blockBlob
        $rules += New-AzStorageAccountManagementPolicyRule -Name $ruleName -Action $action -Filter $filter
        Set-AzStorageAccountManagementPolicy -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -Rule $rules | Out-Null
    }
    $readerText = "can write to '$container' but not delete; versioning on, previous versions kept $VersionRetentionDays days"
}

# Read the final firewall state so a rerun without -AllowIpAddresses still reports a
# restriction an earlier run put in place.
$networkRules = Get-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
$account = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
$firewallText = if ($account.PublicNetworkAccess -eq "Disabled") {
    "public network access is disabled, so no public address can reach the account (this takes precedence over the firewall rules). TenuVault on an admin computer cannot use it until public access or a private endpoint route exists."
} elseif ($networkRules.DefaultAction -eq "Deny") {
    $ips = @($networkRules.IpRules | ForEach-Object { $_.IPAddressOrRange })
    $bypassText = if ("$($networkRules.Bypass)" -match "AzureServices") { ", plus trusted Azure services" } else { "" }
    "denies by default; allowed addresses: " + $(if ($ips) { $ips -join ", " } else { "none" }) + $bypassText
} else {
    "open to all networks. Entra sign-in and the roles above are the only gate. Confirm this is intended, or run the script again with -AllowIpAddresses."
}

Write-Host ""
if ($WhatIfPreference) {
    Write-Host "What if: no changes were made. Current state of the storage account:" -ForegroundColor Yellow
} else {
    Write-Host "Done. In TenuVault, choose this storage account during tenant setup or in Settings > Sign-in > Change storage:" -ForegroundColor Green
}
Write-Host "  Storage account:  $StorageAccountName"
Write-Host "  Resource group:   $ResourceGroupName"
Write-Host "  Region:           $($account.Location)"
Write-Host "  Firewall:         $firewallText"
if ($readerText) { Write-Host "  Backup Reader:    $readerText" }
Write-Host ""
Write-Host "New role assignments can take a few minutes to apply. The assignments must stay permanently"
Write-Host "active: a PIM eligible assignment that nobody activated makes scheduled backups fail."
Write-Host "Members of the group then select 'Check access' in TenuVault to confirm. If the storage"
Write-Host "firewall is restricted, the check must run from an allowed network. Each admin also saves"
Write-Host "the TenuVault recovery key in Settings before the first Azure backup; without it the"
Write-Host "encrypted backups cannot be read."
