param([string]$Script, [string]$ArgumentsFile, [string]$StateFile, [string]$OutputFile)
$ErrorActionPreference = 'Stop'
# Runs New-TenuVaultBackupReader.ps1 against stand-ins for the Microsoft Graph PowerShell commands it
# calls, and records what it asked them to do. $StateFile describes the tenant: the application
# permissions Microsoft Graph offers, and the app registration and permissions that already exist.
$global:tvState = Get-Content -Raw -Encoding UTF8 $StateFile | ConvertFrom-Json
$global:tvCalls = New-Object System.Collections.ArrayList
$global:tvVersion = [version]'2.25.0'
function global:Add-TvCall([string]$Name, $Value) { [void]$global:tvCalls.Add([pscustomobject]@{ Name = $Name; Value = $Value }) }
function global:Get-Module { param([string]$Name, [switch]$ListAvailable) [pscustomobject]@{ Name = $Name; Version = $global:tvVersion } }
function global:Install-Module { param($Name, $RequiredVersion, $Scope, [switch]$Force, [switch]$AllowClobber) }
function global:Import-Module { param($Name, $RequiredVersion) }
function global:Connect-MgGraph { param($Scopes, [switch]$NoWelcome, $TenantId) Add-TvCall 'connect' @($Scopes) }
function global:Get-MgContext { [pscustomobject]@{ TenantId = '11111111-1111-4111-8111-111111111111' } }
function global:Get-MgServicePrincipal {
    param($Filter)
    if ($Filter -like "*00000003-0000-0000-c000-000000000000*") {
        $roles = foreach ($name in $global:tvState.offered) { [pscustomobject]@{ Id = "role/$name"; Value = $name; AllowedMemberTypes = @('Application') } }
        return [pscustomobject]@{ Id = 'graph-sp'; AppRoles = @($roles) }
    }
    if ($global:tvState.existing) { return [pscustomobject]@{ Id = 'reader-sp' } }
}
function global:Get-MgApplication {
    param($Filter, $ApplicationId, $Property)
    if ($ApplicationId) { return [pscustomobject]@{ KeyCredentials = @() } }
    if ($global:tvState.existing) { return [pscustomobject]@{ Id = 'reader-object'; AppId = '44444444-4444-4444-8444-444444444444'; DisplayName = 'TenuVault Backup Reader'; PasswordCredentials = @() } }
}
function global:New-MgApplication {
    param($DisplayName, $SignInAudience, $RequiredResourceAccess, $Notes)
    Add-TvCall 'create' @($RequiredResourceAccess | ForEach-Object { $_.ResourceAccess | ForEach-Object { $_.Id } })
    [pscustomobject]@{ Id = 'reader-object'; AppId = '44444444-4444-4444-8444-444444444444'; DisplayName = $DisplayName }
}
function global:Update-MgApplication {
    param($ApplicationId, $RequiredResourceAccess, $Notes, $KeyCredentials)
    if ($RequiredResourceAccess) { Add-TvCall 'update' @($RequiredResourceAccess | ForEach-Object { $_.ResourceAccess | ForEach-Object { $_.Id } }) }
    if ($KeyCredentials) { Add-TvCall 'certificate' @($KeyCredentials).Count }
}
function global:New-MgServicePrincipal { param($AppId, $Tags) [pscustomobject]@{ Id = 'reader-sp' } }
function global:Get-MgServicePrincipalAppRoleAssignment {
    param($ServicePrincipalId, [switch]$All)
    foreach ($name in $global:tvState.assigned) { [pscustomobject]@{ Id = "assignment/$name"; ResourceId = 'graph-sp'; AppRoleId = "role/$name"; ResourceDisplayName = 'Microsoft Graph' } }
}
function global:Remove-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId, $AppRoleAssignmentId) Add-TvCall 'remove' $AppRoleAssignmentId }
function global:New-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId, $PrincipalId, $ResourceId, $AppRoleId) Add-TvCall 'grant' $AppRoleId }
$arguments = Get-Content -Raw -Encoding UTF8 $ArgumentsFile | ConvertFrom-Json
$parameters = @{}
foreach ($property in $arguments.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
$code = 0
try { & $Script @parameters 3>&1 | Out-String | Write-Output }
catch { Write-Output $_.Exception.Message; $code = 1 }
ConvertTo-Json -InputObject @($global:tvCalls) -Depth 6 | Set-Content -Encoding UTF8 $OutputFile
exit $code
