$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$groupScope = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/RG-Audit"
function Get-AzRoleDefinition { param($Name) return $script:role }
function Invoke-AzRestMethod {
    param($Method, $Path, $Payload)
    $script:writes.Add(@{ method = $Method; path = $Path; body = $Payload | ConvertFrom-Json })
    $definition = ($Payload | ConvertFrom-Json).properties
    if ($Path -like "*/roleAssignments/*") {
        $key = $Path.Split("?")[0]
        if ($script:grants.ContainsKey($key)) { throw "Azure cannot change a role assignment's principal." }
        $script:grants[$key] = @{
            Scope = $key -replace '/providers/Microsoft.Authorization/roleAssignments/[^/]+$', ''
            ObjectId = $definition.principalId
            RoleDefinitionId = $definition.roleDefinitionId.Split("/")[-1]
            RoleDefinitionName = $script:role.Name
        }
        return @{ StatusCode = 201 }
    }
    $script:role = [pscustomobject]@{ Id = ([regex]::Match($Path, '/roleDefinitions/([0-9a-f-]+)')).Groups[1].Value
        Name = $definition.roleName; AssignableScopes = $definition.assignableScopes; Permissions = $definition.permissions }
    return @{ StatusCode = 201 }
}
function Get-AzRoleAssignment {
    [CmdletBinding()]
    param($ObjectId, $RoleDefinitionName, $RoleDefinitionId, $Scope)
    $script:grants.Values | Where-Object {
        $_.ObjectId -eq $ObjectId -and $_.Scope -eq $Scope -and
        (-not $RoleDefinitionName -or $_.RoleDefinitionName -eq $RoleDefinitionName) -and
        (-not $RoleDefinitionId -or $_.RoleDefinitionId -eq $RoleDefinitionId)
    }
}
function Provision-AuditRole {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$GroupScope)
    return Get-TenuVaultAuditRole $GroupScope
}

foreach ($file in @("New-TenuVaultStorage.ps1", "New-TenuVaultCloudBackup.ps1")) {
    $rolesFrom = Join-Path $root "resources/$file"
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($rolesFrom, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { throw "Failed to parse setup." }
    foreach ($func in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @("Get-TenuVaultAuditRole", "Get-TenuVaultAuditGuid") }, $false)) {
        . ([scriptblock]::Create($func.Extent.Text))
    }
    $script:role = $null
    $script:writes = [System.Collections.Generic.List[object]]::new()
    $created = Provision-AuditRole $groupScope
    $again = Provision-AuditRole $groupScope
    [Console]::WriteLine((@{ created = $created.Id; again = $again.Id; writes = $script:writes } | ConvertTo-Json -Depth 8 -Compress))
}

$grantAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith('if ($principalId) {') -and $node.Extent.Text.Contains('Assign the create-only audit role') }, $false)
$grantStep = [scriptblock]::Create($grantAst[0].Extent.Text)
function Grant-AuditRole {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$ResourceGroupName, [string]$principalId)
    $AutomationAccountName = "same-auto-account-name"
    $StorageAccountName = "stcontoso"
    $storageGroupScope = $groupScope
    $storageAccount = @{ Id = "$groupScope/providers/Microsoft.Storage/storageAccounts/$StorageAccountName" }
    $auditContainer = "audit-logs"
    $backupContainer = "intune-backups"
    . $grantStep
}
$script:grants = @{}
$script:writes.Clear()
Grant-AuditRole "rg-one" "22222222-2222-2222-2222-222222222222"
Grant-AuditRole "rg-two" "33333333-3333-3333-3333-333333333333"
Grant-AuditRole "rg-one" "22222222-2222-2222-2222-222222222222"
[void](Grant-AuditRole "RG-Audit" "44444444-4444-4444-4444-444444444444")
[Console]::WriteLine((@{ grants = $script:grants; writes = $script:writes } | ConvertTo-Json -Depth 8 -Compress))
