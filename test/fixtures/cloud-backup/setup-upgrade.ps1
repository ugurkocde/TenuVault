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

# Az.Automation reports a missing resource as this exception type, written as a non-terminating error.
class ResourceNotFoundException : System.Exception {
    ResourceNotFoundException([string]$message) : base($message) { }
}
function Write-MockError {
    param([Parameter(Mandatory)]$Cmdlet, [Parameter(Mandatory)][System.Exception]$Exception)
    $Cmdlet.WriteError([System.Management.Automation.ErrorRecord]::new($Exception, "MockError", "NotSpecified", $null))
}
# Any lookup error that is not "not found": Azure did not answer, or refused the read.
function New-OutageException { [System.Net.Http.HttpRequestException]::new("The SSL connection could not be established.") }

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
$script:failLookups = $false
$script:failList = $false

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
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    if (-not $Name) {
        if ($script:failLookups -or $script:failList) { Write-MockError $PSCmdlet (New-OutageException); return }
        return @($script:variables.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $script:variables[$_] } })
    }
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    if ($script:variables.ContainsKey($Name)) { return [pscustomobject]@{ Name = $Name; Value = $script:variables[$Name] } }
    Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Variable $Name not found."))
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
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $RunbookName, $ScheduleName)
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    if (-not $script:link) { Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Job schedule for $RunbookName and $ScheduleName not found.")); return }
    [pscustomobject]@{ RunbookName = $RunbookName; ScheduleName = $ScheduleName }
}
function Get-AzAutomationSchedule {
    [CmdletBinding()]
    param($ResourceGroupName, $AutomationAccountName, $Name)
    if ($script:failLookups) { Write-MockError $PSCmdlet (New-OutageException); return }
    if ($script:schedule) { return [pscustomobject]@{ Name = $Name } }
    Write-MockError $PSCmdlet ([ResourceNotFoundException]::new("Schedule $Name not found."))
}
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
    $script:failLookups = $false
    $script:failList = $false
}
# Tenant B (22222222) shares the Automation account and still has its vault variable.
function Add-TenantB { $script:variables["TenuVaultKeyVault-22222222"] = "kv-tenuvault-abc123" }

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
foreach ($scenario in "approved", "outer-declined", "import-declined", "publish-throws", "published-older", "upgrade-tenant-b-remains", "upgrade-list-fails") {
    Reset-OldSetup
    if ($scenario -eq "upgrade-tenant-b-remains") { Add-TenantB }
    if ($scenario -eq "upgrade-list-fails") { $script:failList = $true }
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

# -Remove runs: complete, -WhatIf, one variable's own confirmation declined, -WhatIf while every
# lookup fails, a complete removal whose variable list fails, and tenant B still on the vault.
foreach ($scenario in "remove-complete", "remove-whatif", "remove-variable-declined", "remove-whatif-lookups-fail", "remove-list-fails", "remove-tenant-b-remains") {
    Reset-OldSetup
    if ($scenario -eq "remove-variable-declined") { $script:declineVariable = "TenuVaultScope-$tenantKey" }
    if ($scenario -eq "remove-whatif-lookups-fail") { $script:failLookups = $true }
    if ($scenario -eq "remove-list-fails") { $script:failList = $true }
    if ($scenario -eq "remove-tenant-b-remains") { Add-TenantB }
    $output = if ($scenario -like "remove-whatif*") { @(Remove-TenuVaultCloudBackupSetup -WhatIf 6>&1) } else { @(Remove-TenuVaultCloudBackupSetup 6>&1) }
    Write-Scenario -Name $scenario -Output $output
}
