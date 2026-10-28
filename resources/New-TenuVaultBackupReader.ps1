<#
.SYNOPSIS
    Creates or updates the read-only Backup Reader app registration for TenuVault scheduled backups.

.DESCRIPTION
    Optional. TenuVault normally works as the signed-in admin only. When Conditional Access
    session controls (for example sign-in frequency for admin roles) end that session at night,
    scheduled backups stop until an admin signs in again. The Backup Reader is a separate,
    read-only identity that only scheduled backups use; every manual backup, restore and other
    change still uses the admin's own sign-in, MFA and Conditional Access.

    The script:
      * creates a single-tenant app registration "TenuVault Backup Reader", or updates the one
        given with -AppId or found by name
      * sets its Microsoft Graph application permissions to exactly the read permissions below
        and removes any other permission granted to it, so it can never change Intune
      * uploads the certificate exported from TenuVault (Settings > Backup Reader); the private
        key never leaves the computer that runs TenuVault
      * grants admin consent for those permissions

    Permissions (application, read-only):
      DeviceManagementApps.Read.All, DeviceManagementConfiguration.Read.All,
      DeviceManagementRBAC.Read.All, DeviceManagementScripts.Read.All,
      DeviceManagementServiceConfig.Read.All
    With -IncludeDeviceCategories also DeviceManagementManagedDevices.Read.All.

    What it can and cannot do: it reads all Intune configuration tenant-wide, including script
    contents, without Intune role scope tags limiting it. It cannot read encrypted OMA-URI values
    in plain text (Microsoft requires a write permission for that), so scheduled backups store
    those values masked and a manual backup captures them. Treat the certificate on the TenuVault
    computer like an admin credential: remove it from the app registration when the computer is
    retired.

    Requires the Microsoft.Graph.Applications module and a Global Administrator, Privileged Role
    Administrator or Cloud Application Administrator account. Granting application permissions
    needs Global Administrator or Privileged Role Administrator.

.PARAMETER CertificatePath
    The certificate file exported from TenuVault (.cer or .pem). Required.

.PARAMETER TenantId
    Tenant of the app registration. Defaults to the tenant of the account you sign in with.

.PARAMETER AppId
    Application (client) ID of an existing Backup Reader, to add a renewal certificate or a
    second computer's certificate. When omitted, an app registration named -DisplayName is reused.

.PARAMETER DisplayName
    Name of the app registration. Default: "TenuVault Backup Reader".

.PARAMETER IncludeDeviceCategories
    Also grants DeviceManagementManagedDevices.Read.All, which device categories and device
    cleanup rules need. It also exposes the managed device inventory (device names, serial
    numbers, primary users), so it is off by default; without it scheduled backups leave those
    two types out and manual backups include them.

.EXAMPLE
    ./New-TenuVaultBackupReader.ps1 -CertificatePath ./TenuVault-Backup-Reader.cer -TenantId contoso.onmicrosoft.com

.EXAMPLE
    ./New-TenuVaultBackupReader.ps1 -CertificatePath ./renewal.cer -AppId 4f1e...
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$CertificatePath,
    [string]$TenantId,
    [string]$AppId,
    [string]$DisplayName = "TenuVault Backup Reader",
    [switch]$IncludeDeviceCategories
)

$ErrorActionPreference = "Stop"

# Validate the certificate before the first Graph call, so a wrong file changes nothing.
if (-not (Test-Path -LiteralPath $CertificatePath)) { throw "Certificate file '$CertificatePath' was not found. Export it in TenuVault > Settings > Backup Reader." }
try {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)
} catch {
    throw "'$CertificatePath' is not a certificate file. Export it in TenuVault > Settings > Backup Reader. $($_.Exception.Message)"
}
if ($certificate.HasPrivateKey) { throw "'$CertificatePath' contains a private key. Upload only the certificate TenuVault exports; the private key must stay on the TenuVault computer." }
if ($certificate.NotAfter -le (Get-Date)) { throw "The certificate expired on $($certificate.NotAfter). Create a new one in TenuVault > Settings > Backup Reader." }
if ($AppId -and $AppId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw "-AppId must be an application (client) ID." }
$thumbprint = $certificate.Thumbprint

# The Graph modules only load together at one version (see New-TenuVaultDesktopApp.ps1).
$graphModules = "Microsoft.Graph.Applications"
$loaded = Get-Module -Name Microsoft.Graph.Authentication
if ($loaded) {
    $graphVersion = $loaded.Version
} else {
    $graphVersion = (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1).Version
    if (-not $graphVersion) {
        Write-Host "Installing Microsoft.Graph.Authentication for the current user..."
        try {
            Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
        } catch {
            throw "Could not install Microsoft.Graph.Authentication. Check that the PowerShell Gallery is reachable, then run the script again. $($_.Exception.Message)"
        }
        $graphVersion = (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1).Version
    }
}
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
            throw "Could not install $module $graphVersion, the version that matches Microsoft.Graph.Authentication $graphVersion. Update the installed Microsoft Graph modules to one version with 'Get-InstalledModule Microsoft.Graph* | Update-Module', then run the script again. $($_.Exception.Message)"
        }
    }
}
if (-not $loaded) { Import-Module Microsoft.Graph.Authentication -RequiredVersion $graphVersion }
foreach ($module in $graphModules) { Import-Module $module -RequiredVersion $graphVersion }

$connectParams = @{
    Scopes    = "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"
    NoWelcome = $true
}
if ($TenantId) { $connectParams.TenantId = $TenantId }
Connect-MgGraph @connectParams
$context = Get-MgContext

$graphAppId = "00000003-0000-0000-c000-000000000000"
$roles = @(
    "DeviceManagementApps.Read.All",
    "DeviceManagementConfiguration.Read.All",
    "DeviceManagementRBAC.Read.All",
    "DeviceManagementScripts.Read.All",
    "DeviceManagementServiceConfig.Read.All"
)
if ($IncludeDeviceCategories) { $roles += "DeviceManagementManagedDevices.Read.All" }

$graph = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"
$wanted = foreach ($role in $roles) {
    $appRole = $graph.AppRoles | Where-Object { $_.Value -eq $role -and $_.AllowedMemberTypes -contains "Application" }
    if (-not $appRole) { throw "Application permission $role was not found on Microsoft Graph." }
    $appRole
}
$requiredResourceAccess = @(@{ ResourceAppId = $graphAppId; ResourceAccess = @($wanted | ForEach-Object { @{ Id = $_.Id; Type = "Role" } }) })

if ($AppId) {
    $app = Get-MgApplication -Filter "appId eq '$AppId'"
    if (-not $app) { throw "No app registration with application ID $AppId exists in tenant $($context.TenantId)." }
} else {
    $found = @(Get-MgApplication -Filter "displayName eq '$($DisplayName.Replace("'", "''"))'")
    if ($found.Count -gt 1) { throw "$($found.Count) app registrations are named '$DisplayName'. Pass the Backup Reader's -AppId." }
    $app = $found | Select-Object -First 1
}
$notes = "TenuVault Backup Reader: read-only, app-only identity for TenuVault scheduled backups. Certificates only; each certificate belongs to one TenuVault computer."

if (-not $app) {
    Write-Host "Creating app registration '$DisplayName'..."
    if (-not $PSCmdlet.ShouldProcess($DisplayName, "Create app registration")) { return }
    $app = New-MgApplication -DisplayName $DisplayName -SignInAudience "AzureADMyOrg" -RequiredResourceAccess $requiredResourceAccess -Notes $notes
} else {
    Write-Host "Updating app registration '$($app.DisplayName)' ($($app.AppId))..."
    if ($app.PasswordCredentials.Count -gt 0) {
        Write-Warning "This app registration has $($app.PasswordCredentials.Count) client secret(s). TenuVault never uses secrets; remove them in Entra ID > App registrations > '$($app.DisplayName)' > Certificates & secrets."
    }
    if ($PSCmdlet.ShouldProcess($app.AppId, "Set the read-only permissions")) {
        Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess $requiredResourceAccess -Notes $notes
    }
}

# Add the certificate next to the existing ones (a renewal or another computer). The update
# replaces the whole list, and Microsoft Graph refuses any change to an existing certificate
# (KeyNotUpdatable), so existing certificates are sent back exactly as Graph returns them. Only
# a read that selects keyCredentials includes their key bytes.
$keys = @((Get-MgApplication -ApplicationId $app.Id -Property "keyCredentials").KeyCredentials | Where-Object { $_ })
$raw = [Convert]::ToBase64String($certificate.RawData)
if ($keys | Where-Object { $_.Key -and [Convert]::ToBase64String($_.Key) -eq $raw }) {
    Write-Host "The certificate $thumbprint is already on the app registration."
} elseif ($PSCmdlet.ShouldProcess($app.AppId, "Add certificate $thumbprint")) {
    if ($keys | Where-Object { -not $_.Key }) {
        throw "Microsoft Graph did not return the existing certificates of '$($app.DisplayName)', so adding one could remove them. Add '$CertificatePath' in Entra ID > App registrations > '$($app.DisplayName)' > Certificates & secrets instead."
    }
    Write-Host "Adding certificate $thumbprint ($($certificate.Subject), valid until $($certificate.NotAfter.ToString('yyyy-MM-dd')))..."
    $existing = $keys | ForEach-Object {
        @{
            CustomKeyIdentifier = $_.CustomKeyIdentifier
            DisplayName         = $_.DisplayName
            EndDateTime         = $_.EndDateTime
            Key                 = $_.Key
            KeyId               = $_.KeyId
            StartDateTime       = $_.StartDateTime
            Type                = $_.Type
            Usage               = $_.Usage
        }
    }
    $new = @{
        Type        = "AsymmetricX509Cert"
        Usage       = "Verify"
        Key         = $certificate.RawData
        DisplayName = $certificate.Subject
    }
    Update-MgApplication -ApplicationId $app.Id -KeyCredentials @(@($existing) + $new)
}

$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'"
if (-not $sp) {
    if (-not $PSCmdlet.ShouldProcess($app.AppId, "Create service principal")) { return }
    $sp = New-MgServicePrincipal -AppId $app.AppId -Tags "HideApp"
}

# Exactly the wanted permissions: remove any other application permission granted to the reader,
# then grant the missing ones. TenuVault refuses a reader with any permission beyond this list.
$assigned = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All)
foreach ($assignment in $assigned) {
    $keep = $assignment.ResourceId -eq $graph.Id -and ($wanted.Id -contains $assignment.AppRoleId)
    if (-not $keep -and $PSCmdlet.ShouldProcess($app.AppId, "Remove permission $($assignment.AppRoleId) on $($assignment.ResourceDisplayName)")) {
        $name = ($graph.AppRoles | Where-Object Id -eq $assignment.AppRoleId).Value
        Write-Host "Removing permission $(if ($name) { $name } else { $assignment.AppRoleId }) on $($assignment.ResourceDisplayName): the Backup Reader stays read-only."
        Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -AppRoleAssignmentId $assignment.Id
    }
}
Write-Host "Granting admin consent..."
foreach ($role in $wanted) {
    $present = $assigned | Where-Object { $_.ResourceId -eq $graph.Id -and $_.AppRoleId -eq $role.Id }
    if (-not $present -and $PSCmdlet.ShouldProcess($app.AppId, "Grant $($role.Value)")) {
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId $role.Id | Out-Null
    }
}

Write-Host ""
if ($WhatIfPreference) {
    Write-Host "What if: no changes were made." -ForegroundColor Yellow
    return
}
Write-Host "Done. In TenuVault > Settings > Backup Reader, enter this application ID and select Verify:" -ForegroundColor Green
Write-Host "  Tenant id:                $($context.TenantId)"
Write-Host "  Application (client) id:  $($app.AppId)"
Write-Host "  Certificate thumbprint:   $thumbprint"
Write-Host ""
Write-Host "New permissions and certificates can take a few minutes to apply."
Write-Host "Backups in an Azure storage account: an Azure administrator also runs"
Write-Host "  ./New-TenuVaultStorage.ps1 ... -BackupReaderAppId $($app.AppId)"
Write-Host "which lets the Backup Reader write backups but not delete them."
Write-Host ""
Write-Host "Recommended: watch the Backup Reader in Entra ID > Sign-in logs > Service principal sign-ins." -ForegroundColor Yellow
Write-Host "With Microsoft Entra Workload ID Premium, a Conditional Access policy for workload identities" -ForegroundColor Yellow
Write-Host "can also limit it to the network your TenuVault computers use." -ForegroundColor Yellow
