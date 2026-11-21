$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
. (Join-Path $repo "resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

$type = @{ Folder = "ConfigurationPolicies"; Label = "Settings catalog" }
$old = ConvertFrom-TvJson '{"id":"policy","name":"Policy","settings":[{"settingInstance":{"settingDefinitionId":"secret","simpleSettingValue":{"@odata.type":"#microsoft.graph.deviceManagementConfigurationSecretSettingValue","valueState":"encryptedValueToken","value":"before"}}}],"nested":{"children":[{"enabled":false}],"children@odata.nextLink":"next"}}'
$new = ConvertFrom-TvJson '{"id":"policy","name":"Policy","settings":[{"settingInstance":{"settingDefinitionId":"secret","simpleSettingValue":{"valueState":"encryptedValueToken","value":"after"}}}],"nested":{"children":[{"enabled":true}]}}'
$older = @{ Name = "older"; Metadata = @{ Items = @{ "ConfigurationPolicies/policy" = @{ file = "Policy.json"; hash = "old"; partialCollections = @("/nested/children") } } } }
$newer = @{ Name = "newer"; Metadata = @{ Items = @{ "ConfigurationPolicies/policy" = @{ file = "Policy.json"; hash = "new" } } } }
$read = { param($backup, $path) if ($backup -eq "older") { return Copy-TvDeep $old } else { return Copy-TvDeep $new } }
$off = Get-TvBackupDrifts $older $newer @($type) $read
$skipped = @{ Name = "newer"; Metadata = @{ Items = @{}; SkippedTypes = @($type.Folder) } }
$offWithOneSkip = Get-TvBackupDrifts $older $skipped @($type) $read
$newer.Metadata.OmissionVersion = 1
$newer.Metadata.ActualSkippedTypes = @()
$on = Get-TvBackupDrifts $older $newer @($type) $read
Write-Output (@{ off = $off; on = $on; offWithOneSkip = $offWithOneSkip } | ConvertTo-Json -Compress -Depth 25)
