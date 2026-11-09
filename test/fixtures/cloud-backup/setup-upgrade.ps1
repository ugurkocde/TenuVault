<#
.SYNOPSIS
    Runs the runbook publish and variable step of New-TenuVaultCloudBackup.ps1 on a setup from
    before runbook 1.2.0, against mocked Az cmdlets, and writes one JSON line per scenario:
    the publish approved, then the publish declined while every other step is approved.
#>
[CmdletBinding()]
param([string]$SetupPath)

$ErrorActionPreference = "Stop"
if (-not $SetupPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $SetupPath = Join-Path $repoRoot "resources/New-TenuVaultCloudBackup.ps1"
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "The setup script does not parse." }
# The script's own functions, defined here without running the script.
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
# The script's own upgrade step, from the runbook import to the failure alert, run as written.
$text = $ast.Extent.Text
$start = $text.IndexOf("# Runbook import and publish")
$end = $text.IndexOf("# Failure alert")
if ($start -lt 0 -or $end -le $start) { throw "The upgrade step markers were not found." }
$upgradeStep = [scriptblock]::Create($text.Substring($start, $end - $start))

$ResourceGroupName = "rg-tenuvault-backups"
$AutomationAccountName = "aa-tenuvault"
$runbookName = "Invoke-TenuVaultBackup"
$runbookPath = "runbooks/Invoke-TenuVaultBackup.ps1"
$TenantId = "11111111-2222-3333-4444-555555555555"
$tenantKey = "11111111"
$StorageAccountName = "stcontoso"
$Scope = "policies"
$ExcludedFolders = ""
$appOnlyExcluded = "DeviceCategories,DeviceCleanupRules"
$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"

$script:variables = @{}
$script:actions = [System.Collections.Generic.List[string]]::new()
function Import-AzAutomationRunbook { $script:actions.Add("import") }
function Publish-AzAutomationRunbook { $script:actions.Add("publish") }
function Get-AzAutomationVariable {
    param($ResourceGroupName, $AutomationAccountName, $Name, $ErrorAction)
    if ($script:variables.ContainsKey($Name)) { return [pscustomobject]@{ Name = $Name; Value = $script:variables[$Name] } }
}
function Set-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variables[$Name] = $Value }
function New-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variables[$Name] = $Value }
function Remove-AzAutomationVariable {
    param($ResourceGroupName, $AutomationAccountName, $Name)
    $script:actions.Add("remove $Name")
    [void]$script:variables.Remove($Name)
}
function Get-AzResource { [pscustomobject]@{ Name = "kv-tenuvault-abc123" } }

foreach ($scenario in "approved", "declined") {
    # A setup from before 1.2.0: its runbook reads the vault through this variable.
    $script:variables = @{ $legacyKeyVaultVariable = "kv-tenuvault-abc123" }
    $script:actions.Clear()
    # Declining at the confirmation prompt is what -WhatIf answers for that one step.
    $PSDefaultParameterValues = @{}
    if ($scenario -eq "declined") { $PSDefaultParameterValues["Publish-TenuVaultRunbook:WhatIf"] = $true }
    $runbookPublished = $null
    $output = @(. $upgradeStep 6>&1 | ForEach-Object { [string]$_ })
    $output += @(Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults -RunbookPublished $runbookPublished 6>&1 | ForEach-Object { [string]$_ })
    $PSDefaultParameterValues = @{}
    Write-Output (@{
        scenario = $scenario
        published = [bool]$runbookPublished
        actions = @($script:actions.ToArray())
        legacyVariableKept = $script:variables.ContainsKey($legacyKeyVaultVariable)
        variables = @($script:variables.Keys | Sort-Object)
        output = $output
    } | ConvertTo-Json -Compress -Depth 5)
}
