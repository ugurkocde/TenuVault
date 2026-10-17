<#
.SYNOPSIS
    Azure Automation watcher that sends TenuVault notification digests.

.DESCRIPTION
    Runs on a schedule in Azure Automation with a system assigned managed identity.
    Each run reads new Intune audit events from Microsoft Graph, checks the backup
    storage account for a missed backup, and delivers notification envelopes to the
    configured webhook, Teams Workflows endpoint and mail recipients.

    The library functions mirror src/shared/notifications in the desktop app: the same
    event identity (SHA256 of tenant, type and natural key), the same canonical JSON
    (object keys sorted recursively, no whitespace), the same audit mapping allowlist
    and the same digest wording. The shared fixture under test/fixtures/notifications
    proves the two implementations agree.

    State (watermark, recent audit event ids, sent event ids) lives in state.json in
    the tenuvault-notification-state container. A blob lease on state.json is taken
    before any delivery, so two overlapping runs cannot send the same digest twice.
    A heartbeat.json blob next to it lets the desktop app show that the watcher is
    alive.

    Payload allowlist: envelopes carry names, counts, statuses, timestamps and, when
    TenuVaultIncludeActor is true, actor UPNs. Audit request bodies and audit property
    values are never read, and secrets, tokens and URLs with query strings are never
    logged.

    Dot source the file with -LibraryOnly to load the library functions without
    running the watcher, which is how the parity check script uses it.
#>
[CmdletBinding()]
param(
    [switch]$LibraryOnly
)

# ---------------------------------------------------------------------------
# Small helpers shared by the library functions
# ---------------------------------------------------------------------------

function Get-TvProp {
    param([object]$InputObject, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) { return $InputObject[$Name] }
        return $null
    }
    $prop = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-TvText {
    param([object]$Value)
    if ($Value -is [string] -and $Value.Trim()) { return $Value.Trim() }
    return $null
}

function Get-TvClean {
    param([object]$Value, [Parameter(Mandatory)][int]$Max)
    if ($null -eq $Value) { return "" }
    $text = [string]$Value
    $text = $text -replace "[\x00-\x1F\x7F]+", " "
    $text = ($text -replace "\s+", " ").Trim()
    if ($text.Length -gt $Max) { $text = $text.Substring(0, $Max) }
    return $text
}

function ConvertTo-TvIso {
    param([object]$Value)
    if ($Value -is [DateTimeOffset]) {
        return $Value.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [DateTime]) {
        $utc = if ($Value.Kind -eq [DateTimeKind]::Local) { $Value.ToUniversalTime() } else { [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return $utc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    }
    $text = Get-TvText $Value
    if (-not $text) { return $null }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [DateTimeOffset]::TryParse($text, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { return $null }
    return $parsed.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-TvCapitalized {
    param([string]$Value)
    if (-not $Value) { return $Value }
    return $Value.Substring(0, 1).ToUpperInvariant() + $Value.Substring(1)
}

function Get-TvSafeError {
    param([object]$Value)
    # Error text can embed request URLs. Webhook and Teams URLs carry secrets in
    # their query strings, so URLs are stripped before anything is logged or stored.
    $text = [string]$Value -replace "https?://\S+", "[url]"
    return Get-TvClean $text 500
}

# ---------------------------------------------------------------------------
# Library: event identity, canonical JSON, envelope building
# ---------------------------------------------------------------------------

function Get-TenuVaultEventId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][string]$TenantId,
        [Parameter(Mandatory, Position = 1)][string]$Type,
        [Parameter(Mandatory, Position = 2)][AllowEmptyString()][string]$NaturalKey
    )
    $idInput = "$($TenantId.ToLowerInvariant())|$Type|$NaturalKey"
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($idInput)) } finally { $sha.Dispose() }
    return [BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
}

function ConvertTo-TvJsonString {
    param([string]$Value)
    $sb = [Text.StringBuilder]::new()
    [void]$sb.Append('"')
    foreach ($char in $Value.ToCharArray()) {
        switch ($char) {
            '"' { [void]$sb.Append('\"'); continue }
            '\' { [void]$sb.Append('\\'); continue }
            "`b" { [void]$sb.Append('\b'); continue }
            "`f" { [void]$sb.Append('\f'); continue }
            "`n" { [void]$sb.Append('\n'); continue }
            "`r" { [void]$sb.Append('\r'); continue }
            "`t" { [void]$sb.Append('\t'); continue }
            default {
                if ([int]$char -lt 0x20) { [void]$sb.Append(("\u{0:x4}" -f [int]$char)) }
                else { [void]$sb.Append($char) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-TenuVaultCanonicalJson {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0, ValueFromPipeline)][AllowNull()][object]$Value
    )
    process {
        if ($null -eq $Value) { return "null" }
        if ($Value -is [string]) { return ConvertTo-TvJsonString $Value }
        if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
        if ($Value -is [DateTime] -or $Value -is [DateTimeOffset]) { return ConvertTo-TvJsonString (ConvertTo-TvIso $Value) }
        if ($Value -is [byte] -or $Value -is [int] -or $Value -is [long] -or $Value -is [short] -or
            $Value -is [uint32] -or $Value -is [uint64] -or $Value -is [decimal] -or
            $Value -is [double] -or $Value -is [single]) {
            return ([IFormattable]$Value).ToString("R", [Globalization.CultureInfo]::InvariantCulture)
        }

        $pairs = $null
        if ($Value -is [System.Collections.IDictionary]) {
            $pairs = [System.Collections.Generic.List[object]]::new()
            foreach ($key in $Value.Keys) { $pairs.Add(@([string]$key, $Value[$key])) }
        } elseif ($Value -is [PSCustomObject]) {
            $pairs = [System.Collections.Generic.List[object]]::new()
            foreach ($prop in $Value.PSObject.Properties) { $pairs.Add(@($prop.Name, $prop.Value)) }
        }
        if ($null -ne $pairs) {
            $keys = [System.Collections.Generic.List[string]]::new()
            $byKey = @{}
            foreach ($pair in $pairs) { $keys.Add($pair[0]); $byKey[$pair[0]] = $pair[1] }
            $keys.Sort([StringComparer]::Ordinal)
            $parts = foreach ($key in $keys) {
                "$(ConvertTo-TvJsonString $key):$(ConvertTo-TenuVaultCanonicalJson $byKey[$key])"
            }
            return "{$($parts -join ',')}"
        }

        if ($Value -is [System.Collections.IEnumerable]) {
            $parts = @($Value | ForEach-Object { ConvertTo-TenuVaultCanonicalJson $_ })
            return "[$($parts -join ',')]"
        }

        $properties = @($Value.PSObject.Properties)
        if ($properties.Count -gt 0) {
            $keys = [System.Collections.Generic.List[string]]::new()
            $byKey = @{}
            foreach ($prop in $properties) { $keys.Add($prop.Name); $byKey[$prop.Name] = $prop.Value }
            $keys.Sort([StringComparer]::Ordinal)
            $parts = foreach ($key in $keys) {
                "$(ConvertTo-TvJsonString $key):$(ConvertTo-TenuVaultCanonicalJson $byKey[$key])"
            }
            return "{$($parts -join ',')}"
        }

        return ConvertTo-TvJsonString ([string]$Value)
    }
}

function New-TvEnvelope {
    param(
        [Parameter(Mandatory)][string]$Type,
        [Parameter(Mandatory)][string]$Severity,
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][string]$OccurredAt,
        [Parameter(Mandatory)][AllowEmptyString()][string]$NaturalKey,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Summary,
        [object[]]$Details,
        [object[]]$Items,
        [int]$MoreCount = 0,
        [string]$Source = "azure-watcher",
        [bool]$Test = $false
    )
    $tenant = [ordered]@{ id = $TenantId.ToLowerInvariant() }
    if ($TenantName) { $tenant["name"] = Get-TvClean $TenantName 200 }

    $itemList = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @($Items) | Select-Object -First 20) {
        if ($null -eq $item) { continue }
        $entry = [ordered]@{ title = Get-TvClean (Get-TvProp $item "title") 300 }
        if (Get-TvProp $item "detail") { $entry["detail"] = Get-TvClean (Get-TvProp $item "detail") 300 }
        if (Get-TvProp $item "actor") { $entry["actor"] = Get-TvClean (Get-TvProp $item "actor") 200 }
        if (Get-TvProp $item "at") { $entry["at"] = [string](Get-TvProp $item "at") }
        $itemList.Add([pscustomobject]$entry)
    }

    $detailList = [System.Collections.Generic.List[object]]::new()
    foreach ($detail in @($Details) | Select-Object -First 20) {
        if ($null -eq $detail) { continue }
        $detailList.Add([pscustomobject][ordered]@{
            label = Get-TvClean (Get-TvProp $detail "label") 80
            value = Get-TvClean (Get-TvProp $detail "value") 500
        })
    }

    $envelope = [ordered]@{
        schema     = "tenuvault.notification/v1"
        eventId    = Get-TenuVaultEventId $TenantId $Type $NaturalKey
        type       = $Type
        severity   = $Severity
        tenant     = [pscustomobject]$tenant
        occurredAt = $OccurredAt
        title      = Get-TvClean $Title 200
        summary    = Get-TvClean $Summary 1000
        details    = @($detailList.ToArray())
        items      = @($itemList.ToArray())
        moreCount  = [Math]::Max(0, $MoreCount)
        source     = $Source
    }
    if ($Test) { $envelope["test"] = $true }
    return [pscustomobject]$envelope
}

# ---------------------------------------------------------------------------
# Library: audit event mapping (same allowlist as audit.ts, nothing else is read)
# ---------------------------------------------------------------------------

function ConvertFrom-TenuVaultAuditEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [Alias("Event", "InputObject")]
        [AllowNull()][object]$Raw
    )
    process {
        if ($null -eq $Raw) { return }
        $id = Get-TvText (Get-TvProp $Raw "id")
        # Graph returns a string, but PowerShell JSON parsing can turn ISO timestamps
        # into DateTime values first. ConvertTo-TvIso accepts both and normalizes to UTC.
        $at = ConvertTo-TvIso (Get-TvProp $Raw "activityDateTime")
        if (-not $id -or -not $at) { return }

        $activity = Get-TvText (Get-TvProp $Raw "activity")
        $verb = Get-TvText (Get-TvProp $Raw "httpVerb")
        $activityLower = if ($activity) { $activity.ToLowerInvariant() } else { "" }
        $verbUpper = if ($verb) { $verb.ToUpperInvariant() } else { "" }
        $changeType = if ($activityLower.Contains("assign")) { "assigned" }
            elseif ($verbUpper -eq "POST") { "created" }
            elseif ($verbUpper -eq "PUT" -or $verbUpper -eq "PATCH") { "updated" }
            elseif ($verbUpper -eq "DELETE") { "deleted" }
            elseif ($activityLower.Contains("creat")) { "created" }
            elseif ($activityLower.Contains("delet") -or $activityLower.Contains("remov")) { "deleted" }
            elseif ($activityLower.Contains("updat") -or $activityLower.Contains("edit") -or $activityLower.Contains("patch")) { "updated" }
            else { "changed" }

        $resourceType = $null
        $url = Get-TvText (Get-TvProp $Raw "requestUrl")
        if ($url) {
            $path = $url -replace "^https?://[^/]+", ""
            $path = $path -replace "^/(beta|v1\.0)/", "/"
            $segments = @($path.Split("/") | Where-Object { $_ })
            $segment = $null
            for ($i = 0; $i -lt $segments.Count; $i++) {
                if ($segments[$i].ToLowerInvariant() -eq "devicemanagement") {
                    if ($i + 1 -lt $segments.Count) { $segment = $segments[$i + 1] }
                    break
                }
            }
            if ($null -eq $segment -and $path -notmatch "devicemanagement" -and $segments.Count -gt 0) {
                $hasDeviceManagement = @($segments | Where-Object { $_.ToLowerInvariant() -eq "devicemanagement" }).Count -gt 0
                if (-not $hasDeviceManagement) { $segment = $segments[0] }
            }
            if ($segment) {
                $decoded = [uri]::UnescapeDataString($segment)
                $resourceType = if ($decoded.Length -gt 120) { $decoded.Substring(0, 120) } else { $decoded }
            }
        }

        $resourceName = $null
        $resources = @(Get-TvProp $Raw "resources")
        if ($resources.Count -gt 0 -and $null -ne $resources[0] -and $resources[0] -isnot [string]) {
            foreach ($entry in $resources) {
                if ($null -eq $entry) { continue }
                $name = Get-TvText (Get-TvProp $entry "displayName")
                if ($name) {
                    $resourceName = if ($name.Length -gt 200) { $name.Substring(0, 200) } else { $name }
                    break
                }
            }
        }

        $category = Get-TvText (Get-TvProp $Raw "category")
        if (-not $category) { $category = "Unknown" }
        if (-not $activity) { $activity = "Change" }
        return [pscustomobject][ordered]@{
            auditId      = $id
            at           = $at
            category     = $category
            changeType   = $changeType
            resourceName = $resourceName
            resourceType = $resourceType
            actorUpn     = Get-TvText (Get-TvProp $Raw "initiatedByUpn")
            actorAppId   = Get-TvText (Get-TvProp $Raw "initiatedByAppId")
            activity     = $activity
        }
    }
}

function New-TenuVaultAuditDigest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Changes,
        [bool]$IncludeActor = $false,
        [object]$GapNotice
    )
    # Accept mapped changes, and raw Graph audit events for convenience.
    $mapped = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Changes) {
        if ($null -eq $entry) { continue }
        if (Get-TvProp $entry "auditId") { $mapped.Add($entry) }
        else {
            $change = ConvertFrom-TenuVaultAuditEvent $entry
            if ($change) { $mapped.Add($change) }
        }
    }

    # Collapse repeated changes to the same resource by the same actor, in order of
    # first appearance, exactly like collapseAuditChanges in audit.ts.
    $groups = [System.Collections.Specialized.OrderedDictionary]::new()
    $counts = @{}
    foreach ($change in $mapped) {
        $targetKey = Get-TvProp $change "resourceName"
        if (-not $targetKey) { $targetKey = Get-TvProp $change "resourceType" }
        if (-not $targetKey) { $targetKey = Get-TvProp $change "auditId" }
        $actorKey = Get-TvProp $change "actorUpn"
        if ($null -eq $actorKey) { $actorKey = "" }
        $key = (@([string](Get-TvProp $change "changeType"), [string]$targetKey, [string]$actorKey) -join "|").ToLowerInvariant()
        if ($groups.Contains($key)) { $counts[$key] = $counts[$key] + 1 }
        else { $groups.Add($key, $change); $counts[$key] = 1 }
    }

    $items = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($key in $groups.Keys) {
        if ($index -ge 20) { break }
        $index++
        $change = $groups[$key]
        $count = $counts[$key]
        $target = Get-TvProp $change "resourceName"
        if (-not $target) { $target = Get-TvProp $change "resourceType" }
        if (-not $target) { $target = Get-TvProp $change "category" }
        $title = "$(Get-TvCapitalized ([string](Get-TvProp $change "changeType"))): $target"
        if ($count -gt 1) { $title += " ($count times)" }
        $detail = if ((Get-TvProp $change "resourceName") -and (Get-TvProp $change "resourceType")) {
            [string](Get-TvProp $change "resourceType")
        } else { [string](Get-TvProp $change "activity") }
        $item = [ordered]@{ title = $title; detail = $detail }
        if ($IncludeActor -and (Get-TvProp $change "actorUpn")) { $item["actor"] = [string](Get-TvProp $change "actorUpn") }
        $item["at"] = [string](Get-TvProp $change "at")
        $items.Add([pscustomobject]$item)
    }
    $collapsed = $groups.Count
    $moreCount = [Math]::Max(0, $collapsed - $items.Count)

    $newest = "1970-01-01T00:00:00.000Z"
    foreach ($change in $mapped) {
        $changeAt = [string](Get-TvProp $change "at")
        if ([StringComparer]::Ordinal.Compare($changeAt, $newest) -gt 0) { $newest = $changeAt }
    }

    $byType = [System.Collections.Specialized.OrderedDictionary]::new()
    foreach ($change in $mapped) {
        $typeName = [string](Get-TvProp $change "changeType")
        if ($byType.Contains($typeName)) { $byType[$typeName] = $byType[$typeName] + 1 }
        else { $byType.Add($typeName, 1) }
    }
    $countParts = @($byType.Keys | ForEach-Object { "$($byType[$_]) $_" })
    $countsText = $countParts -join ", "

    $sortedIds = [System.Collections.Generic.List[string]]::new()
    foreach ($change in $mapped) { $sortedIds.Add([string](Get-TvProp $change "auditId")) }
    $sortedIds.Sort([StringComparer]::Ordinal)

    $tenantLabel = if ($TenantName) { [string]$TenantName } else { "your tenant" }
    $changeCount = $mapped.Count
    $summary = "$changeCount $(if ($changeCount -eq 1) { 'change' } else { 'changes' }) in Intune ($countsText)"
    if ($collapsed -lt $changeCount) { $summary += ", shown as $collapsed lines" }
    $summary += "."
    if ($GapNotice) { $summary += " $GapNotice" }

    return New-TvEnvelope -Type "intune.change" `
        -Severity $(if (@($mapped | Where-Object { (Get-TvProp $_ "changeType") -eq "deleted" }).Count -gt 0) { "warning" } else { "info" }) `
        -TenantId $TenantId -TenantName $TenantName -OccurredAt $newest `
        -NaturalKey ($sortedIds -join ",") `
        -Title "Intune changes: $tenantLabel" -Summary $summary `
        -Details @([pscustomobject][ordered]@{ label = "Changes"; value = [string]$changeCount }) `
        -Items @($items.ToArray()) -MoreCount $moreCount -Source "azure-watcher"
}

# ---------------------------------------------------------------------------
# Library: missed backup detection
# ---------------------------------------------------------------------------

function Get-TenuVaultBackupFolderTime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [Alias("FolderName", "BlobName", "Path")]
        [AllowEmptyString()][string]$Name
    )
    process {
        if (-not $Name) { return }
        $match = [regex]::Match($Name, "backup-\d{4}-\d{2}-\d{2}-\d{6}")
        if (-not $match.Success) { return }
        $parsed = [DateTime]::MinValue
        $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        if (-not [DateTime]::TryParseExact($match.Value, "'backup-'yyyy-MM-dd-HHmmss", [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
            return
        }
        return [DateTime]::SpecifyKind($parsed, [DateTimeKind]::Utc)
    }
}

function New-TenuVaultMissedBackupEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][object]$OccurredAt,
        [AllowNull()][object]$LastBackupAt,
        [Parameter(Mandatory)][int]$ThresholdHours,
        [string]$Source = "azure-watcher"
    )
    $occurredIso = ConvertTo-TvIso $OccurredAt
    if (-not $occurredIso) { throw "OccurredAt is not a valid timestamp." }
    $lastIso = if ($null -ne $LastBackupAt -and "$LastBackupAt") { ConvertTo-TvIso $LastBackupAt } else { $null }
    if ($null -ne $LastBackupAt -and "$LastBackupAt" -and -not $lastIso) { $lastIso = [string]$LastBackupAt }
    $tenantLabel = if ($TenantName) { [string]$TenantName } else { "your tenant" }
    $summary = if ($lastIso) {
        "The newest backup is from $lastIso, older than the $ThresholdHours hour threshold."
    } else {
        "No backup was found within the $ThresholdHours hour threshold."
    }
    return New-TvEnvelope -Type "backup.missed" -Severity "critical" `
        -TenantId $TenantId -TenantName $TenantName -OccurredAt $occurredIso `
        -NaturalKey "missed:$(if ($lastIso) { $lastIso } else { 'none' }):$ThresholdHours" `
        -Title "No recent backup: $tenantLabel" -Summary $summary `
        -Details @(
            [pscustomobject][ordered]@{ label = "Newest backup"; value = $(if ($lastIso) { $lastIso } else { "none found" }) },
            [pscustomobject][ordered]@{ label = "Threshold (hours)"; value = [string]$ThresholdHours }
        ) -Source $Source
}

# ---------------------------------------------------------------------------
# Rendering for Teams and mail (plain text item lines, like render.ts)
# ---------------------------------------------------------------------------

function Get-TvItemLine {
    param([object]$Item)
    $parts = [System.Collections.Generic.List[string]]::new()
    $parts.Add("- $(Get-TvProp $Item 'title')")
    if (Get-TvProp $Item "detail") { $parts.Add([string](Get-TvProp $Item "detail")) }
    if (Get-TvProp $Item "actor") { $parts.Add("by $(Get-TvProp $Item 'actor')") }
    if (Get-TvProp $Item "at") { $parts.Add([string](Get-TvProp $Item "at")) }
    return $parts -join " | "
}

function Get-TvFooter {
    param([object]$Envelope)
    return "Azure watcher | $(Get-TvProp $Envelope 'occurredAt') | Event $(([string](Get-TvProp $Envelope 'eventId')).Substring(0, 12))"
}

function Get-TvEmailText {
    param([object]$Envelope)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add([string](Get-TvProp $Envelope "title"))
    $lines.Add("")
    $lines.Add([string](Get-TvProp $Envelope "summary"))
    $lines.Add("")
    foreach ($detail in @(Get-TvProp $Envelope "details")) {
        $lines.Add("$(Get-TvProp $detail 'label'): $(Get-TvProp $detail 'value')")
    }
    $items = @(Get-TvProp $Envelope "items")
    if ($items.Count -gt 0 -and $null -ne $items[0]) {
        $lines.Add("")
        foreach ($item in $items) { $lines.Add((Get-TvItemLine $item)) }
    }
    if ([int](Get-TvProp $Envelope "moreCount") -gt 0) {
        $lines.Add("And $(Get-TvProp $Envelope 'moreCount') more. Open TenuVault for the full list.")
    }
    $lines.Add("")
    $lines.Add((Get-TvFooter $Envelope))
    return $lines -join "`n"
}

function New-TvTeamsPayload {
    param([object]$Envelope)
    $style = switch ([string](Get-TvProp $Envelope "severity")) {
        "critical" { "attention" }
        "warning" { "warning" }
        default { "default" }
    }
    $body = [System.Collections.Generic.List[object]]::new()
    $body.Add([pscustomobject][ordered]@{
        type = "TextBlock"; size = "Medium"; weight = "Bolder"
        text = [string](Get-TvProp $Envelope "title"); wrap = $true; style = $style
    })
    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = [string](Get-TvProp $Envelope "summary"); wrap = $true })
    $facts = @(@(Get-TvProp $Envelope "details") | Where-Object { $_ } | ForEach-Object {
        [pscustomobject][ordered]@{ title = [string](Get-TvProp $_ "label"); value = [string](Get-TvProp $_ "value") }
    })
    if ($facts.Count -gt 0) { $body.Add([pscustomobject][ordered]@{ type = "FactSet"; facts = $facts }) }
    foreach ($item in @(Get-TvProp $Envelope "items")) {
        if ($null -eq $item) { continue }
        $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = (Get-TvItemLine $item); wrap = $true; spacing = "Small" })
    }
    if ([int](Get-TvProp $Envelope "moreCount") -gt 0) {
        $body.Add([pscustomobject][ordered]@{
            type = "TextBlock"; text = "And $(Get-TvProp $Envelope 'moreCount') more. Open TenuVault for the full list."
            wrap = $true; isSubtle = $true
        })
    }
    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = (Get-TvFooter $Envelope); wrap = $true; isSubtle = $true; size = "Small" })
    return [pscustomobject][ordered]@{
        type = "message"
        attachments = @([pscustomobject][ordered]@{
            contentType = "application/vnd.microsoft.card.adaptive"
            contentUrl = $null
            content = [pscustomobject][ordered]@{
                '$schema' = "http://adaptivecards.io/schemas/adaptive-card.json"
                type = "AdaptiveCard"; version = "1.4"; body = @($body.ToArray())
            }
        })
    }
}

# ---------------------------------------------------------------------------
# Watcher plumbing: tokens, configuration, storage state, delivery
# ---------------------------------------------------------------------------

function Get-TvManagedIdentityToken {
    param([Parameter(Mandatory)][string]$Resource)
    $uri = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=$([uri]::EscapeDataString($Resource))"
    $lastError = $null
    foreach ($attempt in 1..3) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Headers @{ Metadata = "true" } -Method Get -TimeoutSec 30
            if (-not $response.access_token) { throw "The instance metadata service returned no access token." }
            return [string]$response.access_token
        } catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
        }
    }
    throw "Could not get a managed identity token for $Resource. $(Get-TvSafeError $lastError.Exception.Message)"
}

function Get-TvAutomationVariable {
    param([Parameter(Mandatory)][string]$Name)
    # Inside Azure Automation the variable cmdlets exist. Outside it, an environment
    # variable of the same name is accepted so the flow can be exercised locally.
    if (Get-Command Get-AutomationVariable -ErrorAction SilentlyContinue) {
        try {
            $value = Get-AutomationVariable -Name $Name -ErrorAction Stop
            if ($null -ne $value -and "$value" -ne "") { return [string]$value }
            return $null
        } catch { return $null }
    }
    $envValue = [Environment]::GetEnvironmentVariable($Name)
    if ($envValue) { return $envValue }
    return $null
}

function Invoke-TvStorageRequest {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = "Get",
        [Parameter(Mandatory)][string]$Token,
        [hashtable]$Headers,
        [byte[]]$BodyBytes,
        [string]$ContentType
    )
    $requestHeaders = @{
        Authorization = "Bearer $Token"
        "x-ms-version" = "2023-11-03"
        "x-ms-date" = [DateTime]::UtcNow.ToString("R", [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Headers) { foreach ($key in $Headers.Keys) { $requestHeaders[$key] = $Headers[$key] } }
    $params = @{
        Uri = $Uri; Method = $Method; Headers = $requestHeaders
        UseBasicParsing = $true; TimeoutSec = 60
    }
    if ($null -ne $BodyBytes) { $params.Body = $BodyBytes }
    if ($ContentType) { $params.ContentType = $ContentType }
    return Invoke-WebRequest @params
}

function Get-TvBlobText {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token)
    try {
        $response = Invoke-TvStorageRequest -Uri $Uri -Method Get -Token $Token
        return [string]$response.Content
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
        throw
    }
}

function Set-TvBlobText {
    param(
        [Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Text, [string]$LeaseId
    )
    $headers = @{ "x-ms-blob-type" = "BlockBlob" }
    if ($LeaseId) { $headers["x-ms-lease-id"] = $LeaseId }
    Invoke-TvStorageRequest -Uri $Uri -Method Put -Token $Token -Headers $headers `
        -BodyBytes ([Text.Encoding]::UTF8.GetBytes($Text)) -ContentType "application/json; charset=utf-8" | Out-Null
}

function Send-TvWebhook {
    param([object]$Envelope, [string]$Url, [string]$Secret)
    if (-not $Url) { return }
    $body = ConvertTo-TenuVaultCanonicalJson $Envelope
    $headers = @{ "X-TenuVault-Event-Id" = [string](Get-TvProp $Envelope "eventId") }
    if ($Secret) {
        $timestamp = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
        try { $signatureBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$timestamp.$body")) } finally { $hmac.Dispose() }
        $headers["X-TenuVault-Timestamp"] = $timestamp
        $headers["X-TenuVault-Signature"] = [BitConverter]::ToString($signatureBytes).Replace("-", "").ToLowerInvariant()
    }
    # Redirects are not followed for signed deliveries. A redirect answer therefore
    # counts as a delivery failure and the event stays unsent for the next run.
    $response = Invoke-WebRequest -Uri $Url -Method Post -Headers $headers -MaximumRedirection 0 `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8" `
        -UseBasicParsing -TimeoutSec 30
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
        throw "Webhook delivery failed with HTTP $([int]$response.StatusCode)."
    }
}

function Send-TvTeams {
    param([object]$Envelope, [string]$Url)
    if (-not $Url) { return }
    $payload = ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $Envelope)
    $response = Invoke-WebRequest -Uri $Url -Method Post -MaximumRedirection 0 `
        -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -ContentType "application/json; charset=utf-8" `
        -UseBasicParsing -TimeoutSec 30
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
        throw "Teams delivery failed with HTTP $([int]$response.StatusCode)."
    }
}

function Send-TvMail {
    param([object]$Envelope, [string]$MailSender, [string]$Recipients, [string]$GraphToken)
    if (-not $MailSender -or -not $Recipients) { return }
    $prefix = switch ([string](Get-TvProp $Envelope "severity")) {
        "critical" { "[Critical] " }
        "warning" { "[Warning] " }
        default { "" }
    }
    $subject = "TenuVault: $prefix$(Get-TvProp $Envelope 'title')"
    if ($subject.Length -gt 250) { $subject = $subject.Substring(0, 250) }
    $to = @($Recipients.Split(",;") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object {
        [pscustomobject][ordered]@{ emailAddress = [pscustomobject][ordered]@{ address = $_ } }
    })
    if ($to.Count -eq 0) { return }
    $message = [pscustomobject][ordered]@{
        message = [pscustomobject][ordered]@{
            subject = $subject
            body = [pscustomobject][ordered]@{ contentType = "Text"; content = Get-TvEmailText $Envelope }
            toRecipients = $to
        }
        saveToSentItems = $false
    }
    $senderEncoded = [uri]::EscapeDataString($MailSender)
    Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/users/$senderEncoded/sendMail" -Method Post `
        -Headers @{ Authorization = "Bearer $GraphToken" } `
        -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-TenuVaultCanonicalJson $message))) `
        -ContentType "application/json; charset=utf-8" -TimeoutSec 30 | Out-Null
}

if ($LibraryOnly) { return }

# ---------------------------------------------------------------------------
# Watcher run. Everything below only runs inside Azure Automation (or locally
# with the configuration supplied as environment variables).
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$runbookVersion = "1.0.0"
$runAt = [DateTime]::UtcNow
$runAtIso = ConvertTo-TvIso $runAt
$eventsSent = 0
$lastError = $null
$configVersion = "1"
$leaseId = $null
$storageToken = $null
$stateBlobUri = $null
$heartbeatBlobUri = $null
$leaseQueryUri = $null
$watermarkIso = $null

try {
    $tenantId = Get-TvAutomationVariable "TenuVaultTenantId"
    $tenantName = Get-TvAutomationVariable "TenuVaultTenantName"
    $storageAccount = Get-TvAutomationVariable "TenuVaultStorageAccount"
    $webhookUrl = Get-TvAutomationVariable "TenuVaultWebhookUrl"
    $webhookSecret = Get-TvAutomationVariable "TenuVaultWebhookSecret"
    $teamsWebhookUrl = Get-TvAutomationVariable "TenuVaultTeamsWebhookUrl"
    $mailSender = Get-TvAutomationVariable "TenuVaultMailSender"
    $mailRecipients = Get-TvAutomationVariable "TenuVaultMailRecipients"
    $configVersionValue = Get-TvAutomationVariable "TenuVaultConfigVersion"
    if ($configVersionValue) { $configVersion = $configVersionValue }

    $missedBackupHours = 48
    $missedValue = Get-TvAutomationVariable "TenuVaultMissedBackupHours"
    $parsedHours = 0
    if ($missedValue -and [int]::TryParse($missedValue, [ref]$parsedHours) -and $parsedHours -gt 0) {
        $missedBackupHours = $parsedHours
    }
    $includeActorValue = Get-TvAutomationVariable "TenuVaultIncludeActor"
    $includeActor = $includeActorValue -match "^(true|1|yes)$"

    if (-not $tenantId) { throw "Automation variable TenuVaultTenantId is not set." }
    if (-not $storageAccount) { throw "Automation variable TenuVaultStorageAccount is not set." }
    if ($webhookUrl -and $webhookUrl -notmatch "^https://") { throw "TenuVaultWebhookUrl must use https." }
    if ($teamsWebhookUrl -and $teamsWebhookUrl -notmatch "^https://") { throw "TenuVaultTeamsWebhookUrl must use https." }

    $graphToken = Get-TvManagedIdentityToken "https://graph.microsoft.com/"
    $storageToken = Get-TvManagedIdentityToken "https://storage.azure.com/"

    $stateContainerUri = "https://$storageAccount.blob.core.windows.net/tenuvault-notification-state"
    $stateBlobUri = "$stateContainerUri/state.json"
    $heartbeatBlobUri = "$stateContainerUri/heartbeat.json"
    $leaseQueryUri = "$stateBlobUri`?comp=lease"

    # Create the state blob once, then take the lease before any delivery. A run that
    # finds the lease held exits quietly: the other run owns delivery for this window.
    $existingStateText = Get-TvBlobText -Uri $stateBlobUri -Token $storageToken
    if ($null -eq $existingStateText) {
        $initialWatermark = ConvertTo-TvIso $runAt.AddHours(-1)
        $initialState = [pscustomobject][ordered]@{
            tenantId = $tenantId.ToLowerInvariant(); watermark = $initialWatermark
            recentAuditIds = @(); sentEventIds = @(); lastMissedKey = $null
        }
        Set-TvBlobText -Uri $stateBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $initialState)
        $existingStateText = Get-TvBlobText -Uri $stateBlobUri -Token $storageToken
    }

    $leaseId = [Guid]::NewGuid().ToString()
    try {
        Invoke-TvStorageRequest -Uri $leaseQueryUri -Method Put -Token $storageToken -Headers @{
            "x-ms-lease-action" = "acquire"; "x-ms-lease-duration" = "60"; "x-ms-proposed-lease-id" = $leaseId
        } | Out-Null
    } catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 409) {
            Write-Output "Another watcher run holds the state lease. Exiting quietly."
            $leaseId = $null
            return
        }
        throw
    }

    $stateText = Get-TvBlobText -Uri $stateBlobUri -Token $storageToken
    $state = if ($stateText) { $stateText | ConvertFrom-Json } else { $null }
    $stateTenantId = if ($state) { Get-TvText (Get-TvProp $state "tenantId") } else { $null }
    if ($stateTenantId -and $stateTenantId.ToLowerInvariant() -ne $tenantId.ToLowerInvariant()) {
        throw "State tenant does not match TenuVaultTenantId. Refusing to run against the wrong tenant state."
    }
    $watermarkIso = if ($state) { ConvertTo-TvIso (Get-TvProp $state "watermark") } else { $null }
    if (-not $watermarkIso) { $watermarkIso = ConvertTo-TvIso $runAt.AddHours(-1) }
    $stateConfigVersion = if ($state) { Get-TvText (Get-TvProp $state "configVersion") } else { $null }
    if ($stateConfigVersion -and -not $configVersionValue) { $configVersion = $stateConfigVersion }

    $recentById = @{}
    if ($state) {
        foreach ($entry in @(Get-TvProp $state "recentAuditIds")) {
            if ($null -eq $entry) { continue }
            $entryId = Get-TvText (Get-TvProp $entry "id")
            $entryAt = ConvertTo-TvIso (Get-TvProp $entry "at")
            if (-not $entryId -and $entry -is [string]) { $entryId = Get-TvText $entry; $entryAt = $watermarkIso }
            if ($entryId) { $recentById[$entryId] = $entryAt }
        }
    }
    $sentEventIds = [System.Collections.Generic.List[string]]::new()
    if ($state) {
        foreach ($entry in @(Get-TvProp $state "sentEventIds")) {
            $entryText = Get-TvText $entry
            if ($entryText) { $sentEventIds.Add($entryText) }
        }
    }
    $lastMissedKey = if ($state) { Get-TvText (Get-TvProp $state "lastMissedKey") } else { $null }

    # --- Intune audit events ---------------------------------------------------
    $filterFrom = ConvertTo-TvIso ([DateTimeOffset]::Parse($watermarkIso).UtcDateTime.AddMinutes(-30))
    $select = "id,activity,activityDateTime,category,httpVerb,initiatedByUpn,initiatedByAppId,requestUrl,resources"
    $query = "`$select=$([uri]::EscapeDataString($select))&`$filter=$([uri]::EscapeDataString("activityDateTime gt $filterFrom"))&`$orderby=$([uri]::EscapeDataString('activityDateTime'))&`$top=200"
    $nextUri = "https://graph.microsoft.com/beta/deviceManagement/auditEvents?$query"
    $graphHeaders = @{ Authorization = "Bearer $graphToken"; ConsistencyLevel = "eventual" }

    $mappedEvents = [System.Collections.Generic.List[object]]::new()
    $fetchedCount = 0
    while ($nextUri -and $fetchedCount -lt 500) {
        $page = Invoke-RestMethod -Uri $nextUri -Headers $graphHeaders -Method Get -TimeoutSec 60
        foreach ($rawEvent in @($page.value)) {
            if ($fetchedCount -ge 500) { break }
            $fetchedCount++
            $change = ConvertFrom-TenuVaultAuditEvent $rawEvent
            if ($change) { $mappedEvents.Add($change) }
        }
        $nextUri = Get-TvProp $page "@odata.nextLink"
    }
    Write-Output "Fetched $fetchedCount audit events, $($mappedEvents.Count) mappable."

    $newChanges = [System.Collections.Generic.List[object]]::new()
    $newestProcessedIso = $watermarkIso
    foreach ($change in $mappedEvents) {
        $changeAt = [string](Get-TvProp $change "at")
        if ([StringComparer]::Ordinal.Compare($changeAt, $newestProcessedIso) -gt 0) { $newestProcessedIso = $changeAt }
        $auditIdValue = [string](Get-TvProp $change "auditId")
        $recentById[$auditIdValue] = $changeAt
    }
    # Rebuild the new set against the snapshot that existed before this run.
    $priorRecent = @{}
    if ($state) {
        foreach ($entry in @(Get-TvProp $state "recentAuditIds")) {
            $entryId = Get-TvText (Get-TvProp $entry "id")
            if (-not $entryId -and $entry -is [string]) { $entryId = Get-TvText $entry }
            if ($entryId) { $priorRecent[$entryId] = $true }
        }
    }
    $seenThisRun = @{}
    foreach ($change in $mappedEvents) {
        $auditIdValue = [string](Get-TvProp $change "auditId")
        if ($priorRecent.ContainsKey($auditIdValue) -or $seenThisRun.ContainsKey($auditIdValue)) { continue }
        $seenThisRun[$auditIdValue] = $true
        $newChanges.Add($change)
    }

    $envelopes = [System.Collections.Generic.List[object]]::new()
    if ($newChanges.Count -gt 0) {
        $envelopes.Add((New-TenuVaultAuditDigest -TenantId $tenantId -TenantName $tenantName `
            -Changes @($newChanges.ToArray()) -IncludeActor $includeActor))
    }

    # --- Missed backup check -----------------------------------------------------
    $newestBackup = $null
    $marker = $null
    do {
        $listUri = "https://$storageAccount.blob.core.windows.net/intune-backups?resttype=container&comp=list&delimiter=%2F&maxresults=5000"
        if ($marker) { $listUri += "&marker=$([uri]::EscapeDataString($marker))" }
        $listResponse = Invoke-TvStorageRequest -Uri $listUri -Method Get -Token $storageToken
        [xml]$listXml = [string]$listResponse.Content
        $names = [System.Collections.Generic.List[string]]::new()
        foreach ($prefix in @($listXml.EnumerationResults.BlobPrefix)) { if ($prefix.Name) { $names.Add([string]$prefix.Name) } }
        foreach ($blob in @($listXml.EnumerationResults.Blobs.Blob)) { if ($blob.Name) { $names.Add([string]$blob.Name) } }
        foreach ($name in $names) {
            $folderTime = Get-TenuVaultBackupFolderTime $name
            if ($folderTime -and (-not $newestBackup -or $folderTime -gt $newestBackup)) { $newestBackup = $folderTime }
        }
        $marker = [string]$listXml.EnumerationResults.NextMarker
        if (-not $marker) { $marker = $null }
    } while ($marker)

    $newestBackupIso = if ($newestBackup) { ConvertTo-TvIso $newestBackup } else { $null }
    $missedThresholdTime = $runAt.AddHours(-$missedBackupHours)
    if (-not $newestBackup -or $newestBackup -lt $missedThresholdTime) {
        $missedEvent = New-TenuVaultMissedBackupEvent -TenantId $tenantId -TenantName $tenantName `
            -OccurredAt $runAtIso -LastBackupAt $newestBackupIso -ThresholdHours $missedBackupHours
        $missedKey = "missed:$(if ($newestBackupIso) { $newestBackupIso } else { 'none' }):$missedBackupHours"
        if ($missedKey -ne $lastMissedKey -and -not $sentEventIds.Contains([string](Get-TvProp $missedEvent "eventId"))) {
            $envelopes.Add($missedEvent)
        }
        $lastMissedKey = $missedKey
    }

    # --- Delivery ----------------------------------------------------------------
    $channelCount = 0
    if ($webhookUrl) { $channelCount++ }
    if ($teamsWebhookUrl) { $channelCount++ }
    if ($mailSender -and $mailRecipients) { $channelCount++ }
    if ($envelopes.Count -gt 0 -and $channelCount -eq 0) {
        Write-Output "No delivery channel is configured. $($envelopes.Count) event(s) left unsent."
    }

    foreach ($envelope in $envelopes) {
        $eventIdValue = [string](Get-TvProp $envelope "eventId")
        if ($sentEventIds.Contains($eventIdValue)) { continue }
        if ($channelCount -eq 0) { continue }
        try {
            Send-TvWebhook -Envelope $envelope -Url $webhookUrl -Secret $webhookSecret
            Send-TvTeams -Envelope $envelope -Url $teamsWebhookUrl
            Send-TvMail -Envelope $envelope -MailSender $mailSender -Recipients $mailRecipients -GraphToken $graphToken
            $sentEventIds.Add($eventIdValue)
            $eventsSent++
        } catch {
            # The event stays out of sentEventIds, so a later run can retry it while
            # its audit ids are still inside the recent window handled above.
            Write-Output "Delivery failed for event $($eventIdValue.Substring(0, 12)): $(Get-TvSafeError $_.Exception.Message)"
            if (-not $lastError) { $lastError = Get-TvSafeError $_.Exception.Message }
        }
    }

    # --- Persist state and heartbeat ---------------------------------------------
    $watermarkIso = $newestProcessedIso
    $pruneBefore = ConvertTo-TvIso $runAt.AddHours(-48)
    $recentList = [System.Collections.Generic.List[object]]::new()
    foreach ($entryId in $recentById.Keys) {
        $entryAt = $recentById[$entryId]
        if ($entryAt -and [StringComparer]::Ordinal.Compare([string]$entryAt, $pruneBefore) -lt 0) { continue }
        $recentList.Add([pscustomobject][ordered]@{ id = [string]$entryId; at = [string]$entryAt })
    }
    $recentTrimmed = @($recentList | Sort-Object { [string](Get-TvProp $_ "at") } -Descending | Select-Object -First 2000)
    [array]::Reverse($recentTrimmed)
    $sentTrimmed = $sentEventIds
    if ($sentTrimmed.Count -gt 2000) { $sentTrimmed = $sentTrimmed.GetRange($sentTrimmed.Count - 2000, 2000) }

    $newState = [pscustomobject][ordered]@{
        tenantId = $tenantId.ToLowerInvariant()
        configVersion = $configVersion
        watermark = $watermarkIso
        recentAuditIds = $recentTrimmed
        sentEventIds = @($sentTrimmed.ToArray())
        lastMissedKey = $lastMissedKey
    }
    Set-TvBlobText -Uri $stateBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $newState) -LeaseId $leaseId

    $heartbeat = [pscustomobject][ordered]@{
        runAt = $runAtIso
        runbookVersion = $runbookVersion
        configVersion = $configVersion
        watermark = $watermarkIso
        eventsSent = $eventsSent
        lastError = $lastError
    }
    Set-TvBlobText -Uri $heartbeatBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $heartbeat)
    Write-Output "Watcher run complete. Events sent: $eventsSent. Watermark: $watermarkIso."
} catch {
    $lastError = Get-TvSafeError $_.Exception.Message
    if ($leaseId -and $storageToken -and $heartbeatBlobUri) {
        try {
            $failedHeartbeat = [pscustomobject][ordered]@{
                runAt = $runAtIso
                runbookVersion = $runbookVersion
                configVersion = $configVersion
                watermark = $watermarkIso
                eventsSent = $eventsSent
                lastError = $lastError
            }
            Set-TvBlobText -Uri $heartbeatBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $failedHeartbeat)
        } catch { Write-Output "Could not write the failure heartbeat." }
    }
    throw
} finally {
    if ($leaseId -and $storageToken -and $leaseQueryUri) {
        try {
            Invoke-TvStorageRequest -Uri $leaseQueryUri -Method Put -Token $storageToken -Headers @{
                "x-ms-lease-action" = "release"; "x-ms-lease-id" = $leaseId
            } | Out-Null
        } catch { Write-Output "Could not release the state lease. It expires on its own." }
    }
}



