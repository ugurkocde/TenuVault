param(
    [ValidateSet("Container", "ReaderContainer", "RoleDefinition", "RoleAssignment")][string]$Denial,
    [string]$SetupPath = (Join-Path $PSScriptRoot "../../../resources/New-TenuVaultStorage.ps1")
)
$ErrorActionPreference = "Stop"
$fixtureCalls = [System.Collections.Generic.List[string]]::new()
$fixtureGroup = "/subscriptions/demo/resourceGroups/demo"
$fixtureAccount = "$fixtureGroup/providers/Microsoft.Storage/storageAccounts/stcontoso"
function Get-Module { param([switch]$ListAvailable, $Name) $true }
function Get-AzContext { @{ Subscription = @{ Name = "Demo"; Id = "demo" } } }
function Get-AzResourceGroup {
    [CmdletBinding()] param($Name)
    @{ Location = "westus"; ResourceId = $fixtureGroup }
}
function Get-AzStorageAccount {
    [CmdletBinding()] param($ResourceGroupName, $Name)
    @{ Id = $fixtureAccount; Kind = "StorageV2"; Sku = @{ Name = "Standard_LRS" }; AccessTier = "Hot"
        MinimumTlsVersion = "TLS1_2"; AllowBlobPublicAccess = $false; AllowSharedKeyAccess = $false
        EnableHttpsTrafficOnly = $true; Location = "westus" }
}
function Get-AzStorageBlobServiceProperty {
    param($ResourceGroupName, $StorageAccountName)
    @{ DeleteRetentionPolicy = @{ Enabled = $false }; ContainerDeleteRetentionPolicy = @{ Enabled = $false }; IsVersioningEnabled = $false }
}
function Enable-AzStorageBlobDeleteRetentionPolicy { $fixtureCalls.Add("blob soft delete") }
function Enable-AzStorageContainerDeleteRetentionPolicy { $fixtureCalls.Add("container soft delete") }
function Get-AzStorageAccountNetworkRuleSet {
    param($ResourceGroupName, $Name)
    if ($fixtureCalls.Count -gt 2) { $fixtureCalls.Add("final firewall read") }
    @{ DefaultAction = "Allow" }
}
function Get-AzADServicePrincipal { param($ApplicationId) @{ Id = "reader-principal" } }
function Get-AzRmStorageContainer { [CmdletBinding()] param($ResourceGroupName, $StorageAccountName, $Name) }
function New-AzRmStorageContainer {
    [CmdletBinding()] param($ResourceGroupName, $StorageAccountName, $Name, $PublicAccess)
    if ($Name -eq "audit-logs") {
        $fixtureCalls.Add("audit:container")
        if ($Denial -in @("Container", "ReaderContainer")) { Write-Error "RequestDisallowedByPolicy ($Name)" }
    } else { $fixtureCalls.Add("create $Name") }
}
function Get-AzRoleDefinition {
    [CmdletBinding()] param($Name)
    if ($Name -eq "TenuVault Backup Writer") {
        [pscustomobject]@{ Id = "backup-writer"; AssignableScopes = @($fixtureGroup); Actions = @()
            DataActions = @("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write") }
    }
}
function Invoke-AzRestMethod {
    param($Method, $Path, $Payload)
    $fixtureCalls.Add("audit:definition")
    if ($Denial -eq "RoleDefinition") { return @{ StatusCode = 403 } }
    @{ StatusCode = 201 }
}
function Get-AzRoleAssignment { [CmdletBinding()] param($ObjectId, $RoleDefinitionName, $Scope) }
function New-AzRoleAssignment {
    [CmdletBinding()] param($ObjectId, $RoleDefinitionName, $RoleDefinitionId, $Scope)
    if ($Scope.EndsWith("/audit-logs")) {
        $fixtureCalls.Add("audit:assignment")
        if ($Denial -eq "RoleAssignment") { Write-Error "AuthorizationFailed (audit assignment)" }
    } elseif ($RoleDefinitionId -eq "backup-writer") { $fixtureCalls.Add("assign backup writer") }
    else { $fixtureCalls.Add("assign $RoleDefinitionName") }
}
function Update-AzStorageBlobServiceProperty { $fixtureCalls.Add("versioning") }
function Get-AzStorageAccountManagementPolicy { [CmdletBinding()] param($ResourceGroupName, $StorageAccountName) }
function Add-AzStorageAccountManagementPolicyAction { "delete previous versions" }
function New-AzStorageAccountManagementPolicyFilter { "backups only" }
function New-AzStorageAccountManagementPolicyRule { "retain previous versions" }
function Set-AzStorageAccountManagementPolicy { $fixtureCalls.Add("lifecycle") }

$argsForSetup = @{ ResourceGroupName = "demo"; StorageAccountName = "stcontoso"
    AdminGroupId = "11111111-2222-4333-8444-555555555555"; WarningAction = "Stop" }
if ($Denial -ne "Container") { $argsForSetup.BackupReaderAppId = "55555555-4444-4333-8222-111111111111" }
& $SetupPath @argsForSetup
@{ calls = $fixtureCalls.ToArray() } | ConvertTo-Json -Compress
