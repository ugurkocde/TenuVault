<#
.SYNOPSIS
    Creates the app registration the TenuVault desktop app signs in with.

.DESCRIPTION
    TenuVault Desktop uses an app registration that lives in your own tenant. It is a
    public client (no secret, no certificate) with delegated permissions only, so every
    call runs as the signed-in admin and is subject to your Conditional Access policies.

    The script:
      * creates a single-tenant public client app registration
      * adds the loopback redirect URI (system browser sign-in)
      * requests the delegated permissions TenuVault uses
      * grants tenant-wide admin consent for those permissions
      * optionally limits sign-in to members of one group

    Requires the Microsoft.Graph.Applications and Microsoft.Graph.Identity.SignIns modules
    and a Global Administrator, Privileged Role Administrator or Cloud Application
    Administrator (plus consent rights) account. The script installs missing modules for
    the current user at the version of the installed Microsoft.Graph.Authentication
    module, so all Graph modules load at one version.

.PARAMETER TenantId
    Tenant to create the app registration in. Defaults to the tenant of the account you sign in with.

.PARAMETER DisplayName
    Name of the app registration. Default: "TenuVault Desktop".

.PARAMETER AllowedGroupId
    Object id of a security group. When set, only members of this group can sign in to TenuVault.
    Recommended: use a group of the admins who run TenuVault and make sure you are a member.
    Assigning a group needs Entra ID P1 or P2, and only direct members get access (nested
    groups do not). Off by default so an admin who is not in the group is not locked out.

.PARAMETER IncludeGroupRead
    When set, also requests the delegated Group.Read.All permission. The hygiene
    unresolved groups check needs it to tell whether a referenced group exists. Without
    it that check stays unknown. Off by default, so the default permission set is unchanged.

.PARAMETER IncludeNotifications
    When set, also requests the delegated Mail.Send and GroupMember.Read.All permissions.
    Notification email channels send as the signed-in admin and can resolve Entra group
    recipients. Without it, email channels fail with a Graph permission error while
    webhook and Teams channels keep working. Off by default.

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -AllowedGroupId 5f0c...

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeGroupRead
#>
[CmdletBinding()]
param(
    [string]$TenantId,
    [string]$DisplayName = "TenuVault Desktop",
    [string]$AllowedGroupId,
    [switch]$IncludeGroupRead,
    [switch]$IncludeNotifications
)

$ErrorActionPreference = "Stop"

# The Graph modules only load together at one version: a module built for another
# Microsoft.Graph.Authentication version fails with an assembly conflict. Use the newest
# installed Authentication version and install the other modules at that same version.
$graphModules = "Microsoft.Graph.Applications", "Microsoft.Graph.Identity.SignIns"
$loaded = Get-Module -Name Microsoft.Graph.Authentication
if ($loaded) {
    $graphVersion = $loaded.Version
} else {
    $graphVersion = (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1).Version
    if (-not $graphVersion) {
        # Without an installed Authentication module no Graph module can be loaded, so nothing conflicts.
        Write-Host "Installing Microsoft.Graph.Authentication for the current user..."
        try {
            Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
        } catch {
            throw "Could not install Microsoft.Graph.Authentication. Check that the PowerShell Gallery is reachable, then run the script again. $($_.Exception.Message)"
        }
        $graphVersion = (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1).Version
    }
}
# Any Graph module of another version already loaded in this session would conflict.
$other = Get-Module -Name "Microsoft.Graph.*" | Where-Object Version -ne $graphVersion | Select-Object -First 1
if ($other) {
    throw "$($other.Name) $($other.Version) is already loaded in this PowerShell session, but the script needs version $graphVersion. Open a new PowerShell window and run the script again."
}
foreach ($module in $graphModules) {
    if (-not (Get-Module -ListAvailable -Name $module | Where-Object Version -eq $graphVersion)) {
        Write-Host "Installing $module $graphVersion for the current user..."
        try {
            Install-Module $module -RequiredVersion $graphVersion -Scope CurrentUser -Force -AllowClobber
        } catch {
            throw "Could not install $module $graphVersion, the version that matches Microsoft.Graph.Authentication $graphVersion. Check that the PowerShell Gallery is reachable, or update the installed Microsoft Graph modules to one version with 'Get-InstalledModule Microsoft.Graph* | Update-Module', then run the script again. $($_.Exception.Message)"
        }
    }
}
if (-not $loaded) { Import-Module Microsoft.Graph.Authentication -RequiredVersion $graphVersion }
foreach ($module in $graphModules) { Import-Module $module -RequiredVersion $graphVersion }

$connectParams = @{
    Scopes    = "Application.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"
    NoWelcome = $true
}
if ($TenantId) { $connectParams.TenantId = $TenantId }
Connect-MgGraph @connectParams
$context = Get-MgContext

# Delegated permissions per resource. TenuVault only uses what is listed here.
$resources = @(
    @{
        Name   = "Microsoft Graph"
        AppId  = "00000003-0000-0000-c000-000000000000"
        Scopes = @(
            "User.Read",
            "Organization.Read.All",
            "Policy.Read.All",
            "DeviceManagementConfiguration.ReadWrite.All",
            "DeviceManagementApps.ReadWrite.All",
            "DeviceManagementServiceConfig.ReadWrite.All",
            "DeviceManagementScripts.ReadWrite.All",
            "DeviceManagementRBAC.ReadWrite.All",
            "DeviceManagementManagedDevices.Read.All"
        )
    },
    @{
        # Lists subscriptions and storage accounts in the backup storage picker.
        Name   = "Azure Service Management"
        AppId  = "797f4846-ba00-4fd7-ba43-dac1f8f63013"
        Scopes = @("user_impersonation")
    },
    @{
        # Backup storage account (blob data plane).
        Name   = "Azure Storage"
        AppId  = "e406a681-f3d4-42a8-90b6-c2b029497af1"
        Scopes = @("user_impersonation")
    }
)

if ($IncludeGroupRead) {
    # Opt-in only: lets the hygiene unresolved groups check read group existence.
    $resources[0].Scopes += "Group.Read.All"
}

if ($IncludeNotifications) {
    # Opt-in only: notification email as the signed-in admin, plus group recipient resolution.
    $resources[0].Scopes += "Mail.Send"
    $resources[0].Scopes += "GroupMember.Read.All"
    # Reading other members' mail and userType needs their basic profile properties.
    $resources[0].Scopes += "User.Read.All"
}

$requiredResourceAccess = @()
foreach ($resource in $resources) {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$($resource.AppId)'"
    if (-not $sp) {
        Write-Host "Adding the $($resource.Name) service principal to the tenant..."
        $sp = New-MgServicePrincipal -AppId $resource.AppId
    }
    $resource.ServicePrincipalId = $sp.Id
    $access = foreach ($scope in $resource.Scopes) {
        $permission = $sp.Oauth2PermissionScopes | Where-Object Value -eq $scope
        if (-not $permission) { throw "Delegated permission $scope was not found on $($resource.Name)." }
        @{ Id = $permission.Id; Type = "Scope" }
    }
    $requiredResourceAccess += @{ ResourceAppId = $resource.AppId; ResourceAccess = @($access) }
}

Write-Host "Creating app registration '$DisplayName'..."
$app = New-MgApplication -DisplayName $DisplayName `
    -SignInAudience "AzureADMyOrg" `
    -RequiredResourceAccess $requiredResourceAccess `
    -Notes "Used by the TenuVault desktop app. Delegated permissions only, no credentials."

Update-MgApplication -ApplicationId $app.Id -PublicClient @{
    RedirectUris = @("http://localhost")
}

$appSp = New-MgServicePrincipal -AppId $app.AppId -Tags "HideApp", "WindowsAzureActiveDirectoryIntegratedApp"

Write-Host "Granting admin consent..."
foreach ($resource in $resources) {
    New-MgOauth2PermissionGrant -ClientId $appSp.Id -ConsentType "AllPrincipals" `
        -ResourceId $resource.ServicePrincipalId -Scope ($resource.Scopes -join " ") | Out-Null
}

if ($AllowedGroupId) {
    Write-Host "Limiting sign-in to members of group $AllowedGroupId..."
    Update-MgServicePrincipal -ServicePrincipalId $appSp.Id -AppRoleAssignmentRequired:$true
    New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $appSp.Id -PrincipalId $AllowedGroupId `
        -ResourceId $appSp.Id -AppRoleId ([Guid]::Empty) | Out-Null
}

Write-Host ""
Write-Host "Done. Enter these values in TenuVault > Tenants > Connect tenant:" -ForegroundColor Green
Write-Host "  Tenant id:                $($context.TenantId)"
Write-Host "  Application (client) id:  $($app.AppId)"
Write-Host ""
Write-Host "The admins who use TenuVault also need an Intune role (for example Intune Administrator)."
Write-Host "For backups, schedules and the audit log in an Azure storage account they also need 'Storage"
Write-Host "Blob Data Contributor' and read access on that account (see New-TenuVaultStorage.ps1)."
if (-not $AllowedGroupId) {
    Write-Host ""
    Write-Host "Recommended: any user in the tenant can sign in to this app registration. To limit sign-in to" -ForegroundColor Yellow
    Write-Host "your admins, add them to a security group, then in Entra ID > Enterprise applications >" -ForegroundColor Yellow
    Write-Host "'$DisplayName' assign the group and set 'Assignment required' to Yes. Add yourself to the" -ForegroundColor Yellow
    Write-Host "group first so you do not lock yourself out. Group assignment needs Entra ID P1 or P2, and only" -ForegroundColor Yellow
    Write-Host "direct members get access (nested groups do not). New registrations can use -AllowedGroupId instead." -ForegroundColor Yellow
}
