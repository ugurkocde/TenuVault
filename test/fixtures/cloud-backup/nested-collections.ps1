$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
. (Join-Path $repo "resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

# The continuation page holds one more entry.
function Invoke-TvGraphList { param([string]$Path, [string]$Token) return , [object[]]@(@{ id = "from-continuation" }) }

$counts = [ordered]@{}
foreach ($count in 0, 1, 2) {
    # Parsed by the runbook's own JSON reader, as Graph responses are.
    $children = (@(0..2) | Select-Object -First $count | ForEach-Object { '{"id":"child-' + $_ + '"}' }) -join ","
    $object = ConvertFrom-TvJson ('{"id":"cfg-1","nested":{"children":[' + $children + '],"children@odata.nextLink":"https://graph.microsoft.com/beta/next"}}')
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    Expand-TvNestedCollections $object "token" $seen
    $counts["$count"] = @{
        count = @($object.nested.children).Count
        last = @($object.nested.children)[-1].id
        linkRemoved = -not $object.nested.Contains("children@odata.nextLink")
    }
}
$scalar = ConvertFrom-TvJson '{"id":"cfg-1","nested":{"children":"text","children@odata.nextLink":"https://graph.microsoft.com/beta/next"}}'
$refused = $null
try { Expand-TvNestedCollections $scalar "token" ([System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)) } catch { $refused = $_.Exception.Message }
Write-Output (@{ counts = $counts; scalar = $refused } | ConvertTo-Json -Compress -Depth 5)
