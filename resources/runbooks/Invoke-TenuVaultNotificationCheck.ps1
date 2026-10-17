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

    State (watermark, recent audit event ids, sent event ids and the pending delivery
    outbox) lives in state.json in the tenuvault-notification-state container. New
    envelopes are saved to the outbox before delivery is attempted, so a crashed or
    failed run retries them instead of losing them. A blob lease on state.json is
    taken before any delivery, so two overlapping runs cannot send the same digest
    twice. A heartbeat.json blob next to it lets the desktop app show that the watcher
    is alive.

    Payload allowlist: envelopes carry names, counts, statuses, timestamps and, when
    TenuVaultIncludeActor is true, actor UPNs. Audit request bodies and audit property
    values are never read, and secrets, tokens and URLs with query strings are never
    logged.

    Dot source the file with -LibraryOnly to load the library functions without
    running the watcher, which is how the parity check script uses it. Run with
    -VerifyMailOnly once after Mail.Send is granted and restricted by an Exchange
    application access policy: it proves the identity can send as the configured
    sender mailbox and cannot send as the probe mailbox, then records
    mailVerified in state.json. Mail stays disabled until that check passes.
#>
[CmdletBinding()]
param(
    [switch]$LibraryOnly,
    [switch]$VerifyMailOnly
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
    if ($Value -is [string] -and $Value.Trim()) {
        $trimmed = $Value.Trim()
        # Graph audit payloads use the literal "<null>" for absent values.
        if ($trimmed.ToLowerInvariant() -eq "<null>") { return $null }
        return $trimmed
    }
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

function Get-TvSha256Hex {
    param([Parameter(Mandatory, Position = 0)][AllowEmptyString()][string]$Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) } finally { $sha.Dispose() }
    return [BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
}

function Get-TenuVaultEventId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][string]$TenantId,
        [Parameter(Mandatory, Position = 1)][string]$Type,
        [Parameter(Mandatory, Position = 2)][AllowEmptyString()][string]$NaturalKey
    )
    return Get-TvSha256Hex "$($TenantId.ToLowerInvariant())|$Type|$NaturalKey"
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
        # Windows PowerShell 5.1 (the Automation "PowerShell" runbook runtime)
        # rejects the round-trip format for integral and decimal values, so only
        # floating point values use it. "G" renders integers identically.
        # Full type names: Windows PowerShell 5.1 (the Automation sandbox runtime)
        # has no short, ushort, uint or ulong type accelerators (added in 6.2).
        if ($Value -is [System.Byte] -or $Value -is [System.Int32] -or $Value -is [System.Int64] -or $Value -is [System.Int16] -or
            $Value -is [System.UInt32] -or $Value -is [System.UInt64] -or $Value -is [System.Decimal]) {
            return ([IFormattable]$Value).ToString("G", [Globalization.CultureInfo]::InvariantCulture)
        }
        if ($Value -is [System.Double] -or $Value -is [System.Single]) {
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

        # Read-only operations changed nothing, so they never enter a digest.
        $operationText = Get-TvText (Get-TvProp $Raw "activityOperationType")
        $operationLower = if ($operationText) { $operationText.ToLowerInvariant() } else { "" }
        if ($operationLower -eq "get" -or $operationLower -eq "search") { return }

        # Failed operations changed nothing, so they never enter a digest.
        $resultLower = ""
        $resultText = Get-TvText (Get-TvProp $Raw "activityResult")
        if ($resultText) { $resultLower = $resultText.ToLowerInvariant() }
        if ($resultLower.Contains("fail") -or $resultLower.Contains("error")) { return }

        $activity = Get-TvText (Get-TvProp $Raw "activity")
        if (-not $activity) { $activity = Get-TvText (Get-TvProp $Raw "displayName") }
        $activityTypeText = Get-TvText (Get-TvProp $Raw "activityType")
        $activityText = Get-TvText (Get-TvProp $Raw "activity")
        $displayText = Get-TvText (Get-TvProp $Raw "displayName")
        $activityLower = (@($activityTypeText, $activityText, $displayText) -join " ").ToLowerInvariant()

        # Object entries of the resources collection. Modified property values
        # inside resources are never read.
        $resourceEntries = @()
        foreach ($entry in @(Get-TvProp $Raw "resources")) {
            if ($entry -is [PSCustomObject] -or $entry -is [System.Collections.IDictionary]) { $resourceEntries += $entry }
        }

        # Assignment creates and deletes are assignment changes, not policy
        # creates and deletes, matching changeTypeOf in audit.ts.
        $isAssignment = $activityLower.Contains("assignment")
        if (-not $isAssignment) {
            foreach ($entry in $resourceEntries) {
                $entryType = (@((Get-TvText (Get-TvProp $entry "type")), (Get-TvText (Get-TvProp $entry "auditResourceType"))) -join " ").ToLowerInvariant()
                if ($entryType.Contains("assignment")) { $isAssignment = $true; break }
            }
        }
        $changeType = "changed"
        if ($isAssignment) {
            if ($operationLower.Contains("delet") -or $operationLower.Contains("remov") -or $activityLower -match "(^|\s)(delete|remove|unassign)") {
                $changeType = "unassigned"
            } else { $changeType = "assigned" }
        } else {
            # The operation type is checked first with the full rule set. The combined
            # activity text is only a fallback, matching changeTypeOf in audit.ts.
            foreach ($source in @($operationLower, $activityLower)) {
                if ($source.Contains("assign")) { $changeType = "assigned"; break }
                if ($source.Contains("creat") -or $source -eq "post") { $changeType = "created"; break }
                if ($source.Contains("delet") -or $source.Contains("remov") -or $source -eq "delete") { $changeType = "deleted"; break }
                if ($source.Contains("updat") -or $source.Contains("patch") -or $source.Contains("edit") -or $source -eq "put") { $changeType = "updated"; break }
            }
        }

        # Resource name and type come from the first resource entry that carries a
        # display name (the parent policy on assignment events), else the first entry.
        $resource = $null
        foreach ($entry in $resourceEntries) {
            if (Get-TvText (Get-TvProp $entry "displayName")) { $resource = $entry; break }
        }
        if (-not $resource -and $resourceEntries.Count -gt 0) { $resource = $resourceEntries[0] }
        $resourceNameText = if ($resource) { Get-TvText (Get-TvProp $resource "displayName") } else { $null }
        $resourceName = if ($resourceNameText) {
            if ($resourceNameText.Length -gt 200) { $resourceNameText.Substring(0, 200) } else { $resourceNameText }
        } else { $null }
        $resourceType = $null
        if ($resource) {
            $resourceType = Get-TvText (Get-TvProp $resource "type")
            if (-not $resourceType) { $resourceType = Get-TvText (Get-TvProp $resource "auditResourceType") }
        }
        if (-not $resourceType) { $resourceType = Get-TvText (Get-TvProp $Raw "componentName") }

        $actor = Get-TvProp $Raw "actor"

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
            actorUpn     = Get-TvText (Get-TvProp $actor "userPrincipalName")
            actorAppId   = Get-TvText (Get-TvProp $actor "applicationId")
            actorAppName = Get-TvText (Get-TvProp $actor "applicationDisplayName")
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
        if (-not $actorKey) { $actorKey = Get-TvProp $change "actorAppName" }
        if (-not $actorKey) { $actorKey = Get-TvProp $change "actorAppId" }
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
        $actorLabel = Get-TvProp $change "actorUpn"
        if (-not $actorLabel) { $actorLabel = Get-TvProp $change "actorAppName" }
        if ($IncludeActor -and $actorLabel) { $item["actor"] = [string]$actorLabel }
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
        -Severity $(if (@($mapped | Where-Object { (Get-TvProp $_ "changeType") -eq "deleted" -or (Get-TvProp $_ "changeType") -eq "unassigned" }).Count -gt 0) { "warning" } else { "info" }) `
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

function Get-TvHtmlEscape {
    param([object]$Value)
    if ($null -eq $Value) { return "" }
    $text = [string]$Value
    return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&#39;")
}

function Get-TvFriendlyTime {
    param([object]$Value)
    $iso = ConvertTo-TvIso $Value
    if (-not $iso) { return [string]$Value }
    # ConvertTo-TvIso renders yyyy-MM-ddTHH:mm:ss.fffZ, so the first 16 chars are the readable form.
    return ($iso.Substring(0, 16).Replace("T", " ") + " UTC")
}

# Mirrors emailHtml in render.ts: same layout, badges and fixed action link, so a
# digest looks the same whether the desktop app or the Azure watcher sent it.
function Get-TvEmailHtml {
    param([object]$Envelope)
    $badge = switch ([string](Get-TvProp $Envelope "severity")) {
        "critical" { @{ Label = "Critical"; Color = "#b42318"; Background = "#fef3f2"; Bar = "#f04438" } }
        "warning"  { @{ Label = "Warning";  Color = "#b54708"; Background = "#fffaeb"; Bar = "#f79009" } }
        default    { @{ Label = "Info";     Color = "#175cd3"; Background = "#eff4ff"; Bar = "#2e90fa" } }
    }
    $verbStyles = @{
        Created    = @("#067647", "#ecfdf3"); Updated = @("#175cd3", "#eff4ff"); Changed = @("#175cd3", "#eff4ff")
        Assigned   = @("#6941c6", "#f4f3ff"); Unassigned = @("#b54708", "#fffaeb"); Deleted = @("#b42318", "#fef3f2")
    }
    $tenant = Get-TvText (Get-TvProp (Get-TvProp $Envelope "tenant") "name")
    if (-not $tenant) { $tenant = Get-TvText (Get-TvProp (Get-TvProp $Envelope "tenant") "id") }

    $detailRows = ""
    foreach ($detail in @(Get-TvProp $Envelope "details")) {
        if ($null -eq $detail) { continue }
        $detailRows += "<tr><td style=`"padding:5px 16px 5px 0;color:#475467;font-size:13px;white-space:nowrap;vertical-align:top`">$(Get-TvHtmlEscape (Get-TvProp $detail 'label'))</td><td style=`"padding:5px 0;font-size:13px`">$(Get-TvHtmlEscape (Get-TvProp $detail 'value'))</td></tr>"
    }

    $itemRows = ""
    foreach ($item in @(Get-TvProp $Envelope "items")) {
        if ($null -eq $item) { continue }
        $title = [string](Get-TvProp $item "title")
        $chip = ""
        $colonAt = $title.IndexOf(":")
        if ($colonAt -gt 0) {
            $verb = $title.Substring(0, $colonAt).Trim()
            if ($verbStyles.ContainsKey($verb)) {
                $chip = "<span style=`"display:inline-block;padding:1px 8px;border-radius:999px;background:$($verbStyles[$verb][1]);color:$($verbStyles[$verb][0]);font-size:12px;font-weight:600;margin-right:8px`">$(Get-TvHtmlEscape $verb)</span>"
                $title = $title.Substring($colonAt + 1).Trim()
            }
        }
        $metaParts = [System.Collections.Generic.List[string]]::new()
        if (Get-TvProp $item "detail") { $metaParts.Add([string](Get-TvProp $item "detail")) }
        if (Get-TvProp $item "actor") { $metaParts.Add("by $(Get-TvProp $item 'actor')") }
        if (Get-TvProp $item "at") { $metaParts.Add((Get-TvFriendlyTime (Get-TvProp $item "at"))) }
        $meta = if ($metaParts.Count -gt 0) { "<div style=`"font-size:12px;line-height:18px;color:#475467;margin-top:2px`">$(Get-TvHtmlEscape ($metaParts -join ' · '))</div>" } else { "" }
        $itemRows += "<tr><td style=`"padding:10px 16px;border-top:1px solid #eaecf0`"><div style=`"font-size:14px;line-height:20px`">$chip<span style=`"font-weight:600`">$(Get-TvHtmlEscape $title)</span></div>$meta</td></tr>"
    }

    $moreRow = ""
    if ([int](Get-TvProp $Envelope "moreCount") -gt 0) {
        $moreRow = "<tr><td style=`"padding:8px 24px 0;font-size:13px;color:#475467`">And $(Get-TvProp $Envelope 'moreCount') more. Open TenuVault for the full list.</td></tr>"
    }
    $actionRow = ""
    if ((Get-TvProp $Envelope "type") -eq "intune.change") {
        $actionRow = "<tr><td style=`"padding:18px 24px 4px`"><a href=`"https://intune.microsoft.com`" style=`"display:inline-block;padding:9px 16px;border-radius:6px;background:#175cd3;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none`">Open the Intune admin center</a></td></tr>"
    }
    $tenantRow = ""
    if ($tenant) {
        $tenantRow = "<tr><td style=`"padding:14px 24px 0`"><div style=`"font-size:12px;color:#667085`">Tenant&nbsp;&nbsp;<span style=`"color:#101828;font-size:13px`">$(Get-TvHtmlEscape $tenant)</span></div></td></tr>"
    }
    $detailsTable = ""
    if ($detailRows) { $detailsTable = "<tr><td style=`"padding:10px 24px 4px`"><table role=`"presentation`" cellspacing=`"0`" cellpadding=`"0`">$detailRows</table></td></tr>" }
    $itemsTable = ""
    if ($itemRows) { $itemsTable = "<tr><td style=`"padding:12px 8px 4px`"><table role=`"presentation`" width=`"100%`" cellspacing=`"0`" cellpadding=`"0`">$itemRows</table></td></tr>" }
    $eventShort = ([string](Get-TvProp $Envelope "eventId")).Substring(0, 12)

    return @(
        "<div style=`"margin:0;padding:24px 12px;background:#f6f7f9;font-family:'Segoe UI',SegoeUI,Arial,sans-serif;color:#101828`">"
        "<table role=`"presentation`" width=`"640`" align=`"center`" cellspacing=`"0`" cellpadding=`"0`" style=`"width:640px;max-width:100%;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;border-collapse:separate;overflow:hidden`">"
        "<tr><td style=`"height:3px;background:$($badge.Bar);font-size:0;line-height:0`">&nbsp;</td></tr>"
        "<tr><td style=`"padding:20px 24px 0`"><table role=`"presentation`" width=`"100%`" cellspacing=`"0`" cellpadding=`"0`"><tr>"
        "<td style=`"font-size:12px;font-weight:600;letter-spacing:2px;color:#667085`">TENUVAULT</td>"
        "<td align=`"right`"><span style=`"display:inline-block;padding:2px 10px;border-radius:999px;background:$($badge.Background);color:$($badge.Color);font-size:12px;font-weight:600`">$($badge.Label)</span></td>"
        "</tr></table></td></tr>"
        "<tr><td style=`"padding:14px 24px 0`"><div style=`"font-size:20px;line-height:28px;font-weight:600`">$(Get-TvHtmlEscape (Get-TvProp $Envelope 'title'))</div>"
        "<div style=`"font-size:14px;line-height:21px;color:#344054;margin-top:6px`">$(Get-TvHtmlEscape (Get-TvProp $Envelope 'summary'))</div></td></tr>"
        $tenantRow
        $detailsTable
        $itemsTable
        $moreRow
        $actionRow
        "<tr><td style=`"padding:18px 24px 20px`"><div style=`"border-top:1px solid #eaecf0;padding-top:12px;font-size:12px;line-height:18px;color:#98a2b3`">Azure watcher · $(Get-TvHtmlEscape (Get-TvFriendlyTime (Get-TvProp $Envelope 'occurredAt'))) · Event $(Get-TvHtmlEscape $eventShort)</div></td></tr>"
        "</table></div>"
    ) -join ""
}

function Get-TvMarkdownEscape {
    param([object]$Value)
    if ($null -eq $Value) { return "" }
    # Same escape set as escapeMarkdown in render.ts, so a hostile policy name
    # cannot format or link inside an Adaptive Card TextBlock.
    return [regex]::Replace([string]$Value, '([\\`*_{}\[\]()#+\-.!>])', '\$1')
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
        text = Get-TvMarkdownEscape (Get-TvProp $Envelope "title"); wrap = $true; style = $style
    })
    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape (Get-TvProp $Envelope "summary"); wrap = $true })
    $facts = @(@(Get-TvProp $Envelope "details") | Where-Object { $_ } | ForEach-Object {
        [pscustomobject][ordered]@{ title = Get-TvMarkdownEscape (Get-TvProp $_ "label"); value = Get-TvMarkdownEscape (Get-TvProp $_ "value") }
    })
    if ($facts.Count -gt 0) { $body.Add([pscustomobject][ordered]@{ type = "FactSet"; facts = $facts }) }
    foreach ($item in @(Get-TvProp $Envelope "items")) {
        if ($null -eq $item) { continue }
        $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape (Get-TvItemLine $item); wrap = $true; spacing = "Small" })
    }
    if ([int](Get-TvProp $Envelope "moreCount") -gt 0) {
        $body.Add([pscustomobject][ordered]@{
            type = "TextBlock"; text = "And $(Get-TvProp $Envelope 'moreCount') more. Open TenuVault for the full list."
            wrap = $true; isSubtle = $true
        })
    }
    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape (Get-TvFooter $Envelope); wrap = $true; isSubtle = $true; size = "Small" })
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
    # Azure Automation and App Service style hosts expose a local identity endpoint
    # through environment variables. That endpoint is authoritative when present.
    # The link local IMDS address is only a fallback for hosts without one.
    $identityEndpoint = [Environment]::GetEnvironmentVariable("IDENTITY_ENDPOINT")
    $headers = @{ Metadata = "true" }
    if ($identityEndpoint) {
        $separator = if ($identityEndpoint.Contains("?")) { "&" } else { "?" }
        $uri = "$identityEndpoint$($separator)api-version=2019-08-01&resource=$([uri]::EscapeDataString($Resource))"
        $identityHeader = [Environment]::GetEnvironmentVariable("IDENTITY_HEADER")
        if ($identityHeader) { $headers["X-IDENTITY-HEADER"] = $identityHeader }
    } else {
        $uri = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=$([uri]::EscapeDataString($Resource))"
    }
    $lastError = $null
    foreach ($attempt in 1..3) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 30
            if (-not $response.access_token) { throw "The identity endpoint returned no access token." }
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

function ConvertFrom-TvJson {
    param([Parameter(Mandatory)][string]$Text)
    # Keep timestamps as strings where the host PowerShell supports it, so saved
    # envelopes round trip byte for byte instead of becoming DateTime values.
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey("DateKind")) {
        return $Text | ConvertFrom-Json -DateKind String
    }
    return $Text | ConvertFrom-Json
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

function Update-TvStateLease {
    param(
        [Parameter(Mandatory)][string]$LeaseQueryUri, [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$LeaseId
    )
    try {
        Invoke-TvStorageRequest -Uri $LeaseQueryUri -Method Put -Token $Token -Headers @{
            "x-ms-lease-action" = "renew"; "x-ms-lease-id" = $LeaseId
        } | Out-Null
    } catch {
        throw "Failed to renew the state lease. Aborting without sending anything further. $(Get-TvSafeError $_.Exception.Message)"
    }
}

function Save-TvStateBlob {
    param(
        [Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$LeaseQueryUri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$LeaseId
    )
    Update-TvStateLease -LeaseQueryUri $LeaseQueryUri -Token $Token -LeaseId $LeaseId
    try {
        Set-TvBlobText -Uri $Uri -Token $Token -Text $Text -LeaseId $LeaseId
    } catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        $detail = Get-TvSafeError $_.Exception.Message
        if ($statusCode -eq 409 -or $statusCode -eq 412 -or $detail -match "lease") {
            throw "State write failed because the state lease was lost (HTTP $statusCode). Aborting before any further delivery."
        }
        throw
    }
}

function Add-TvSavedEnvelopes {
    param(
        [AllowNull()][object]$State,
        [Parameter(Mandatory)][string]$ListName,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$TargetList,
        [string[]]$DefaultIntendedChannels = @()
    )
    if ($null -eq $State) { return }
    foreach ($entry in @(Get-TvProp $State $ListName)) {
        if ($null -eq $entry) { continue }
        $savedEnvelope = Get-TvProp $entry "envelope"
        if (-not $savedEnvelope -or -not (Get-TvText (Get-TvProp $savedEnvelope "eventId"))) { continue }
        $savedAttempts = 0
        [void][int]::TryParse("$(Get-TvProp $entry 'attempts')", [ref]$savedAttempts)
        $attemptsByChannel = [ordered]@{}
        $savedByChannel = Get-TvProp $entry "attemptsByChannel"
        if ($savedByChannel -is [System.Collections.IDictionary]) {
            foreach ($channelName in $savedByChannel.Keys) {
                $channelAttempts = 0
                [void][int]::TryParse("$($savedByChannel[$channelName])", [ref]$channelAttempts)
                $attemptsByChannel[[string]$channelName] = $channelAttempts
            }
        } elseif ($savedByChannel) {
            foreach ($channelProp in $savedByChannel.PSObject.Properties) {
                $channelAttempts = 0
                [void][int]::TryParse("$($channelProp.Value)", [ref]$channelAttempts)
                $attemptsByChannel[$channelProp.Name] = $channelAttempts
            }
        }
        $deliveredChannels = [System.Collections.Generic.List[string]]::new()
        foreach ($channelName in @(Get-TvProp $entry "deliveredChannels")) {
            $channelText = Get-TvText $channelName
            if ($channelText) { $deliveredChannels.Add($channelText) }
        }
        $deadChannels = [System.Collections.Generic.List[string]]::new()
        foreach ($channelName in @(Get-TvProp $entry "deadChannels")) {
            $channelText = Get-TvText $channelName
            if ($channelText -and -not $deliveredChannels.Contains($channelText)) { $deadChannels.Add($channelText) }
        }
        # Entries saved before deadChannels existed: a destination already at the
        # attempt limit is dead by definition and must not be attempted again.
        foreach ($channelName in @($attemptsByChannel.Keys)) {
            if ([int]$attemptsByChannel[$channelName] -ge 5 -and -not $deliveredChannels.Contains([string]$channelName) -and
                -not $deadChannels.Contains([string]$channelName)) {
                $deadChannels.Add([string]$channelName)
            }
        }
        # The intended destinations are frozen at enqueue time. Entries saved before
        # this field existed inherit the destinations configured at load time.
        $hasIntendedChannels = $false
        if ($entry -is [System.Collections.IDictionary]) { $hasIntendedChannels = $entry.Contains("intendedChannels") }
        elseif ($entry) { $hasIntendedChannels = $null -ne $entry.PSObject.Properties["intendedChannels"] }
        $intendedChannels = [System.Collections.Generic.List[string]]::new()
        if ($hasIntendedChannels) {
            foreach ($channelName in @(Get-TvProp $entry "intendedChannels")) {
                $channelText = Get-TvText $channelName
                if ($channelText -and -not $intendedChannels.Contains($channelText)) { $intendedChannels.Add($channelText) }
            }
        } else {
            foreach ($channelName in $DefaultIntendedChannels) {
                if ($channelName -and -not $intendedChannels.Contains($channelName)) { $intendedChannels.Add($channelName) }
            }
        }
        $TargetList.Add([pscustomobject][ordered]@{
            envelope = $savedEnvelope
            attempts = $savedAttempts
            attemptsByChannel = $attemptsByChannel
            deliveredChannels = $deliveredChannels
            deadChannels = $deadChannels
            intendedChannels = $intendedChannels
            lastError = Get-TvText (Get-TvProp $entry "lastError")
        })
    }
}

function Add-TvDeliveryFailure {
    param(
        [Parameter(Mandatory)][object]$Entry,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$ErrorText
    )
    $attemptsByChannel = $Entry.attemptsByChannel
    $channelAttempts = 0
    if ($attemptsByChannel.Contains($Destination)) { $channelAttempts = [int]$attemptsByChannel[$Destination] }
    $channelAttempts++
    $attemptsByChannel[$Destination] = $channelAttempts
    $Entry.attempts = [int](Get-TvProp $Entry "attempts") + 1
    $Entry.lastError = "${Destination}: $(Get-TvSafeError $ErrorText)"
    # Exhaustion is per destination: only this destination stops being attempted.
    # Other intended destinations keep their own lifecycle on the same entry.
    if ($channelAttempts -ge 5 -and -not $Entry.deadChannels.Contains($Destination)) {
        $Entry.deadChannels.Add($Destination)
    }
    return $channelAttempts
}

function Get-TvOutboxTerminalState {
    param([Parameter(Mandatory)][object]$Entry)
    $intended = $Entry.intendedChannels
    if ($intended.Count -eq 0) { return "pending" }
    foreach ($destination in $intended) {
        if (-not $Entry.deliveredChannels.Contains($destination) -and -not $Entry.deadChannels.Contains($destination)) {
            return "pending"
        }
    }
    if ($Entry.deliveredChannels.Count -gt 0) { return "sent" }
    return "dead"
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

function Send-TvRawMail {
    param(
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string[]]$To,
        [Parameter(Mandatory)][string]$Subject,
        [Parameter(Mandatory)][string]$BodyText,
        [Parameter(Mandatory)][string]$GraphToken,
        [ValidateSet("Text", "HTML")][string]$BodyContentType = "Text"
    )
    $message = [pscustomobject][ordered]@{
        message = [pscustomobject][ordered]@{
            subject = $Subject
            body = [pscustomobject][ordered]@{ contentType = $BodyContentType; content = $BodyText }
            toRecipients = @($To | ForEach-Object {
                [pscustomobject][ordered]@{ emailAddress = [pscustomobject][ordered]@{ address = $_ } }
            })
        }
        saveToSentItems = $false
    }
    $senderEncoded = [uri]::EscapeDataString($From)
    try {
        Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/users/$senderEncoded/sendMail" -Method Post `
            -Headers @{ Authorization = "Bearer $GraphToken" } `
            -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-TenuVaultCanonicalJson $message))) `
            -ContentType "application/json; charset=utf-8" -TimeoutSec 30 | Out-Null
    } catch {
        # Surface the Graph error code and message: a bare "403 Forbidden" cannot
        # distinguish a missing Mail.Send role from an application access policy
        # that has not propagated yet.
        $statusCode = 0
        $detail = Get-TvSafeError $_.Exception.Message
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        # The error record usually carries the Graph body already. The response
        # stream is only a fallback, and it can sit at its end in PowerShell 5.1,
        # so rewind it first when it supports seeking.
        $bodyText = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $bodyText = [string]$_.ErrorDetails.Message }
        if (-not $bodyText -and $_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream.CanSeek) { $stream.Position = 0 }
                $reader = New-Object System.IO.StreamReader($stream)
                $bodyText = $reader.ReadToEnd()
                $reader.Dispose()
            } catch { }
        }
        if ($bodyText) {
            try {
                $parsed = $bodyText | ConvertFrom-Json -ErrorAction Stop
                $graphError = Get-TvProp $parsed "error"
                $code = Get-TvText (Get-TvProp $graphError "code")
                $messageText = Get-TvText (Get-TvProp $graphError "message")
                if ($code -or $messageText) { $detail = Get-TvSafeError "$code $messageText" }
            } catch { }
        }
        if ($statusCode -gt 0) { throw "Mail send as $From failed with HTTP $statusCode. $detail" }
        throw "Mail send as $From failed. $detail"
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
    $to = @(($Recipients -split "[,;]") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($to.Count -eq 0) { throw "Mail delivery failed: TenuVaultMailRecipients contains no recipient addresses." }
    Send-TvRawMail -From $MailSender -To $to -Subject $subject -BodyText (Get-TvEmailHtml $Envelope) -GraphToken $GraphToken -BodyContentType "HTML"
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
$configHash = $null
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
    $mailProbeMailbox = Get-TvAutomationVariable "TenuVaultMailProbeMailbox"
    $configVersionValue = Get-TvAutomationVariable "TenuVaultConfigVersion"
    if ($configVersionValue) { $configVersion = $configVersionValue.Trim() }

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

    # Fingerprint of the effective configuration for the heartbeat: non-secret values
    # in full, secrets only as presence flags, so drift is visible without leaking.
    $configFingerprint = @(
        "tenantId=$($tenantId.ToLowerInvariant())"
        "tenantName=$tenantName"
        "storageAccount=$storageAccount"
        "mailSender=$mailSender"
        "mailRecipients=$mailRecipients"
        "mailProbeMailbox=$mailProbeMailbox"
        "missedBackupHours=$missedBackupHours"
        "includeActor=$($includeActor.ToString().ToLowerInvariant())"
        "configVersion=$configVersion"
        "webhookUrl=$(if ($webhookUrl) { 'present' } else { 'absent' })"
        "webhookSecret=$(if ($webhookSecret) { 'present' } else { 'absent' })"
        "teamsWebhookUrl=$(if ($teamsWebhookUrl) { 'present' } else { 'absent' })"
    ) -join "|"
    $configHash = Get-TvSha256Hex $configFingerprint

    # Storage first: state, lease and queued deliveries must keep working when
    # Graph token acquisition fails. The Graph failure is deferred like an
    # ingestion failure and surfaces at the end of the run.
    $storageToken = Get-TvManagedIdentityToken "https://storage.azure.com/"
    $graphToken = $null
    $graphTokenError = $null
    try {
        $graphToken = Get-TvManagedIdentityToken "https://graph.microsoft.com/"
    } catch {
        $graphTokenError = "Graph token acquisition failed: $(Get-TvSafeError $_.Exception.Message)"
        Write-Output "$graphTokenError Audit ingestion is skipped; missed backup checking and pending deliveries still run."
    }

    $stateContainerUri = "https://$storageAccount.blob.core.windows.net/tenuvault-notification-state"
    $stateBlobUri = "$stateContainerUri/state.json"
    $heartbeatBlobUri = "$stateContainerUri/heartbeat.json"
    $leaseQueryUri = "$stateBlobUri`?comp=lease"

    # Only configuration version 1 is understood. Anything else stops the run
    # before any polling, with the reason recorded in the heartbeat.
    if ($configVersion -ne "1") {
        $lastError = "Unsupported TenuVaultConfigVersion '$configVersion'. This runbook supports version 1 only."
        try {
            $rejectedHeartbeat = [pscustomobject][ordered]@{
                runAt = $runAtIso
                runbookVersion = $runbookVersion
                configVersion = $configVersion
                configHash = $configHash
                watermark = $watermarkIso
                eventsSent = $eventsSent
                lastError = $lastError
            }
            Set-TvBlobText -Uri $heartbeatBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $rejectedHeartbeat)
        } catch { Write-Output "Could not write the config rejection heartbeat." }
        throw $lastError
    }

    # Create the state blob once, then take the lease before any delivery. The lease
    # lasts 60 seconds and is renewed before every delivery attempt and every state
    # save, and released in the finally block below. A lease orphaned by a killed
    # run therefore self heals within 60 seconds. A run that finds the lease held
    # exits quietly: the other run owns delivery for this window.
    $existingStateText = Get-TvBlobText -Uri $stateBlobUri -Token $storageToken
    if ($null -eq $existingStateText) {
        $initialWatermark = ConvertTo-TvIso $runAt.AddHours(-1)
        $initialState = [pscustomobject][ordered]@{
            tenantId = $tenantId.ToLowerInvariant(); configVersion = $configVersion
            watermark = $initialWatermark
            recentAuditIds = @(); sentEventIds = @(); lastMissedKey = $null; continuation = $null
            pendingEnvelopes = @(); deadEnvelopes = @(); mailVerified = $false; mailVerifiedSender = $null; mailVerifiedAt = $null
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
    $state = if ($stateText) { ConvertFrom-TvJson $stateText } else { $null }
    $stateTenantId = if ($state) { Get-TvText (Get-TvProp $state "tenantId") } else { $null }
    if ($stateTenantId -and $stateTenantId.ToLowerInvariant() -ne $tenantId.ToLowerInvariant()) {
        throw "State tenant does not match TenuVaultTenantId. Refusing to run against the wrong tenant state."
    }
    $watermarkIso = if ($state) { ConvertTo-TvIso (Get-TvProp $state "watermark") } else { $null }
    if (-not $watermarkIso) { $watermarkIso = ConvertTo-TvIso $runAt.AddHours(-1) }

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
    $continuation = if ($state) { Get-TvText (Get-TvProp $state "continuation") } else { $null }
    $mailVerified = $false
    $mailVerifiedSender = $null
    $mailVerifiedAt = $null
    if ($state) {
        $mailVerified = (Get-TvProp $state "mailVerified") -eq $true
        $mailVerifiedSender = Get-TvText (Get-TvProp $state "mailVerifiedSender")
        $mailVerifiedAt = ConvertTo-TvIso (Get-TvProp $state "mailVerifiedAt")
    }

    # Destinations an envelope is owed to, judged by configuration, not by current
    # eligibility: configured but unverified mail still counts as intended.
    $configuredDestinations = [System.Collections.Generic.List[string]]::new()
    if ($webhookUrl) { $configuredDestinations.Add("webhook") }
    if ($teamsWebhookUrl) { $configuredDestinations.Add("teams") }
    if ($mailSender -and $mailRecipients) { $configuredDestinations.Add("mail") }

    # Delivery outbox: envelopes waiting for a successful send, with per destination
    # delivery and retry state. Each list is passed to the loader as an explicit
    # argument: an if expression producing the list would enumerate an empty list
    # into $null in the pipeline and crash the reload on the first saved entry.
    $pendingEnvelopes = [System.Collections.Generic.List[object]]::new()
    $deadEnvelopes = [System.Collections.Generic.List[object]]::new()
    Add-TvSavedEnvelopes -State $state -ListName "pendingEnvelopes" -TargetList $pendingEnvelopes `
        -DefaultIntendedChannels @($configuredDestinations.ToArray())
    Add-TvSavedEnvelopes -State $state -ListName "deadEnvelopes" -TargetList $deadEnvelopes `
        -DefaultIntendedChannels @($configuredDestinations.ToArray())

    # Builds the full state object from the live collections. Used for every save,
    # so the pre delivery save and the final save can never drift apart in shape.
    $buildState = {
        # Recent audit ids only need to cover the re-read window: entries older than
        # the watermark minus 30 minutes can never be fetched again, so pruning is
        # relative to the watermark, never to run time. The cap is a high safety
        # bound that drops the oldest entries only.
        $pruneBefore = ConvertTo-TvIso ([DateTimeOffset]::Parse($watermarkIso).UtcDateTime.AddMinutes(-30))
        $recentList = [System.Collections.Generic.List[object]]::new()
        foreach ($entryId in $recentById.Keys) {
            $entryAt = $recentById[$entryId]
            if ($entryAt -and [StringComparer]::Ordinal.Compare([string]$entryAt, $pruneBefore) -lt 0) { continue }
            $recentList.Add([pscustomobject][ordered]@{ id = [string]$entryId; at = [string]$entryAt })
        }
        $recentTrimmed = @($recentList | Sort-Object { [string](Get-TvProp $_ "at") } -Descending | Select-Object -First 25000)
        [array]::Reverse($recentTrimmed)
        $sentArr = @($sentEventIds.ToArray())
        if ($sentArr.Count -gt 2000) { $sentArr = $sentArr[($sentArr.Count - 2000)..($sentArr.Count - 1)] }
        $deadArr = @($deadEnvelopes.ToArray())
        if ($deadArr.Count -gt 50) { $deadArr = $deadArr[($deadArr.Count - 50)..($deadArr.Count - 1)] }
        [pscustomobject][ordered]@{
            tenantId = $tenantId.ToLowerInvariant()
            configVersion = $configVersion
            watermark = $watermarkIso
            recentAuditIds = $recentTrimmed
            sentEventIds = $sentArr
            lastMissedKey = $lastMissedKey
            continuation = $continuation
            pendingEnvelopes = @($pendingEnvelopes.ToArray())
            deadEnvelopes = $deadArr
            mailVerified = $mailVerified
            mailVerifiedSender = $mailVerifiedSender
            mailVerifiedAt = $mailVerifiedAt
        }
    }

    # Persists state through the builder with a lease renewal first. Used after
    # ingestion, after each destination result, and at the end of the run.
    $saveState = {
        Save-TvStateBlob -Uri $stateBlobUri -LeaseQueryUri $leaseQueryUri -Token $storageToken `
            -Text (ConvertTo-TenuVaultCanonicalJson (& $buildState)) -LeaseId $leaseId
    }

    # Mail gate: Mail.Send must be proven restricted to the sender mailbox before
    # any notification mail is sent. Verification sends as the sender (must work)
    # and as an unrelated probe mailbox (must be rejected by the access policy).
    if ($VerifyMailOnly) {
        # A verification run distrusts any earlier result from the very start, before
        # any validation that can throw, so a failed or interrupted verify can never
        # leave a stale approval behind.
        $mailVerified = $false
        $mailVerifiedSender = $null
        $mailVerifiedAt = $null
        & $saveState
        if (-not $mailSender) { throw "TenuVaultMailSender is not set. Configure the sender mailbox before running mail verification." }
        if (-not $mailProbeMailbox) { throw "TenuVaultMailProbeMailbox is not set. Configure a mailbox outside the mail access policy scope before running mail verification." }
        if ($mailProbeMailbox.ToLowerInvariant() -eq $mailSender.ToLowerInvariant()) { throw "TenuVaultMailProbeMailbox must differ from TenuVaultMailSender." }
        Send-TvRawMail -From $mailSender -To @($mailSender) -Subject "TenuVault mail verification" `
            -BodyText "The TenuVault watcher verified that it can send mail as $mailSender." -GraphToken $graphToken
        Write-Output "Sending as the configured sender mailbox works."
        Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId
        $probeSucceeded = $false
        $probeStatusCode = 0
        $probeErrorText = $null
        try {
            Send-TvRawMail -From $mailProbeMailbox -To @($mailSender) -Subject "TenuVault mail verification probe" `
                -BodyText "This message must never arrive. It proves Mail.Send is not restricted." -GraphToken $graphToken
            $probeSucceeded = $true
        } catch {
            if ($_.Exception.Response) { $probeStatusCode = [int]$_.Exception.Response.StatusCode }
            $probeErrorText = Get-TvSafeError $_.Exception.Message
            # Send-TvRawMail rethrows with the status in its message and no Response.
            if ($probeStatusCode -eq 0 -and $_.Exception.Message -match "HTTP (\d{3})") { $probeStatusCode = [int]$Matches[1] }
        }
        if ($probeSucceeded) {
            throw "Mail verification failed: the watcher identity could send as $mailProbeMailbox, so Mail.Send is not restricted to $mailSender. Apply an Exchange application access policy, then run verification again."
        }
        if ($probeStatusCode -ne 403) {
            $probeReason = if ($probeStatusCode -gt 0) {
                "HTTP $probeStatusCode. $probeErrorText"
            } else {
                "no HTTP status (timeout or network error). $probeErrorText"
            }
            throw "Mail verification failed: sending as probe mailbox $mailProbeMailbox was expected to be rejected with HTTP 403, but the outcome was $probeReason Only an HTTP 403 rejection proves the application access policy blocks other mailboxes. Fix the cause, then run verification again."
        }
        Write-Output "Sending as the probe mailbox was rejected with HTTP 403, as required."
        $mailVerified = $true
        $mailVerifiedSender = $mailSender
        $mailVerifiedAt = $runAtIso
        & $saveState
        $verifiedHeartbeat = [pscustomobject][ordered]@{
            runAt = $runAtIso
            runbookVersion = $runbookVersion
            configVersion = $configVersion
            configHash = $configHash
            watermark = $watermarkIso
            eventsSent = $eventsSent
            lastError = $null
        }
        Set-TvBlobText -Uri $heartbeatBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $verifiedHeartbeat)
        Write-Output "Mail verification passed. mailVerified is recorded in state.json."
        return
    }

    $mailConfigured = [bool]($mailSender -and $mailRecipients)
    # Verification proves the access policy as it was on that day. Policies drift, so
    # a verification older than 90 days (or without a recorded date) no longer counts.
    $verificationFresh = $false
    if ($mailVerifiedAt) {
        $verifiedAge = ([DateTimeOffset]$runAt) - [DateTimeOffset]::Parse($mailVerifiedAt)
        $verificationFresh = $verifiedAge.TotalDays -le 90
    }
    $senderMatches = $mailVerifiedSender -and $mailSender -and
        ($mailSender.ToLowerInvariant() -eq $mailVerifiedSender.ToLowerInvariant())
    $senderVerified = [bool]($mailVerified -and $senderMatches -and $verificationFresh)
    $mailEnabled = $mailConfigured -and $senderVerified
    if (($mailSender -or $mailRecipients) -and -not $senderVerified) {
        $lastError = if ($mailVerified -and $mailVerifiedSender -and $mailSender -and $mailSender.ToLowerInvariant() -ne $mailVerifiedSender.ToLowerInvariant()) {
            "Mail delivery is skipped: the configured sender $mailSender differs from the verified sender $mailVerifiedSender. Run this runbook once with -VerifyMailOnly for the new sender."
        } elseif ($mailVerified -and $senderMatches -and -not $verificationFresh) {
            "Mail delivery is skipped: the mail verification for $mailSender is older than 90 days. Run this runbook once with -VerifyMailOnly to verify again."
        } else {
            "Mail delivery is skipped until mail verification passes. Run this runbook once with -VerifyMailOnly after restricting Mail.Send to the sender mailbox."
        }
        Write-Output $lastError
    }

    # --- Intune audit events ---------------------------------------------------
    $filterFrom = ConvertTo-TvIso ([DateTimeOffset]::Parse($watermarkIso).UtcDateTime.AddMinutes(-30))
    $select = "id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources"
    $query = "`$select=$([uri]::EscapeDataString($select))&`$filter=$([uri]::EscapeDataString("activityDateTime gt $filterFrom and activityOperationType ne 'Get' and activityOperationType ne 'Search'"))&`$orderby=$([uri]::EscapeDataString('activityDateTime'))&`$top=200"
    $freshUri = "https://graph.microsoft.com/beta/deviceManagement/auditEvents?$query"
    $graphHeaders = @{ Authorization = "Bearer $graphToken"; ConsistencyLevel = "eventual" }

    # The ingestion cap counts NEW changes only. Duplicates inside the 30 minute
    # overlap never consume budget, and the watermark tracks the newest event seen
    # (duplicates included), so a busy overlap window cannot stall progress.
    # A saved continuation resumes exactly where the previous run stopped, before
    # any fresh overlap query. Like the desktop poller, the leftover page URL is
    # what gets persisted: the current page when the new event cap breaks mid page
    # (its remaining events are re-read and deduped), or the next link when a full
    # page was consumed and the page cap stopped the loop.
    $priorRecent = @{}
    foreach ($priorId in $recentById.Keys) { $priorRecent[[string]$priorId] = $true }
    $newChanges = [System.Collections.Generic.List[object]]::new()
    $seenThisRun = @{}
    $seenCount = 0
    $newestSeenIso = $watermarkIso
    $ingestionCapReached = $false
    $pageCount = 0
    $nextUri = $freshUri
    $resumedContinuation = $false
    $ingestionError = $graphTokenError
    if ($continuation) {
        $nextUri = $continuation
        $resumedContinuation = $true
    }
    while ($graphToken -and $nextUri -and -not $ingestionCapReached -and $pageCount -lt 500) {
        Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId
        $pageCount++
        $page = $null
        try {
            $page = Invoke-RestMethod -Uri $nextUri -Headers $graphHeaders -Method Get -TimeoutSec 60
        } catch {
            $pageStatusCode = 0
            if ($_.Exception.Response) { $pageStatusCode = [int]$_.Exception.Response.StatusCode }
            if ($resumedContinuation -and $pageStatusCode -eq 400) {
                # A stored continuation can expire. Discard it and restart once
                # from the fresh overlap query inside the same run.
                Write-Output "The saved audit continuation was rejected with HTTP 400. Restarting from the overlap query."
                $continuation = $null
                $resumedContinuation = $false
                $nextUri = $freshUri
                continue
            }
            # A Graph outage or a persistent 403 must not abort the run here:
            # record it, stop ingesting, and still run the missed backup check
            # and every pending delivery. The run fails nonzero at the very end.
            $ingestionError = "Audit ingestion failed: $(Get-TvSafeError $_.Exception.Message)"
            Write-Output "$ingestionError Pending deliveries will still be attempted."
            break
        }
        $resumedContinuation = $false
        foreach ($rawEvent in @($page.value)) {
            if ($null -eq $rawEvent) { continue }
            $seenCount++
            $rawAt = ConvertTo-TvIso (Get-TvProp $rawEvent "activityDateTime")
            if ($rawAt -and [StringComparer]::Ordinal.Compare($rawAt, $newestSeenIso) -gt 0) { $newestSeenIso = $rawAt }
            $change = ConvertFrom-TenuVaultAuditEvent $rawEvent
            if (-not $change) { continue }
            $auditIdValue = [string](Get-TvProp $change "auditId")
            if ($priorRecent.ContainsKey($auditIdValue) -or $seenThisRun.ContainsKey($auditIdValue)) { continue }
            if ($newChanges.Count -ge 500) { $ingestionCapReached = $true; break }
            $seenThisRun[$auditIdValue] = $true
            $newChanges.Add($change)
        }
        if (-not $ingestionCapReached) {
            $nextUri = Get-TvText (Get-TvProp $page "@odata.nextLink")
        }
    }
    if ($ingestionError) {
        # Discard the partial collection and keep the saved watermark and
        # continuation, so the next run retries the same window cleanly.
        $newChanges.Clear()
        $newestSeenIso = $watermarkIso
        if (-not $lastError) { $lastError = $ingestionError }
    } else {
        # Persist wherever paging stopped: the next page URL after a fully consumed
        # page, the current page URL when the new event cap broke mid page, or null
        # when pagination ran to exhaustion.
        $continuation = Get-TvText $nextUri
    }
    Write-Output "Seen $seenCount audit events, $($newChanges.Count) new."

    $candidateEnvelopes = [System.Collections.Generic.List[object]]::new()
    if ($newChanges.Count -gt 0) {
        $candidateEnvelopes.Add((New-TenuVaultAuditDigest -TenantId $tenantId -TenantName $tenantName `
            -Changes @($newChanges.ToArray()) -IncludeActor $includeActor))
    }

    # --- Missed backup check -----------------------------------------------------
    # A listing failure must never block delivery of envelopes already waiting in
    # the outbox: record the error, skip missed detection for this run, and carry
    # on. Lease renewal failure stays fatal and is raised outside this guard.
    $newestBackup = $null
    $missedCheckFailed = $false
    $marker = $null
    do {
        Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId
        try {
            $listUri = "https://$storageAccount.blob.core.windows.net/intune-backups?restype=container&comp=list&delimiter=%2F&maxresults=5000"
            if ($marker) { $listUri += "&marker=$([uri]::EscapeDataString($marker))" }
            $listResponse = Invoke-TvStorageRequest -Uri $listUri -Method Get -Token $storageToken
            # Windows PowerShell 5.1 in the Automation sandbox can misdecode the
            # UTF-8 BOM of the storage response into leading garbage characters.
            # Skip everything before the first tag so the cast always sees XML.
            $listText = [string]$listResponse.Content
            $xmlStart = $listText.IndexOf("<")
            if ($xmlStart -gt 0) { $listText = $listText.Substring($xmlStart) }
            [xml]$listXml = $listText
            $names = [System.Collections.Generic.List[string]]::new()
            $blobsNode = $listXml.EnumerationResults.Blobs
            if ($blobsNode) {
                foreach ($prefix in @($blobsNode.BlobPrefix)) { if ($prefix -and $prefix.Name) { $names.Add([string]$prefix.Name) } }
                foreach ($blob in @($blobsNode.Blob)) { if ($blob -and $blob.Name) { $names.Add([string]$blob.Name) } }
            }
            foreach ($name in $names) {
                $folderTime = Get-TenuVaultBackupFolderTime $name
                if ($folderTime -and (-not $newestBackup -or $folderTime -gt $newestBackup)) { $newestBackup = $folderTime }
            }
            $marker = [string]$listXml.EnumerationResults.NextMarker
            if (-not $marker) { $marker = $null }
        } catch {
            $missedCheckFailed = $true
            $marker = $null
            $listingError = "Missed backup check failed and was skipped for this run: $(Get-TvSafeError $_.Exception.Message)"
            Write-Output $listingError
            if (-not $lastError) { $lastError = $listingError }
        }
    } while ($marker)

    $newestBackupIso = if ($newestBackup) { ConvertTo-TvIso $newestBackup } else { $null }
    $missedThresholdTime = $runAt.AddHours(-$missedBackupHours)
    $missedKeyToSet = $null
    if (-not $missedCheckFailed -and (-not $newestBackup -or $newestBackup -lt $missedThresholdTime)) {
        $missedEvent = New-TenuVaultMissedBackupEvent -TenantId $tenantId -TenantName $tenantName `
            -OccurredAt $runAtIso -LastBackupAt $newestBackupIso -ThresholdHours $missedBackupHours
        $missedKeyToSet = "missed:$(if ($newestBackupIso) { $newestBackupIso } else { 'none' }):$missedBackupHours"
        $candidateEnvelopes.Add($missedEvent)
    }

    # --- Ingest into the outbox, then mark sources consumed and SAVE --------------
    # Nothing is marked consumed until its envelope is safely in pendingEnvelopes,
    # and state is persisted before any delivery attempt. A crash after this save
    # retries from the outbox on the next run instead of losing the events.
    $knownEventIds = @{}
    foreach ($pendingEntry in $pendingEnvelopes) { $knownEventIds[[string](Get-TvProp (Get-TvProp $pendingEntry "envelope") "eventId")] = $true }
    foreach ($deadEntry in $deadEnvelopes) { $knownEventIds[[string](Get-TvProp (Get-TvProp $deadEntry "envelope") "eventId")] = $true }
    foreach ($sentId in $sentEventIds) { $knownEventIds[[string]$sentId] = $true }
    foreach ($candidate in $candidateEnvelopes) {
        $candidateId = [string](Get-TvProp $candidate "eventId")
        if ($knownEventIds.ContainsKey($candidateId)) { continue }
        $knownEventIds[$candidateId] = $true
        $intendedChannels = [System.Collections.Generic.List[string]]::new()
        foreach ($channelName in $configuredDestinations) { $intendedChannels.Add($channelName) }
        $pendingEnvelopes.Add([pscustomobject][ordered]@{
            envelope = $candidate
            attempts = 0
            attemptsByChannel = [ordered]@{}
            deliveredChannels = [System.Collections.Generic.List[string]]::new()
            deadChannels = [System.Collections.Generic.List[string]]::new()
            intendedChannels = $intendedChannels
            lastError = $null
        })
    }
    foreach ($change in $newChanges) {
        $recentById[[string](Get-TvProp $change "auditId")] = [string](Get-TvProp $change "at")
    }
    if ($missedKeyToSet) { $lastMissedKey = $missedKeyToSet }
    $watermarkIso = $newestSeenIso
    & $saveState

    # --- Delivery from the outbox, per destination -----------------------------------
    # Each destination is attempted independently. Right after a destination accepts
    # an envelope it is recorded in deliveredChannels and state is saved, so a retry
    # never resends to a destination that already got it. Completion is judged against
    # the intended destinations frozen on the entry at enqueue time, never against
    # what is eligible right now. An intended destination that is not currently
    # eligible (for example configured mail that is not verified yet) is not
    # attempted, consumes no attempts, and keeps the envelope pending.
    $newlyExhausted = [System.Collections.Generic.List[string]]::new()
    $eligibleDestinations = [System.Collections.Generic.List[string]]::new()
    if ($webhookUrl) { $eligibleDestinations.Add("webhook") }
    if ($teamsWebhookUrl) { $eligibleDestinations.Add("teams") }
    if ($mailEnabled) { $eligibleDestinations.Add("mail") }

    if ($pendingEnvelopes.Count -gt 0 -and $eligibleDestinations.Count -eq 0) {
        Write-Output "No delivery channel is currently eligible. $($pendingEnvelopes.Count) envelope(s) remain in the outbox."
    } else {
        foreach ($pendingEntry in @($pendingEnvelopes.ToArray())) {
            $envelope = Get-TvProp $pendingEntry "envelope"
            $eventIdValue = [string](Get-TvProp $envelope "eventId")
            if ($sentEventIds.Contains($eventIdValue)) {
                [void]$pendingEnvelopes.Remove($pendingEntry)
                continue
            }
            $deliveredChannels = $pendingEntry.deliveredChannels
            $intendedChannels = $pendingEntry.intendedChannels
            if ($intendedChannels.Count -eq 0 -and $configuredDestinations.Count -gt 0) {
                foreach ($channelName in $configuredDestinations) { $intendedChannels.Add($channelName) }
                & $saveState
            }
            foreach ($destination in @($intendedChannels.ToArray())) {
                if ($deliveredChannels.Contains($destination)) { continue }
                if ($pendingEntry.deadChannels.Contains($destination)) { continue }
                if (-not $eligibleDestinations.Contains($destination)) { continue }
                Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId
                $sendError = $null
                try {
                    switch ($destination) {
                        "webhook" { Send-TvWebhook -Envelope $envelope -Url $webhookUrl -Secret $webhookSecret }
                        "teams" { Send-TvTeams -Envelope $envelope -Url $teamsWebhookUrl }
                        "mail" { Send-TvMail -Envelope $envelope -MailSender $mailSender -Recipients $mailRecipients -GraphToken $graphToken }
                    }
                } catch {
                    $sendError = $_
                }
                if ($null -eq $sendError) {
                    $deliveredChannels.Add($destination)
                    & $saveState
                } else {
                    $channelAttempts = Add-TvDeliveryFailure -Entry $pendingEntry -Destination $destination `
                        -ErrorText $sendError.Exception.Message
                    if ($channelAttempts -eq 5) { $newlyExhausted.Add("${destination}: $(Get-TvSafeError $sendError.Exception.Message)") }
                    Write-Output "Delivery to $destination failed for event $($eventIdValue.Substring(0, 12)) attempt ${channelAttempts}: $($pendingEntry.lastError)"
                    if (-not $lastError) { $lastError = $pendingEntry.lastError }
                    & $saveState
                }
            }
            # Terminal only when every intended destination is delivered or dead.
            # A gated or still retrying destination keeps the entry pending, even
            # when another destination on the same entry just exhausted.
            $terminalState = Get-TvOutboxTerminalState -Entry $pendingEntry
            if ($terminalState -eq "dead") {
                [void]$pendingEnvelopes.Remove($pendingEntry)
                $deadEnvelopes.Add($pendingEntry)
                while ($deadEnvelopes.Count -gt 50) { $deadEnvelopes.RemoveAt(0) }
                $lastError = "Event $($eventIdValue.Substring(0, 12)) moved to deadEnvelopes: every intended destination is dead and none delivered. Last error: $($pendingEntry.lastError)"
                & $saveState
            } elseif ($terminalState -eq "sent") {
                [void]$pendingEnvelopes.Remove($pendingEntry)
                $sentEventIds.Add($eventIdValue)
                $eventsSent++
                if ($pendingEntry.deadChannels.Count -gt 0) {
                    $lastError = "Event $($eventIdValue.Substring(0, 12)) completed with dead destination(s): $($pendingEntry.deadChannels -join ', '). Last error: $($pendingEntry.lastError)"
                }
                & $saveState
            }
        }
    }

    # --- Persist final state and heartbeat ------------------------------------------
    & $saveState

    $heartbeat = [pscustomobject][ordered]@{
        runAt = $runAtIso
        runbookVersion = $runbookVersion
        configVersion = $configVersion
        configHash = $configHash
        watermark = $watermarkIso
        eventsSent = $eventsSent
        lastError = $lastError
    }
    Set-TvBlobText -Uri $heartbeatBlobUri -Token $storageToken -Text (ConvertTo-TenuVaultCanonicalJson $heartbeat)
    Write-Output "Watcher run complete. Events sent: $eventsSent. Pending: $($pendingEnvelopes.Count). Watermark: $watermarkIso."
    # State and heartbeat are persisted and deliveries were attempted. Only now
    # surface failed ingestion, a failed missed backup check, or a destination
    # that exhausted its retries as a failed run, so all three stay observable
    # in the Automation job status and the failure alert without losing work.
    # An exhausted destination fails exactly the run that exhausts it; later
    # runs keep delivering other work without re-alarming every hour.
    if ($ingestionError) { throw $ingestionError }
    if ($missedCheckFailed) { throw "Missed backup check failed for this run. See the heartbeat lastError for details." }
    if ($newlyExhausted.Count -gt 0) { throw "A notification destination exhausted its retries and its events need attention: $($newlyExhausted -join '; ')" }
} catch {
    $lastError = Get-TvSafeError $_.Exception.Message
    if ($leaseId -and $storageToken -and $heartbeatBlobUri) {
        try {
            $failedHeartbeat = [pscustomobject][ordered]@{
                runAt = $runAtIso
                runbookVersion = $runbookVersion
                configVersion = $configVersion
                configHash = $configHash
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
        } catch { Write-Output "Could not release the state lease. It expires on its own within 60 seconds." }
    }
}



