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

    Running the script again with the same parameters changes nothing that already
    matches. The script needs Az.Accounts, Az.Resources and Az.Storage and an account
    that can create storage accounts and assign roles in the subscription (for example
    Owner, or Contributor plus User Access Administrator on the resource group).

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
    that run TenuVault. When set, the storage firewall denies every other network
    except trusted Azure services. When omitted, all networks can reach the account
    and Entra sign-in plus the roles above are the only gate.

.EXAMPLE
    ./New-TenuVaultStorage.ps1 -AdminGroupId 5f0c... -Location westeurope

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
    [string[]]$AllowIpAddresses
)

$ErrorActionPreference = "Stop"

# Validate every input before the first Azure write, so a typo cannot leave a
# half configured account behind (for example a deny-all firewall with no rules).
if ($AdminGroupId -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    throw "'$AdminGroupId' is not a group object id. Pass the object (principal) id of the Intune admin security group."
}
foreach ($entry in $AllowIpAddresses) {
    $address = $entry.Split("/")[0]
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($address, [ref]$parsed)) {
        throw "'$entry' is not an IP address or CIDR range. Fix -AllowIpAddresses and run the script again."
    }
    if ($entry.Contains("/")) {
        $prefix = 0
        if (-not [int]::TryParse($entry.Split("/")[1], [ref]$prefix) -or $prefix -lt 0 -or $prefix -gt 32) {
            throw "'$entry' has an invalid CIDR prefix. Use a value between 0 and 32."
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
$softDeleteMatches = $blobService.DeleteRetentionPolicy.Enabled -and $blobService.DeleteRetentionPolicy.Days -eq 7 -and `
    $blobService.ContainerDeleteRetentionPolicy.Enabled -and $blobService.ContainerDeleteRetentionPolicy.Days -eq 7
if (-not $softDeleteMatches -and $PSCmdlet.ShouldProcess($StorageAccountName, "Enable soft delete for 7 days")) {
    Update-AzStorageBlobServiceProperty -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName `
        -EnableDeleteRetentionPolicy $true -DeleteRetentionPolicyDay 7 `
        -EnableContainerDeleteRetentionPolicy $true -ContainerDeleteRetentionPolicyDay 7 | Out-Null
}

$networkRules = Get-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
if ($AllowIpAddresses) {
    Write-Host "Restricting the storage firewall to the named addresses plus trusted Azure services..."
    if ($PSCmdlet.ShouldProcess($StorageAccountName, "Set storage firewall to deny by default with the named addresses allowed")) {
        if ($networkRules.DefaultAction -ne "Deny" -or "$($networkRules.Bypass)" -notmatch "AzureServices") {
            Update-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName `
                -DefaultAction Deny -Bypass AzureServices | Out-Null
            $networkRules = Get-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
        }
        $allowedNow = @($networkRules.IpRules | ForEach-Object { $_.IPAddressOrRange })
        foreach ($ip in $AllowIpAddresses) {
            if ($allowedNow -notcontains $ip) {
                Add-AzStorageAccountNetworkRule -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -IPAddressOrRange $ip | Out-Null
            }
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

# Read the final firewall state so a rerun without -AllowIpAddresses still reports a
# restriction an earlier run put in place.
$networkRules = Get-AzStorageAccountNetworkRuleSet -ResourceGroupName $ResourceGroupName -Name $StorageAccountName
$firewallText = if ($networkRules.DefaultAction -eq "Deny") {
    $ips = @($networkRules.IpRules | ForEach-Object { $_.IPAddressOrRange })
    "denies by default; allowed addresses: " + $(if ($ips) { $ips -join ", " } else { "none" }) + ", plus trusted Azure services"
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
Write-Host ""
Write-Host "New role assignments can take a few minutes to apply. The assignments must stay permanently"
Write-Host "active: a PIM eligible assignment that nobody activated makes scheduled backups fail."
Write-Host "Members of the group then select 'Check access' in TenuVault to confirm. If the storage"
Write-Host "firewall is restricted, the check must run from an allowed network. Each admin also saves"
Write-Host "the TenuVault recovery key in Settings before the first Azure backup; without it the"
Write-Host "encrypted backups cannot be read."
