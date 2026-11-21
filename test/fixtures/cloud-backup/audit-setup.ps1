$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$groupScope = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/RG-Audit"
function Get-AzRoleDefinition { param($Name) return $script:role }
function Invoke-AzRestMethod {
    param($Method, $Path, $Payload)
    $script:writes.Add(@{ method = $Method; path = $Path; body = $Payload | ConvertFrom-Json })
    $definition = ($Payload | ConvertFrom-Json).properties
    $script:role = [pscustomobject]@{ Id = ([regex]::Match($Path, '/roleDefinitions/([0-9a-f-]+)')).Groups[1].Value
        Name = $definition.roleName; AssignableScopes = $definition.assignableScopes; Permissions = $definition.permissions }
    return @{ StatusCode = 201 }
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
