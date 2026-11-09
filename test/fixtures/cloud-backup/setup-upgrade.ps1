<#
.SYNOPSIS
    Runs the upgrade step and the -Remove step of New-TenuVaultCloudBackup.ps1 on a setup from
    before runbook 1.2.0, against mocked Az cmdlets that keep the runbook's draft and published
    content, and writes one JSON line per scenario.
#>
[CmdletBinding()]
param([string]$SetupPath)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
if (-not $SetupPath) { $SetupPath = Join-Path $repoRoot "resources/New-TenuVaultCloudBackup.ps1" }

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
$runbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultBackup.ps1"
$TenantId = "11111111-2222-3333-4444-555555555555"
$tenantKey = "11111111"
$scheduleName = "TenuVaultBackup-$tenantKey"
$StorageAccountName = "stcontoso"
$Scope = "policies"
$ExcludedFolders = ""
$appOnlyExcluded = "DeviceCategories,DeviceCleanupRules"
$graphRoleNames = @("DeviceManagementConfiguration.Read.All")
$variableNames = @(
    "TenuVaultTenantId-$tenantKey", "TenuVaultStorageAccount-$tenantKey",
    "TenuVaultScope-$tenantKey", "TenuVaultExcludedFolders-$tenantKey", "TenuVaultAppOnlyExcluded-$tenantKey"
)
$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"
$plainRunbookVersion = "1.2.0"
$oldRunbook = '$script:RunbookVersion = "1.1.0"'

# Mocked Azure state.
$script:variables = @{}
$script:actions = [System.Collections.Generic.List[string]]::new()
$script:draft = $null
$script:published = $null
$script:schedule = $false
$script:link = $false
$script:declineImport = $false
$script:publishBehavior = "publish"
$script:declineVariable = $null

function Import-AzAutomationRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, $Path, $Type, $Description, [switch]$Force)
    $script:actions.Add("import confirm=$(if ($PSBoundParameters.ContainsKey('Confirm')) { [bool]$PSBoundParameters['Confirm'] } else { 'unset' })")
    # The cmdlet asks for its own confirmation; a declined one imports nothing.
    if ($script:declineImport) { return }
    $script:draft = Get-Content -Raw -Path $Path
}
function Publish-AzAutomationRunbook {
    param($ResourceGroupName, $AutomationAccountName, $Name)
    $script:actions.Add("publish")
    if ($script:publishBehavior -eq "throw") { throw "Publishing the runbook failed." }
    if ($script:publishBehavior -eq "nothing") { return }
    $script:published = $script:draft
}
function Export-AzAutomationRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, $Slot, $OutputFolder, [switch]$Force)
    $script:actions.Add("export $Slot")
    if ($null -eq $script:published) { throw "The runbook has no published content." }
    Set-Content -Path (Join-Path $OutputFolder "$Name.ps1") -Value $script:published
    return Get-Item -Path $OutputFolder
}
function Get-AzAutomationVariable {
    param($ResourceGroupName, $AutomationAccountName, $Name, $ErrorAction)
    if ($script:variables.ContainsKey($Name)) { return [pscustomobject]@{ Name = $Name; Value = $script:variables[$Name] } }
}
function Set-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variables[$Name] = $Value }
function New-AzAutomationVariable { param($ResourceGroupName, $AutomationAccountName, $Name, $Encrypted, $Value) $script:variables[$Name] = $Value }
function Remove-AzAutomationVariable {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    # A variable whose own confirmation the admin declines stays.
    if ($Name -eq $script:declineVariable) { $script:actions.Add("declined remove $Name"); return }
    $script:actions.Add("remove $Name")
    [void]$script:variables.Remove($Name)
}
function Get-AzResource {
    param($ResourceGroupName, $Name, $ResourceType, $ErrorAction)
    if ($ResourceType -eq "Microsoft.KeyVault/vaults") { return [pscustomobject]@{ Name = "kv-tenuvault-abc123" } }
    return [pscustomobject]@{ Identity = [pscustomobject]@{ PrincipalId = "00000000-0000-0000-0000-00000000aaaa" } }
}
function Get-AzAutomationAccount { param($ResourceGroupName, $Name, $ErrorAction) [pscustomobject]@{ AutomationAccountName = $Name } }
function Unregister-AzAutomationScheduledRunbook {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName, [switch]$Force)
    $script:actions.Add("unlink")
    $script:link = $false
}
function Get-AzAutomationScheduledRunbook {
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName, $ErrorAction)
    if (-not $script:link) { throw "The job schedule was not found." }
    [pscustomobject]@{ RunbookName = $RunbookName; ScheduleName = $ScheduleName }
}
function Get-AzAutomationSchedule { param($ResourceGroupName, $AutomationAccountName, $Name, $ErrorAction) if ($script:schedule) { [pscustomobject]@{ Name = $Name } } }
function Remove-AzAutomationSchedule {
    [CmdletBinding(SupportsShouldProcess)]
    param($ResourceGroupName, $AutomationAccountName, $Name, [switch]$Force)
    $script:actions.Add("remove schedule")
    $script:schedule = $false
}

# A setup from before 1.2.0: its published runbook (and an older draft) read the vault through the variable.
function Reset-OldSetup {
    $script:variables = @{ $legacyKeyVaultVariable = "kv-tenuvault-abc123" }
    foreach ($name in $variableNames) { $script:variables[$name] = "x" }
    $script:actions.Clear()
    $script:draft = $oldRunbook
    $script:published = $oldRunbook
    $script:schedule = $true
    $script:link = $true
    $script:declineImport = $false
    $script:publishBehavior = "publish"
    $script:declineVariable = $null
}

function Write-Scenario {
    param([string]$Name, [object]$Runbook, [object]$ErrorText, [object[]]$Output)
    Write-Output (@{
        scenario = $Name
        plain = if ($Runbook) { [bool]$Runbook.Plain } else { $false }
        reason = if ($Runbook) { $Runbook.Reason } else { $null }
        error = $ErrorText
        actions = @($script:actions.ToArray())
        legacyVariableKept = $script:variables.ContainsKey($legacyKeyVaultVariable)
        variables = @($script:variables.Keys | Sort-Object)
        schedule = $script:schedule
        link = $script:link
        output = @($Output | ForEach-Object { [string]$_ })
    } | ConvertTo-Json -Compress -Depth 5)
}

# Upgrade runs: approved, the outer step declined, the import's own prompt declined with an old
# draft present, the publish throwing, and a publish that leaves the older version published.
foreach ($scenario in "approved", "outer-declined", "import-declined", "publish-throws", "published-older") {
    Reset-OldSetup
    $PSDefaultParameterValues = @{}
    if ($scenario -eq "outer-declined") { $PSDefaultParameterValues["Publish-TenuVaultRunbook:WhatIf"] = $true }
    if ($scenario -eq "import-declined") { $script:declineImport = $true }
    if ($scenario -eq "publish-throws") { $script:publishBehavior = "throw" }
    if ($scenario -eq "published-older") { $script:publishBehavior = "nothing" }
    $runbook = $null
    $errorText = $null
    $output = @()
    try {
        $output = @(. $upgradeStep 6>&1)
        $output += @(Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults -KeptBecause $runbook.Reason 6>&1)
    } catch { $errorText = $_.Exception.Message }
    $PSDefaultParameterValues = @{}
    Write-Scenario -Name $scenario -Runbook $runbook -ErrorText $errorText -Output $output
}

# -Remove runs: complete, -WhatIf, and one variable's own confirmation declined.
foreach ($scenario in "remove-complete", "remove-whatif", "remove-variable-declined") {
    Reset-OldSetup
    if ($scenario -eq "remove-variable-declined") { $script:declineVariable = "TenuVaultScope-$tenantKey" }
    $output = if ($scenario -eq "remove-whatif") { @(Remove-TenuVaultCloudBackupSetup -WhatIf 6>&1) } else { @(Remove-TenuVaultCloudBackupSetup 6>&1) }
    Write-Scenario -Name $scenario -Output $output
}
