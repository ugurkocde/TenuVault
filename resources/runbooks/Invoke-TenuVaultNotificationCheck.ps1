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

    Payload allowlist: envelopes carry names, object ids, counts, statuses, timestamps,
    the names of changed settings and, when TenuVaultIncludeActor is true, actor UPNs.
    Audit request bodies are never read. Changed property values are only compared, in
    the changed settings library, to name the settings an update changed; they are
    never kept, logged or sent. Secrets, tokens and URLs with query strings are never
    logged.

    With TenuVaultAlertRules (setup -AlertRulesPath) each event goes only where the
    alerts copied from TenuVault send it, planned exactly like the desktop app.

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
    # Compared by code point: a switch on the character compares strings culture aware, and
    # characters that sort as ignorable (soft hyphen, zero width joiner, BOM) would match "`b".
    foreach ($char in $Value.ToCharArray()) {
        switch ([int]$char) {
            0x22 { [void]$sb.Append('\"'); continue }
            0x5C { [void]$sb.Append('\\'); continue }
            0x08 { [void]$sb.Append('\b'); continue }
            0x0C { [void]$sb.Append('\f'); continue }
            0x0A { [void]$sb.Append('\n'); continue }
            0x0D { [void]$sb.Append('\r'); continue }
            0x09 { [void]$sb.Append('\t'); continue }
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
        $itemChange = Get-TvProp $item "change"
        if ($itemChange) { $entry["change"] = ConvertTo-TvCleanItemChange $itemChange }
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
# Library: changed setting names (mirrors src/shared/notifications/settings.ts)
# ---------------------------------------------------------------------------
# Intune and Entra log each changed property of an update with its old and new value.
# The values are compared here, in memory, and dropped: only the names of the settings
# whose value changed are returned. A value is never kept, logged or sent. A create or
# delete lists every property of the object, so only updates ask for changed settings.

$script:TvMaxSettingNames = 15
# Names kept per change for alert matching; messages show $script:TvMaxSettingNames of them.
$script:TvMaxTrackedSettings = 200
$script:TvSettingNoise = @("id", "createddatetime", "lastmodifieddatetime", "modifieddatetime", "version", "devicemanagementapiversion", "templateid", "deleteddatetime")

# A logged value as text, or $null when that side was not recorded (JSON null). PowerShell 7
# before 7.5 turns ISO times into DateTime values while parsing; those still count as recorded.
function Get-TvLoggedValue {
    param([AllowNull()][object]$Value)
    if ($Value -is [string]) { return $Value }
    if ($Value -is [DateTime] -or $Value -is [DateTimeOffset]) { return ConvertTo-TvIso $Value }
    return $null
}

# "<null>" and "null" are how Intune writes a recorded empty value; both mean the same.
function Get-TvNormalizedSettingValue {
    param([AllowNull()][string]$Value)
    $trimmed = ([string]$Value).Trim()
    if ($trimmed -ceq "<null>" -or $trimmed -ceq "null") { return "" }
    return $trimmed
}

# "$Collection.RoleScopeTagIds[0]" as "RoleScopeTagIds": one name per collection, not per index.
function Get-TvSettingName {
    param([AllowNull()][string]$Raw)
    $name = ((([string]$Raw) -creplace '^\$Collection\.', '') -creplace '\[[0-9]+\]', '').Trim()
    if (-not $name -or $script:TvSettingNoise -contains $name.ToLowerInvariant()) { return $null }
    if ($name.Length -gt 120) { $name = $name.Substring(0, 120) }
    return $name
}

function Get-TvBoundedSettings {
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Names)
    $unique = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Names) {
        if ($seen.Add($name.ToLowerInvariant())) { $unique.Add($name) }
    }
    $shown = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $unique) { if ($shown.Count -lt $script:TvMaxTrackedSettings) { $shown.Add($name) } }
    return [pscustomobject][ordered]@{ names = $shown.ToArray(); more = [Math]::Max(0, $unique.Count - $script:TvMaxTrackedSettings) }
}

function Test-TvJsonRecord {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType] -or $Value -is [array]) { return $false }
    return ($Value -is [System.Management.Automation.PSCustomObject])
}

# A logged value that holds a whole object as JSON, or $null.
function ConvertFrom-TvLoggedObject {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { return $null }
    $trimmed = $Value.Trim()
    if (-not $trimmed.StartsWith("{")) { return $null }
    $parsed = $null
    try { $parsed = ConvertFrom-Json -InputObject $trimmed -ErrorAction Stop } catch { return $null }
    if (Test-TvJsonRecord $parsed) { return $parsed }
    return $null
}

# The paths that differ between two versions of an object, dotted down to three levels.
# Lists are compared whole. Values are read straight from the properties, never through a
# function return, so a one item or empty list is never unrolled into something else.
function Add-TvDifferingPaths {
    param([object]$Before, [object]$After, [string]$Prefix, [int]$Depth, [System.Collections.Generic.List[string]]$Out)
    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($source in @($Before, $After)) {
        foreach ($prop in $source.PSObject.Properties) { if (-not $keys.Contains($prop.Name)) { $keys.Add($prop.Name) } }
    }
    $keys.Sort([StringComparer]::Ordinal)
    foreach ($key in $keys) {
        if ($script:TvSettingNoise -contains $key.ToLowerInvariant() -or $key.StartsWith("@odata")) { continue }
        $a = $null
        $b = $null
        $propA = $Before.PSObject.Properties[$key]
        $propB = $After.PSObject.Properties[$key]
        if ($propA) { $a = $propA.Value }
        if ($propB) { $b = $propB.Value }
        if ((ConvertTo-TenuVaultCanonicalJson $a) -ceq (ConvertTo-TenuVaultCanonicalJson $b)) { continue }
        $path = $key
        if ($Prefix) { $path = $Prefix + "." + $key }
        $recordA = Test-TvJsonRecord $a
        $recordB = Test-TvJsonRecord $b
        $countBefore = $Out.Count
        if ($Depth -lt 3 -and ($recordA -or $recordB)) {
            $childA = $a
            $childB = $b
            if (-not $recordA) { $childA = [pscustomobject]@{} }
            if (-not $recordB) { $childB = [pscustomobject]@{} }
            Add-TvDifferingPaths -Before $childA -After $childB -Prefix $path -Depth ($Depth + 1) -Out $Out
        }
        # A leaf, or an object that only changed between null and empty: the path itself changed.
        if ($Out.Count -eq $countBefore) {
            if ($path.Length -gt 120) { $path = $path.Substring(0, 120) }
            $Out.Add($path)
        }
    }
}

# Mirrors intuneChangedSettings: a property counts only when both its old and its new value
# were recorded and they differ. Settings catalog updates record no old values at all.
function Get-TvIntuneChangedSettings {
    param([AllowNull()][object]$Resource)
    $names = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $Resource) {
        foreach ($property in @(Get-TvProp $Resource "modifiedProperties")) {
            if ($null -eq $property) { continue }
            $display = Get-TvProp $property "displayName"
            if ($display -isnot [string]) { continue }
            $old = Get-TvLoggedValue (Get-TvProp $property "oldValue")
            $new = Get-TvLoggedValue (Get-TvProp $property "newValue")
            if ($null -eq $old -or $null -eq $new) { continue }
            if ((Get-TvNormalizedSettingValue $old) -ceq (Get-TvNormalizedSettingValue $new)) { continue }
            $name = Get-TvSettingName $display
            if ($name) { $names.Add($name) }
        }
    }
    return Get-TvBoundedSettings -Names $names
}

# Mirrors entraChangedSettings: a property holding the whole object as JSON (the policy) is
# compared field by field; any other property counts by its own name.
function Get-TvEntraChangedSettings {
    param([AllowEmptyCollection()][object[]]$Targets)
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($target in @($Targets)) {
        if ($null -eq $target) { continue }
        foreach ($property in @(Get-TvProp $target "modifiedProperties")) {
            if ($null -eq $property) { continue }
            $display = Get-TvProp $property "displayName"
            if ($display -isnot [string]) { continue }
            $old = Get-TvLoggedValue (Get-TvProp $property "oldValue")
            $new = Get-TvLoggedValue (Get-TvProp $property "newValue")
            if ($null -eq $old -or $null -eq $new) { continue }
            $before = ConvertFrom-TvLoggedObject $old
            $after = ConvertFrom-TvLoggedObject $new
            if ($null -ne $before -and $null -ne $after) {
                Add-TvDifferingPaths -Before $before -After $after -Prefix "" -Depth 1 -Out $names
                continue
            }
            if ((Get-TvNormalizedSettingValue $old) -ceq (Get-TvNormalizedSettingValue $new)) { continue }
            $name = Get-TvSettingName $display
            if ($name) { $names.Add($name) }
        }
    }
    return Get-TvBoundedSettings -Names $names
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
        if (-not $activity) { $activity = Get-TvText (Get-TvProp $Raw "activityType") }
        if (-not $activity) { $activity = Get-TvText (Get-TvProp $Raw "displayName") }
        $activityTypeText = Get-TvText (Get-TvProp $Raw "activityType")
        $activityText = Get-TvText (Get-TvProp $Raw "activity")
        $displayText = Get-TvText (Get-TvProp $Raw "displayName")
        $activityLower = (@($activityTypeText, $activityText, $displayText) -join " ").ToLowerInvariant()

        # Object entries of the resources collection. Modified property values are only
        # compared for updates, by Get-TvIntuneChangedSettings, and never kept.
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
        $resourceId = $null
        if ($resource) {
            $resourceIdText = Get-TvText (Get-TvProp $resource "resourceId")
            if ($resourceIdText) { $resourceId = if ($resourceIdText.Length -gt 200) { $resourceIdText.Substring(0, 200) } else { $resourceIdText } }
        }
        # Names of the settings an update changed; the values stay inside the function.
        $changedNames = @()
        $changedMore = 0
        if ($changeType -eq "updated") {
            $changed = Get-TvIntuneChangedSettings $resource
            $changedNames = $changed.names
            $changedMore = [int]$changed.more
        }

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
            resourceId   = $resourceId
            settings     = $changedNames
            settingsMore = $changedMore
        }
    }
}

# Mirrors mapEntraAuditEvent in entra.ts. Graph returns target resources with their
# modified property values (the full policy JSON) and the actor's IP address even
# under $select. The IP address is never read; the policy JSON is only compared for
# updates, by Get-TvEntraChangedSettings, to name the changed settings, and never kept.
function ConvertFrom-TenuVaultEntraAuditEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [Alias("Event", "InputObject")]
        [AllowNull()][object]$Raw
    )
    process {
        if ($null -eq $Raw) { return }
        $id = Get-TvText (Get-TvProp $Raw "id")
        $at = ConvertTo-TvIso (Get-TvProp $Raw "activityDateTime")
        if (-not $id -or -not $at) { return }
        $resultText = Get-TvText (Get-TvProp $Raw "result")
        if (-not $resultText -or $resultText.ToLowerInvariant() -ne "success") { return }
        $activity = Get-TvText (Get-TvProp $Raw "activityDisplayName")
        if (-not $activity) { $activity = "Change" }
        $activityLower = $activity.ToLowerInvariant()
        $service = Get-TvText (Get-TvProp $Raw "loggedByService")
        if ($service -cne "Conditional Access" -and -not $activityLower.StartsWith("authentication strength")) { return }

        $resourceType = "Conditional Access"
        if ($activityLower.Contains("named location")) { $resourceType = "Named location" }
        elseif ($activityLower.StartsWith("authentication strength")) { $resourceType = "Authentication strength" }
        elseif ($activityLower.Contains("conditional access policy")) { $resourceType = "Conditional Access policy" }

        $operationText = Get-TvText (Get-TvProp $Raw "operationType")
        $operationLower = if ($operationText) { $operationText.ToLowerInvariant() } else { "" }
        $changeType = "changed"
        if ($activityLower.StartsWith("authentication strength combination configuration")) { $changeType = "updated" }
        elseif ($operationLower -eq "add" -or $operationLower -eq "create") { $changeType = "created" }
        elseif ($operationLower -eq "delete") { $changeType = "deleted" }
        elseif ($operationLower -eq "update") { $changeType = "updated" }
        elseif ($activityLower.StartsWith("add ") -or $activityLower.EndsWith(" create")) { $changeType = "created" }
        elseif ($activityLower.StartsWith("delete ") -or $activityLower.EndsWith(" delete")) { $changeType = "deleted" }
        elseif ($activityLower.StartsWith("update ") -or $activityLower.EndsWith(" update")) { $changeType = "updated" }

        # Authentication strength events only carry a generic name; the strength's own
        # name sits in the modified property values, which are never read.
        $resourceName = $null
        if ($resourceType -ne "Authentication strength") {
            foreach ($target in @(Get-TvProp $Raw "targetResources")) {
                if ($null -eq $target) { continue }
                $name = Get-TvText (Get-TvProp $target "displayName")
                if ($name) { $resourceName = if ($name.Length -gt 200) { $name.Substring(0, 200) } else { $name }; break }
            }
        }
        $initiatedBy = Get-TvProp $Raw "initiatedBy"
        $user = Get-TvProp $initiatedBy "user"
        $app = Get-TvProp $initiatedBy "app"
        $targetList = [System.Collections.Generic.List[object]]::new()
        foreach ($target in @(Get-TvProp $Raw "targetResources")) {
            if ($target -is [PSCustomObject] -or $target -is [System.Collections.IDictionary]) { $targetList.Add($target) }
        }
        # Authentication strength events target the strength or one of its combinations, so no
        # id names the strength: like its name, it is left out.
        $resourceId = $null
        foreach ($target in @(if ($resourceType -ne "Authentication strength") { $targetList })) {
            $targetId = Get-TvText (Get-TvProp $target "id")
            if ($targetId) { $resourceId = if ($targetId.Length -gt 200) { $targetId.Substring(0, 200) } else { $targetId }; break }
        }
        $changedNames = @()
        $changedMore = 0
        if ($changeType -eq "updated") {
            $changed = Get-TvEntraChangedSettings -Targets @($targetList.ToArray())
            $changedNames = $changed.names
            $changedMore = [int]$changed.more
        }
        return [pscustomobject][ordered]@{
            auditId      = $id
            at           = $at
            category     = "ConditionalAccess"
            changeType   = $changeType
            resourceName = $resourceName
            resourceType = $resourceType
            actorUpn     = Get-TvText (Get-TvProp $user "userPrincipalName")
            actorAppId   = Get-TvText (Get-TvProp $app "appId")
            actorAppName = Get-TvText (Get-TvProp $app "displayName")
            activity     = $activity
            resourceId   = $resourceId
            settings     = $changedNames
            settingsMore = $changedMore
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
        [object]$GapNotice,
        [ValidateSet("intune", "conditionalAccess")][string]$Service = "intune"
    )
    # Same wording as SERVICE_DIGEST in audit.ts.
    $digestType = if ($Service -eq "conditionalAccess") { "entra.change" } else { "intune.change" }
    $digestTitle = if ($Service -eq "conditionalAccess") { "Conditional Access changes" } else { "Intune changes" }
    $digestLabel = if ($Service -eq "conditionalAccess") { "Conditional Access" } else { "Intune" }
    # Accept mapped changes, and raw Graph audit events for convenience.
    $mapped = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Changes) {
        if ($null -eq $entry) { continue }
        if (Get-TvProp $entry "auditId") { $mapped.Add($entry) }
        else {
            $change = if ($Service -eq "conditionalAccess") { ConvertFrom-TenuVaultEntraAuditEvent $entry } else { ConvertFrom-TenuVaultAuditEvent $entry }
            if ($change) { $mapped.Add($change) }
        }
    }

    # Collapse repeated changes to the same resource by the same actor, in order of
    # first appearance, exactly like collapseAuditChanges in audit.ts.
    $groups = [System.Collections.Specialized.OrderedDictionary]::new()
    $counts = @{}
    $members = @{}
    foreach ($change in $mapped) {
        # The object id first: two policies that share a name stay two lines.
        $targetKey = Get-TvProp $change "resourceId"
        if (-not $targetKey) { $targetKey = Get-TvProp $change "resourceName" }
        if (-not $targetKey) { $targetKey = Get-TvProp $change "resourceType" }
        if (-not $targetKey) { $targetKey = Get-TvProp $change "auditId" }
        $actorKey = Get-TvProp $change "actorUpn"
        if (-not $actorKey) { $actorKey = Get-TvProp $change "actorAppName" }
        if (-not $actorKey) { $actorKey = Get-TvProp $change "actorAppId" }
        if ($null -eq $actorKey) { $actorKey = "" }
        $key = (@([string](Get-TvProp $change "changeType"), [string]$targetKey, [string]$actorKey) -join "|").ToLowerInvariant()
        if ($groups.Contains($key)) { $counts[$key] = $counts[$key] + 1; $members[$key].Add($change) }
        else {
            $groups.Add($key, $change); $counts[$key] = 1
            $members[$key] = [System.Collections.Generic.List[object]]::new()
            $members[$key].Add($change)
        }
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
        $item["change"] = New-TvItemChange -Changes @($members[$key].ToArray())
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
    $summary = "$changeCount $(if ($changeCount -eq 1) { 'change' } else { 'changes' }) in $digestLabel ($countsText)"
    if ($collapsed -lt $changeCount) { $summary += ", shown as $collapsed lines" }
    $summary += "."
    if ($GapNotice) { $summary += " $GapNotice" }

    return New-TvEnvelope -Type $digestType `
        -Severity $(if (@($mapped | Where-Object { (Get-TvProp $_ "changeType") -eq "deleted" -or (Get-TvProp $_ "changeType") -eq "unassigned" }).Count -gt 0) { "warning" } else { "info" }) `
        -TenantId $TenantId -TenantName $TenantName -OccurredAt $newest `
        -NaturalKey ($sortedIds -join ",") `
        -Title "$($digestTitle): $tenantLabel" -Summary $summary `
        -Details @([pscustomobject][ordered]@{ label = "Changes"; value = [string]$changeCount }) `
        -Items @($items.ToArray()) -MoreCount $moreCount -Source "azure-watcher"
}

# ---------------------------------------------------------------------------
# Library: change lines, single change alerts and alert planning
# (mirror itemChange and changeEvent in audit.ts and planChangeAlerts in alerts.ts)
# ---------------------------------------------------------------------------

# The structured fields of a change line; settings of collapsed changes are merged in order.
function New-TvItemChange {
    param([Parameter(Mandatory)][object[]]$Changes)
    $first = $Changes[0]
    $settings = [System.Collections.Generic.List[string]]::new()
    $more = 0
    foreach ($change in $Changes) {
        foreach ($name in @($change.settings)) {
            if ($null -eq $name) { continue }
            $known = $false
            foreach ($existing in $settings) { if ($existing.ToLowerInvariant() -ceq ([string]$name).ToLowerInvariant()) { $known = $true; break } }
            if (-not $known) { $settings.Add([string]$name) }
        }
        $changeMore = 0
        [void][int]::TryParse("$($change.settingsMore)", [ref]$changeMore)
        if ($changeMore -gt $more) { $more = $changeMore }
    }
    $entry = [ordered]@{
        auditId = [string]$first.auditId
        changeType = [string]$first.changeType
        category = [string]$first.category
    }
    foreach ($field in @("resourceId", "resourceName", "resourceType")) {
        $value = Get-TvProp $first $field
        if ($value) { $entry[$field] = [string]$value }
    }
    if ($Changes.Count -gt 1) { $entry["count"] = $Changes.Count }
    $overflow = [Math]::Max(0, $settings.Count - $script:TvMaxSettingNames)
    if ($settings.Count -gt 0) {
        $shown = [System.Collections.Generic.List[string]]::new()
        foreach ($name in $settings) { if ($shown.Count -lt $script:TvMaxSettingNames) { $shown.Add($name) } }
        $entry["settings"] = $shown.ToArray()
    }
    if ($more + $overflow -gt 0) { $entry["settingsMore"] = $more + $overflow }
    return [pscustomobject]$entry
}

# Mirrors cleanChange in envelope.ts: bounded, cleaned fields; names only, never a value.
function ConvertTo-TvCleanItemChange {
    param([Parameter(Mandatory)][object]$Change)
    $rawSettings = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @(Get-TvProp $Change "settings")) { if ($null -ne $name) { $rawSettings.Add([string]$name) } }
    $settings = [System.Collections.Generic.List[string]]::new()
    $index = 0
    foreach ($name in $rawSettings) {
        if ($index -ge 15) { break }
        $index++
        $cleaned = Get-TvClean $name 120
        if ($cleaned) { $settings.Add($cleaned) }
    }
    $moreValue = 0
    [void][int]::TryParse("$(Get-TvProp $Change 'settingsMore')", [ref]$moreValue)
    $more = [Math]::Max(0, $moreValue) + [Math]::Max(0, $rawSettings.Count - 15)
    $entry = [ordered]@{
        auditId = Get-TvClean (Get-TvProp $Change "auditId") 200
        changeType = Get-TvClean (Get-TvProp $Change "changeType") 40
        category = Get-TvClean (Get-TvProp $Change "category") 120
    }
    foreach ($field in @("resourceId", "resourceName", "resourceType")) {
        $value = Get-TvProp $Change $field
        if ($value) { $entry[$field] = Get-TvClean $value 200 }
    }
    $count = 0
    [void][int]::TryParse("$(Get-TvProp $Change 'count')", [ref]$count)
    if ($count -gt 1) { $entry["count"] = $count }
    if ($settings.Count -gt 0) { $entry["settings"] = $settings.ToArray() }
    if ($more -gt 0) { $entry["settingsMore"] = $more }
    return [pscustomobject]$entry
}

# "A, B and 3 more", as settingsSentence in audit.ts.
function Get-TvSettingsSentence {
    param([AllowEmptyCollection()][string[]]$Names, [int]$More)
    if (-not $Names -or $Names.Count -eq 0) { return "" }
    $shown = $Names -join ", "
    if ($More -gt 0) { return "$shown and $More more" }
    return $shown
}

# Mirrors changeEvent in audit.ts: one alert for one audited change, keyed by its audit id.
function New-TenuVaultChangeEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][object]$Change,
        [bool]$IncludeActor = $false,
        [ValidateSet("intune", "conditionalAccess")][string]$Service = "intune"
    )
    $digestType = if ($Service -eq "conditionalAccess") { "entra.change" } else { "intune.change" }
    $label = if ($Service -eq "conditionalAccess") { "Conditional Access" } else { "Intune" }
    $changeType = [string]$Change.changeType
    $resourceName = Get-TvProp $Change "resourceName"
    $resourceType = Get-TvProp $Change "resourceType"
    $target = $resourceName
    if (-not $target) { $target = $resourceType }
    if (-not $target) { $target = [string]$Change.category }
    $tenantLabel = if ($TenantName) { [string]$TenantName } else { "your tenant" }
    $actor = $null
    if ($IncludeActor) {
        $actor = Get-TvProp $Change "actorUpn"
        if (-not $actor) { $actor = Get-TvProp $Change "actorAppName" }
    }
    $settings = [System.Collections.Generic.List[string]]::new()
    $allCount = 0
    foreach ($name in @($Change.settings)) {
        if ($null -eq $name) { continue }
        $allCount++
        if ($settings.Count -lt $script:TvMaxSettingNames) { $settings.Add([string]$name) }
    }
    $more = 0
    [void][int]::TryParse("$($Change.settingsMore)", [ref]$more)
    $more += [Math]::Max(0, $allCount - $script:TvMaxSettingNames)
    $sentence = Get-TvSettingsSentence -Names $settings.ToArray() -More $more
    $kind = ""
    if ($resourceName -and $resourceType) { $kind = " ($resourceType)" }
    $details = [System.Collections.Generic.List[object]]::new()
    $details.Add([pscustomobject][ordered]@{ label = "Change"; value = Get-TvCapitalized $changeType })
    if ($resourceType) { $details.Add([pscustomobject][ordered]@{ label = "Type"; value = [string]$resourceType }) }
    if ($Service -eq "intune") { $details.Add([pscustomobject][ordered]@{ label = "Category"; value = [string]$Change.category }) }
    if ($actor) { $details.Add([pscustomobject][ordered]@{ label = "By"; value = [string]$actor }) }
    $summary = "$target$kind was $changeType in $label for $tenantLabel"
    if ($actor) { $summary += " by $actor" }
    $summary += "."
    if ($settings.Count -gt 0) { $summary += " Changed settings: $sentence." }
    $item = [ordered]@{ title = "$(Get-TvCapitalized $changeType): $target" }
    $item["detail"] = if ($resourceName -and $resourceType) { [string]$resourceType } else { [string]$Change.activity }
    if ($actor) { $item["actor"] = [string]$actor }
    $item["at"] = [string]$Change.at
    $item["change"] = New-TvItemChange -Changes @($Change)
    $severity = if ($changeType -eq "deleted" -or $changeType -eq "unassigned") { "warning" } else { "info" }
    return New-TvEnvelope -Type $digestType -Severity $severity -TenantId $TenantId -TenantName $TenantName `
        -OccurredAt ([string]$Change.at) -NaturalKey "change:$([string]$Change.auditId)" `
        -Title "$label change: $target $changeType" -Summary $summary `
        -Details @($details.ToArray()) -Items @([pscustomobject]$item) -Source "azure-watcher"
}

$script:TvChangeTypes = @("created", "updated", "deleted", "assigned", "unassigned", "changed")
$script:TvEachPerCheck = 20

# Mirrors textList in alerts.ts: strings only, control characters to spaces, trimmed,
# 200 characters, case-insensitive unique, at most 50.
function Get-TvConditionTextList {
    param([object]$Raw, [Parameter(Mandatory)][string]$Name)
    $out = [System.Collections.Generic.List[string]]::new()
    $list = Get-TvStyleList $Raw $Name
    if ($null -eq $list) { return ,$out.ToArray() }
    foreach ($entry in $list) {
        if ($entry -isnot [string]) { continue }
        $cleaned = ([regex]::Replace($entry, '[\x00-\x1f\x7f]+', ' ')).Trim()
        if ($cleaned.Length -gt 200) { $cleaned = $cleaned.Substring(0, 200) }
        if (-not $cleaned) { continue }
        $known = $false
        foreach ($existing in $out) { if ($existing.ToLowerInvariant() -ceq $cleaned.ToLowerInvariant()) { $known = $true; break } }
        if (-not $known) { $out.Add($cleaned) }
        if ($out.Count -ge 50) { break }
    }
    return ,$out.ToArray()
}

# Mirrors parseConditions: $null when nothing narrows.
function ConvertTo-TvAlertConditions {
    param([AllowNull()][object]$Raw)
    if ($null -eq $Raw -or $Raw -is [string] -or $Raw -is [ValueType] -or $Raw -is [array]) { return $null }
    $typeList = Get-TvStyleList $Raw "changeTypes"
    $types = [System.Collections.Generic.List[string]]::new()
    foreach ($type in $script:TvChangeTypes) { if ($null -ne $typeList -and $typeList -ccontains $type) { $types.Add($type) } }
    $conditions = [pscustomobject][ordered]@{
        changeTypes = $types.ToArray()
        categories = Get-TvConditionTextList $Raw "categories"
        policyNames = Get-TvConditionTextList $Raw "policyNames"
        settingNames = Get-TvConditionTextList $Raw "settingNames"
        excludeActors = Get-TvConditionTextList $Raw "excludeActors"
    }
    # Exact policy names only when there are names to match, as parseConditions.
    $exact = (Get-TvProp $Raw "policyNameMatch") -ceq "exact" -and $conditions.policyNames.Count -gt 0
    $conditions | Add-Member -NotePropertyName policyNameExact -NotePropertyValue ([bool]$exact)
    $total = $conditions.changeTypes.Count + $conditions.categories.Count + $conditions.policyNames.Count + $conditions.settingNames.Count + $conditions.excludeActors.Count
    if ($total -eq 0) { return $null }
    return $conditions
}

# Mirrors equalsAny in alerts.ts: equal ignoring case and the spaces, tabs and no-break spaces
# around either name.
function Test-TvEqualsAny {
    param([AllowNull()][object]$Haystack, [string[]]$Names)
    if (-not $Haystack) { return $false }
    $lower = ([regex]::Replace([string]$Haystack, '^[ \t\u00a0]+|[ \t\u00a0]+$', '')).ToLowerInvariant()
    foreach ($name in $Names) { if (([regex]::Replace($name, '^[ \t\u00a0]+|[ \t\u00a0]+$', '')).ToLowerInvariant() -ceq $lower) { return $true } }
    return $false
}

function Test-TvContainsAny {
    param([AllowNull()][object]$Haystack, [string[]]$Needles)
    if (-not $Haystack) { return $false }
    $lower = ([string]$Haystack).ToLowerInvariant()
    foreach ($needle in $Needles) { if ($lower.Contains($needle.ToLowerInvariant())) { return $true } }
    return $false
}

# Mirrors changeMatches in alerts.ts.
function Test-TvChangeMatches {
    param([AllowNull()][object]$Conditions, [Parameter(Mandatory)][object]$Change, [string]$Service)
    if ($null -eq $Conditions) { return $true }
    if ($Conditions.changeTypes.Count -gt 0 -and -not ($Conditions.changeTypes -ccontains [string]$Change.changeType)) { return $false }
    if ($Service -eq "intune" -and $Conditions.categories.Count -gt 0) {
        $category = ([string]$Change.category).ToLowerInvariant()
        $hit = $false
        foreach ($entry in $Conditions.categories) { if ($entry.ToLowerInvariant() -ceq $category) { $hit = $true; break } }
        if (-not $hit) { return $false }
    }
    if ($Conditions.policyNames.Count -gt 0) {
        $policyName = Get-TvProp $Change "resourceName"
        $named = if ($Conditions.policyNameExact) { Test-TvEqualsAny $policyName $Conditions.policyNames } else { Test-TvContainsAny $policyName $Conditions.policyNames }
        if (-not $named) { return $false }
    }
    if ($Conditions.settingNames.Count -gt 0) {
        $hit = $false
        foreach ($name in @($Change.settings)) { if ($null -ne $name -and (Test-TvContainsAny $name $Conditions.settingNames)) { $hit = $true; break } }
        if (-not $hit) { return $false }
    }
    if ($Conditions.excludeActors.Count -gt 0) {
        $actors = @(@((Get-TvProp $Change "actorUpn"), (Get-TvProp $Change "actorAppName")) | Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() })
        foreach ($excluded in $Conditions.excludeActors) { if ($actors -ccontains $excluded.ToLowerInvariant()) { return $false } }
    }
    return $true
}

# The watcher's copy of the alerts (TenuVaultAlertRules, from setup -AlertRulesPath), or $null
# when the value is missing or unreadable: then every event goes to every destination, as a
# watcher without alerts does. Alerts without event types or destinations are dropped.
function ConvertFrom-TvWatcherAlerts {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if (-not $Text) { return $null }
    $document = $null
    try { $document = ConvertFrom-Json -InputObject $Text -ErrorAction Stop } catch { return $null }
    if ($null -eq $document -or (Get-TvProp $document "schema") -cne "tenuvault.watcher-alerts/v1") { return $null }
    $list = Get-TvStyleList $document "alerts"
    if ($null -eq $list) { return $null }
    $known = @("backup.failed", "backup.warning", "backup.succeeded", "backup.missed", "restore.completed", "restore.partial", "restore.failed", "drift.detected", "health.finding", "intune.change", "entra.change", "credential.expiring", "watcher.stale")
    $alerts = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($raw in $list) {
        $index++
        if ($null -eq $raw -or $raw -is [string] -or $raw -is [ValueType]) { continue }
        $types = [System.Collections.Generic.List[string]]::new()
        $eventTypeList = Get-TvConditionTextList $raw "eventTypes"
        foreach ($type in $eventTypeList) { if ($known -ccontains $type -and -not $types.Contains($type)) { $types.Add($type) } }
        $destinationList = Get-TvStyleList $raw "destinations"
        $destinations = [System.Collections.Generic.List[string]]::new()
        foreach ($destination in @("webhook", "teams", "mail")) { if ($null -ne $destinationList -and $destinationList -ccontains $destination) { $destinations.Add($destination) } }
        if ($types.Count -eq 0 -or $destinations.Count -eq 0) { continue }
        $id = Get-TvText (Get-TvProp $raw "id")
        if (-not $id) { $id = "alert-$index" }
        $alerts.Add([pscustomobject][ordered]@{
            id = $id
            title = Get-TvClean (Get-TvProp $raw "title") 120
            eventTypes = $types.ToArray()
            minSeverity = Get-TvStyleChoice (Get-TvProp $raw "minSeverity") @("info", "warning", "critical") "info"
            destinations = $destinations.ToArray()
            delivery = Get-TvStyleChoice (Get-TvProp $raw "delivery") @("digest", "each") "digest"
            conditions = ConvertTo-TvAlertConditions (Get-TvProp $raw "conditions")
        })
    }
    return ,$alerts.ToArray()
}

# Whether an alert takes an event of this type and severity at all, as alertTakes.
function Test-TvAlertTakes {
    param([Parameter(Mandatory)][object]$Alert, [string]$Type, [string]$Severity)
    if (-not (@($Alert.eventTypes) -ccontains $Type)) { return $false }
    return $script:TvSeverityRank[$Severity] -ge $script:TvSeverityRank[[string]$Alert.minSeverity]
}

# The destinations of the given alerts, in the fixed order webhook, Teams, mail.
function Get-TvAlertDestinations {
    param([AllowEmptyCollection()][object[]]$Alerts, [AllowEmptyCollection()][string[]]$AlertIds)
    $wanted = [System.Collections.Generic.List[string]]::new()
    foreach ($destination in @("webhook", "teams", "mail")) {
        foreach ($alert in @($Alerts)) {
            if ($null -ne $alert -and @($AlertIds) -ccontains [string]$alert.id -and @($alert.destinations) -ccontains $destination) { $wanted.Add($destination); break }
        }
    }
    return ,$wanted.ToArray()
}

# The ids of the alerts that take an event that is not a change (backup results, missed backups).
function Get-TvAlertsTaking {
    param([AllowEmptyCollection()][object[]]$Alerts, [Parameter(Mandatory)][object]$Envelope)
    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($alert in @($Alerts)) {
        if ($null -ne $alert -and (Test-TvAlertTakes $alert ([string](Get-TvProp $Envelope "type")) ([string](Get-TvProp $Envelope "severity")))) { $ids.Add([string]$alert.id) }
    }
    return ,$ids.ToArray()
}

# Mirrors watcherAlertsHash in alerts.ts: SHA-256 of the canonical JSON of the alerts, "none"
# without alerts and "unreadable" for a value that is not JSON. The heartbeat carries it so the
# desktop can tell whether the watcher runs the alerts it has now.
function Get-TvWatcherAlertsHash {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if (-not $Text) { return "none" }
    $document = $null
    try { $document = ConvertFrom-Json -InputObject $Text -ErrorAction Stop } catch { return "unreadable" }
    $alerts = Get-TvStyleList $document "alerts"
    if ($null -eq $alerts -or $alerts.Count -eq 0) { return "none" }
    return Get-TvSha256Hex (ConvertTo-TenuVaultCanonicalJson $document)
}

# Where one envelope is owed. Without alerts: every configured destination. With alerts: the
# destinations of the alerts that planned it (change alerts) or that take its type and
# severity (everything else), limited to the destinations configured in this watcher.
function Get-TvIntendedDestinations {
    param(
        [AllowNull()][object[]]$Alerts,
        [Parameter(Mandatory)][object]$Envelope,
        [AllowNull()][string[]]$Planned,
        [AllowEmptyCollection()][string[]]$Configured
    )
    $out = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $Alerts) {
        foreach ($destination in @($Configured)) { if ($destination) { $out.Add($destination) } }
        return ,$out.ToArray()
    }
    $wanted = $Planned
    if ($null -eq $wanted) {
        $takingIds = Get-TvAlertsTaking -Alerts $Alerts -Envelope $Envelope
        $wanted = Get-TvAlertDestinations -Alerts $Alerts -AlertIds $takingIds
    }
    foreach ($destination in @($wanted)) { if ($destination -and @($Configured) -ccontains [string]$destination) { $out.Add([string]$destination) } }
    return ,$out.ToArray()
}

# Mirrors planChangeAlerts: the envelopes one poll of one service sends, and which alerts
# send each. Alerts that pick the same changes produce the same envelope (same event id).
function Get-TvChangeAlertPlan {
    param(
        [Parameter(Mandatory)][ValidateSet("intune", "conditionalAccess")][string]$Service,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Changes,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Alerts,
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [bool]$IncludeActor = $false,
        [object]$GapNotice
    )
    $type = if ($Service -eq "conditionalAccess") { "entra.change" } else { "intune.change" }
    $planned = [System.Collections.Specialized.OrderedDictionary]::new()
    foreach ($alert in @($Alerts)) {
        if ($null -eq $alert -or -not (@($alert.eventTypes) -ccontains $type)) { continue }
        $selected = [System.Collections.Generic.List[object]]::new()
        foreach ($change in @($Changes)) { if ($null -ne $change -and (Test-TvChangeMatches $alert.conditions $change $Service)) { $selected.Add($change) } }
        if ($selected.Count -eq 0) { continue }
        $envelopes = [System.Collections.Generic.List[object]]::new()
        if ($alert.delivery -eq "each") {
            $rest = [System.Collections.Generic.List[object]]::new()
            foreach ($change in $selected) {
                if ($envelopes.Count -lt $script:TvEachPerCheck) {
                    $envelopes.Add((New-TenuVaultChangeEvent -TenantId $TenantId -TenantName $TenantName -Change $change -IncludeActor $IncludeActor -Service $Service))
                } else { $rest.Add($change) }
            }
            if ($rest.Count -gt 0) {
                $envelopes.Add((New-TenuVaultAuditDigest -TenantId $TenantId -TenantName $TenantName -Changes @($rest.ToArray()) -IncludeActor $IncludeActor -GapNotice $GapNotice -Service $Service))
            }
        } else {
            $envelopes.Add((New-TenuVaultAuditDigest -TenantId $TenantId -TenantName $TenantName -Changes @($selected.ToArray()) -IncludeActor $IncludeActor -GapNotice $GapNotice -Service $Service))
        }
        foreach ($envelope in $envelopes) {
            if (-not (Test-TvAlertTakes $alert ([string]$envelope.type) ([string]$envelope.severity))) { continue }
            $eventIdValue = [string]$envelope.eventId
            if ($planned.Contains($eventIdValue)) {
                $entry = $planned[$eventIdValue]
                if (-not $entry.alertIds.Contains([string]$alert.id)) { $entry.alertIds.Add([string]$alert.id) }
            } else {
                $ids = [System.Collections.Generic.List[string]]::new()
                $ids.Add([string]$alert.id)
                $planned.Add($eventIdValue, [pscustomobject][ordered]@{ envelope = $envelope; alertIds = $ids })
            }
        }
    }
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($key in $planned.Keys) { $result.Add($planned[$key]) }
    return ,$result.ToArray()
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

# Fixed Microsoft destinations per event type, as actionLink in render.ts. Never built
# from tenant data.
function Get-TvActionLink {
    param([object]$Envelope)
    switch ([string](Get-TvProp $Envelope "type")) {
        "intune.change" { return @{ href = "https://intune.microsoft.com"; label = "Open the Intune admin center" } }
        "entra.change" { return @{ href = "https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies"; label = "Open Conditional Access in Entra" } }
    }
    return $null
}

# "Changed: A, B and 2 more" for a change line with changed settings, as itemSettingsText.
function Get-TvItemSettingsText {
    param([object]$Item)
    $change = Get-TvProp $Item "change"
    if (-not $change) { return $null }
    $names = @(@(Get-TvProp $change "settings") | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
    if ($names.Count -eq 0) { return $null }
    $more = 0
    [void][int]::TryParse("$(Get-TvProp $change 'settingsMore')", [ref]$more)
    $text = "Changed: $($names -join ', ')"
    if ($more -gt 0) { $text += " and $more more" }
    return $text
}

function Get-TvItemLine {
    param([object]$Item)
    # Bullet and middle dot as char codes: the runbook stays ASCII so Windows PowerShell 5.1
    # reads it the same with or without a byte order mark. Same text as itemLine in render.ts.
    $parts = [System.Collections.Generic.List[string]]::new()
    $parts.Add("$([char]0x2022) $(Get-TvProp $Item 'title')")
    if (Get-TvProp $Item "detail") { $parts.Add([string](Get-TvProp $Item "detail")) }
    if (Get-TvProp $Item "actor") { $parts.Add("by $(Get-TvProp $Item 'actor')") }
    if (Get-TvProp $Item "at") { $parts.Add((Get-TvFriendlyTime (Get-TvProp $Item "at"))) }
    $line = $parts -join " $([char]0x00B7) "
    $settingsText = Get-TvItemSettingsText $Item
    if ($settingsText) { $line += "`n  $settingsText" }
    return $line
}

function Get-TvFooter {
    param([object]$Envelope)
    $dot = [char]0x00B7
    return "Azure watcher $dot $(Get-TvFriendlyTime (Get-TvProp $Envelope 'occurredAt')) $dot Event $(([string](Get-TvProp $Envelope 'eventId')).Substring(0, 12))"
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
    # Built from its code point so this script stays pure ASCII: Windows
    # PowerShell 5.1 parses BOM-less files with the host ANSI codepage and
    # would misdecode a literal middle dot in the Automation sandbox.
    $dot = [char]0x00B7
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
        $meta = if ($metaParts.Count -gt 0) { "<div style=`"font-size:12px;line-height:18px;color:#475467;margin-top:2px`">$(Get-TvHtmlEscape ($metaParts -join " $dot "))</div>" } else { "" }
        $settingsText = Get-TvItemSettingsText $item
        if ($settingsText) { $meta += "<div style=`"font-size:12px;line-height:18px;color:#344054;margin-top:2px`">$(Get-TvHtmlEscape $settingsText)</div>" }
        $itemRows += "<tr><td style=`"padding:10px 16px;border-top:1px solid #eaecf0`"><div style=`"font-size:14px;line-height:20px`">$chip<span style=`"font-weight:600`">$(Get-TvHtmlEscape $title)</span></div>$meta</td></tr>"
    }

    $moreRow = ""
    if ([int](Get-TvProp $Envelope "moreCount") -gt 0) {
        $moreRow = "<tr><td style=`"padding:8px 24px 0;font-size:13px;color:#475467`">And $(Get-TvProp $Envelope 'moreCount') more. Open TenuVault for the full list.</td></tr>"
    }
    $actionRow = ""
    $action = Get-TvActionLink $Envelope
    if ($action) {
        $actionRow = "<tr><td style=`"padding:18px 24px 4px`"><a href=`"$($action.href)`" style=`"display:inline-block;padding:9px 16px;border-radius:6px;background:#175cd3;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none`">$($action.label)</a></td></tr>"
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
        "<tr><td style=`"padding:18px 24px 20px`"><div style=`"border-top:1px solid #eaecf0;padding-top:12px;font-size:12px;line-height:18px;color:#98a2b3`">Azure watcher $dot $(Get-TvHtmlEscape (Get-TvFriendlyTime (Get-TvProp $Envelope 'occurredAt'))) $dot Event $(Get-TvHtmlEscape $eventShort)</div></td></tr>"
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

# ---------------------------------------------------------------------------
# Library: cloud backup outcomes (mirror src/shared/notifications/cloud-outcome.ts)
# ---------------------------------------------------------------------------
# The watcher never opens backups or their status: backups from cloud backup runbooks
# before 1.2.0 are sealed with the recovery key, which the watcher never has, and policy
# content stays out of its reach. The cloud backup runbook therefore leaves one small note per run in the
# container tenuvault-backup-results (its own, so the backup identity can never touch this
# watcher's state): status, folder name, counts, failed type names and time,
# never policy content, names or messages. The watcher turns it into a backup alert.

$script:TvOutcomeSchema = "tenuvault.cloud-backup-outcome/v1"
$script:TvOutcomePrefix = "cloud-backup-outcomes/"
$script:TvOutcomeSummary = @{
    Success = "The cloud backup in Azure completed successfully."
    CompletedWithWarnings = "The cloud backup in Azure saved policies, but some could not be read. Open TenuVault for the details."
    Failed = "The cloud backup in Azure failed, so this backup is incomplete. Open the runbook job in the Automation account for the reason."
}

# Mirrors backupEvent in envelope.ts.
function New-TenuVaultBackupEvent {
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][ValidateSet("Success", "CompletedWithWarnings", "Failed")][string]$Status,
        [AllowNull()][string]$BackupFolder,
        [AllowNull()][string]$NaturalKey,
        [Parameter(Mandatory)][string]$OccurredAt,
        [AllowNull()][object]$TotalPolicies,
        [int]$Failures = 0,
        [string[]]$FailedTypes = @(),
        [AllowNull()][string]$Trigger,
        [AllowNull()][string]$Message,
        [string]$Source = "azure-watcher"
    )
    $type = switch ($Status) { "Failed" { "backup.failed" } "CompletedWithWarnings" { "backup.warning" } default { "backup.succeeded" } }
    $details = [System.Collections.Generic.List[object]]::new()
    if ($BackupFolder) { $details.Add([pscustomobject][ordered]@{ label = "Backup"; value = $BackupFolder }) }
    $details.Add([pscustomobject][ordered]@{ label = "Result"; value = $Status })
    if ($null -ne $TotalPolicies) { $details.Add([pscustomobject][ordered]@{ label = "Policies saved"; value = [string]$TotalPolicies }) }
    if ($Failures) { $details.Add([pscustomobject][ordered]@{ label = "Item failures"; value = [string]$Failures }) }
    $types = @($FailedTypes | Where-Object { $_ } | Select-Object -First 10)
    if ($types.Count -gt 0) { $details.Add([pscustomobject][ordered]@{ label = "Failed types"; value = ($types -join ", ") }) }
    if ($Trigger) { $details.Add([pscustomobject][ordered]@{ label = "Trigger"; value = $Trigger }) }
    $tenantLabel = if ($null -ne $TenantName) { [string]$TenantName } else { "your tenant" }
    $title = switch ($type) { "backup.failed" { "Backup failed: $tenantLabel" } "backup.warning" { "Backup completed with warnings: $tenantLabel" } default { "Backup succeeded: $tenantLabel" } }
    $summary = if ($Message) { $Message } elseif ($type -eq "backup.succeeded") { "The backup completed successfully." } else { "Open TenuVault to see what could not be saved." }
    $key = if ($NaturalKey) { $NaturalKey } elseif ($BackupFolder) { $BackupFolder } else { "$(if ($Trigger) { $Trigger } else { 'backup' }):$OccurredAt" }
    return New-TvEnvelope -Type $type `
        -Severity $(if ($type -eq "backup.failed") { "critical" } elseif ($type -eq "backup.warning") { "warning" } else { "info" }) `
        -TenantId $TenantId -TenantName $TenantName -OccurredAt $OccurredAt -NaturalKey $key `
        -Title $title -Summary $summary -Details @($details.ToArray()) -Items @() -Source $Source
}

# One field of a note, read directly so a one item list is never unrolled into a scalar
# (parseCloudOutcome rejects lists where it expects a string). Present tells a missing
# field from a null one.
function Get-TvNoteField {
    param([object]$Note, [Parameter(Mandatory)][string]$Name)
    if ($Note -is [System.Collections.IDictionary]) {
        if ($Note.Contains($Name)) { return [pscustomobject]@{ Present = $true; Value = $Note[$Name] } }
    } elseif ($null -ne $Note -and $Note.PSObject.Properties[$Name]) {
        return [pscustomobject]@{ Present = $true; Value = $Note.PSObject.Properties[$Name].Value }
    }
    return [pscustomobject]@{ Present = $false; Value = $null }
}

# A count as parseCloudOutcome reads it: any integral JSON number from 0 to 1,000,000.
function Get-TvNoteCount {
    param([object]$Value)
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        $number = [double]$Value
        if ($number -ge 0 -and $number -le 1000000 -and [Math]::Floor($number) -eq $number) { return [int]$number }
    }
    return $null
}

# Parses a note the way JSON.parse does, with every string kept as written: ConvertFrom-Json
# in PowerShell 7.2 to 7.4 turns times into DateTime values and rolls T24:00 over to the next
# day. System.Text.Json (PowerShell 7) also keeps keys case sensitive and a repeated key keeps
# its last value. The watcher runs on the Windows PowerShell 5.1 runtime, which has no
# System.Text.Json; there ConvertFrom-TvJson is used, whose ConvertFrom-Json keeps ISO times
# as strings, as it does with -DateKind String on PowerShell 7.5 and later.
$script:TvNoteJsonParser = if ("System.Text.Json.JsonDocument" -as [type]) { "SystemTextJson" } else { "ConvertFromJson" }

function ConvertFrom-TvNoteJsonElement {
    param([Parameter(Mandatory)][System.Text.Json.JsonElement]$Element)
    switch ($Element.ValueKind) {
        ([System.Text.Json.JsonValueKind]::Object) {
            $object = [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
            foreach ($property in $Element.EnumerateObject()) {
                $object[$property.Name] = ConvertFrom-TvNoteJsonElement $property.Value
            }
            return $object
        }
        ([System.Text.Json.JsonValueKind]::Array) {
            $items = [System.Collections.Generic.List[object]]::new()
            foreach ($item in $Element.EnumerateArray()) { $items.Add((ConvertFrom-TvNoteJsonElement $item)) }
            return , $items.ToArray()
        }
        ([System.Text.Json.JsonValueKind]::String) { return $Element.GetString() }
        ([System.Text.Json.JsonValueKind]::Number) {
            $long = [Int64]0
            if ($Element.TryGetInt64([ref]$long)) { return $long }
            return $Element.GetDouble()
        }
        ([System.Text.Json.JsonValueKind]::True) { return $true }
        ([System.Text.Json.JsonValueKind]::False) { return $false }
        default { return $null }
    }
}

function ConvertFrom-TvNoteJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ($script:TvNoteJsonParser -ne "SystemTextJson") { return ConvertFrom-TvJson $Text }
    $document = [System.Text.Json.JsonDocument]::Parse($Text)
    try { return ConvertFrom-TvNoteJsonElement $document.RootElement } finally { $document.Dispose() }
}

# Mirrors parseCloudOutcome: $null for anything that is not a usable note of this tenant.
# Patterns use [0-9] and \z: .NET \d accepts any Unicode digit and $ also matches before a
# trailing newline, which the JavaScript patterns do not.
function ConvertFrom-TenuVaultBackupOutcome {
    param([AllowNull()][object]$Note, [Parameter(Mandatory)][string]$TenantId)
    if ($null -eq $Note -or $Note -is [string] -or $Note -is [array] -or $Note -is [ValueType]) { return $null }
    $schema = (Get-TvNoteField $Note "schema").Value
    if ($schema -isnot [string] -or $schema -cne $script:TvOutcomeSchema) { return $null }
    $noteTenant = (Get-TvNoteField $Note "tenantId").Value
    if ($noteTenant -isnot [string] -or $noteTenant.ToLowerInvariant() -ne $TenantId.ToLowerInvariant()) { return $null }
    $status = (Get-TvNoteField $Note "status").Value
    if ($status -isnot [string] -or @("Success", "CompletedWithWarnings", "Failed") -cnotcontains $status) { return $null }
    $runId = (Get-TvNoteField $Note "runId").Value
    if ($runId -isnot [string] -or $runId -cnotmatch '^[A-Za-z0-9-]{1,100}\z') { return $null }
    $folderField = Get-TvNoteField $Note "backupFolder"
    if (-not $folderField.Present) { return $null }
    $folder = $folderField.Value
    if ($null -ne $folder -and ($folder -isnot [string] -or $folder -cnotmatch '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\z')) { return $null }
    # A real calendar time with an explicit zone, as text (ConvertFrom-TvNoteJson keeps it so).
    # The exact parse rejects 2026-02-30, T24:00 and offsets past 14 hours, like isZonedTime.
    $finishedRaw = (Get-TvNoteField $Note "finishedAt").Value
    if ($finishedRaw -isnot [string] -or $finishedRaw -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})\z') { return $null }
    $finishedAt = [DateTimeOffset]::MinValue
    $formats = [string[]]@("yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFK")
    if (-not [DateTimeOffset]::TryParseExact($finishedRaw, $formats, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$finishedAt)) { return $null }
    $finished = $finishedAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    $failures = Get-TvNoteCount (Get-TvNoteField $Note "failures").Value
    $typeList = (Get-TvNoteField $Note "failedTypes").Value
    $failedTypes = @(@(if ($typeList -is [array]) { $typeList }) | Where-Object { $_ -is [string] -and $_ -cmatch '^[A-Za-z]{1,64}\z' } | Select-Object -First 10)
    return [pscustomobject][ordered]@{
        status = [string]$status
        runId = [string]$runId
        backupFolder = $folder
        finishedAt = $finished
        totalPolicies = Get-TvNoteCount (Get-TvNoteField $Note "totalPolicies").Value
        failures = if ($null -ne $failures) { $failures } else { 0 }
        failedTypes = $failedTypes
    }
}

# Reads the result notes the cloud backup runbook left under cloud-backup-outcomes/ in the
# results container and turns the valid ones into backup alerts. Returns the alerts, the
# folders reported as Failed, the blob names to delete once the alerts are saved, how many
# notes were ignored (invalid, oversized) or expired, and an error message when the
# container could not be read. Every note it looked at is deleted after the save, valid or
# not, so nothing is read again forever. Notes older than MaxAgeDays are deleted without an
# alert: a watcher set up long after the first cloud backups must not send weeks of history.
# Notes above 4 KB are not downloaded at all; a real note is a few hundred bytes.
function Read-TvBackupOutcomes {
    param(
        [Parameter(Mandatory)][string]$ContainerUri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [Parameter(Mandatory)][scriptblock]$RenewLease,
        [DateTime]$Now = [DateTime]::UtcNow,
        [int]$MaxAgeDays = 7
    )
    $oldest = ConvertTo-TvIso ($Now.ToUniversalTime().AddDays(-$MaxAgeDays))
    $expired = 0
    $envelopes = [System.Collections.Generic.List[object]]::new()
    $failedFolders = [System.Collections.Generic.List[string]]::new()
    $processed = [System.Collections.Generic.List[string]]::new()
    $ignored = 0
    $readError = $null
    $marker = $null
    do {
        & $RenewLease
        try {
            $listUri = "$ContainerUri`?restype=container&comp=list&prefix=$([uri]::EscapeDataString($script:TvOutcomePrefix))&maxresults=500"
            if ($marker) { $listUri += "&marker=$([uri]::EscapeDataString($marker))" }
            $listText = [string](Invoke-TvStorageRequest -Uri $listUri -Method Get -Token $Token).Content
            $xmlStart = $listText.IndexOf("<")
            if ($xmlStart -gt 0) { $listText = $listText.Substring($xmlStart) }
            [xml]$listXml = $listText
            $blobsNode = $listXml.EnumerationResults.Blobs
            foreach ($blob in @(if ($blobsNode) { $blobsNode.Blob })) {
                if (-not $blob -or -not $blob.Name) { continue }
                $blobName = [string]$blob.Name
                if (-not $blobName.StartsWith($script:TvOutcomePrefix, [StringComparison]::Ordinal)) { continue }
                # The lease is renewed per note: hundreds of slow reads must not outlast it.
                & $RenewLease
                $length = 0L
                $lengthText = [string]$blob.Properties.'Content-Length'
                if ($lengthText -and [long]::TryParse($lengthText, [ref]$length) -and $length -gt 4096) {
                    $ignored++
                    $processed.Add($blobName)
                    continue
                }
                $encodedName = ($blobName -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
                $noteText = Get-TvBlobText -Uri "$ContainerUri/$encodedName" -Token $Token
                if ($null -eq $noteText) { continue }
                $note = $null
                try { $note = ConvertFrom-TvNoteJson $noteText } catch { $note = $null }
                $outcome = ConvertFrom-TenuVaultBackupOutcome $note $TenantId
                if ($null -eq $outcome) { $ignored++; $processed.Add($blobName); continue }
                if ([StringComparer]::Ordinal.Compare([string]$outcome.finishedAt, $oldest) -lt 0) {
                    # Too old to be news; the folder still counts as failed for the missed check.
                    $expired++
                    if ($outcome.status -eq "Failed" -and $outcome.backupFolder -and -not $failedFolders.Contains([string]$outcome.backupFolder)) {
                        $failedFolders.Add([string]$outcome.backupFolder)
                    }
                    $processed.Add($blobName)
                    continue
                }
                $envelopes.Add((New-TenuVaultCloudOutcomeEvent -Outcome $outcome -TenantId $TenantId -TenantName $TenantName))
                if ($outcome.status -eq "Failed" -and $outcome.backupFolder -and -not $failedFolders.Contains([string]$outcome.backupFolder)) {
                    $failedFolders.Add([string]$outcome.backupFolder)
                }
                $processed.Add($blobName)
            }
            $marker = [string]$listXml.EnumerationResults.NextMarker
            if (-not $marker) { $marker = $null }
        } catch {
            $marker = $null
            $readError = "Cloud backup results could not be read in this run: $(Get-TvSafeError $_.Exception.Message)"
        }
    } while ($marker)
    return [pscustomobject]@{ Envelopes = $envelopes; FailedFolders = $failedFolders; Processed = $processed; Ignored = $ignored; Expired = $expired; Error = $readError }
}

# Mirrors cloudOutcomeEvent.
function New-TenuVaultCloudOutcomeEvent {
    param([Parameter(Mandatory)][object]$Outcome, [Parameter(Mandatory)][string]$TenantId, [object]$TenantName)
    $key = if ($Outcome.backupFolder) { [string]$Outcome.backupFolder } else { "run:$($Outcome.runId)" }
    return New-TenuVaultBackupEvent -TenantId $TenantId -TenantName $TenantName -Status $Outcome.status `
        -BackupFolder $Outcome.backupFolder -NaturalKey $key -OccurredAt $Outcome.finishedAt `
        -TotalPolicies $Outcome.totalPolicies -Failures $Outcome.failures -FailedTypes @($Outcome.failedTypes) `
        -Trigger "Cloud backup schedule" -Message $script:TvOutcomeSummary[[string]$Outcome.status]
}

# ---------------------------------------------------------------------------
# Library: Teams card layout, mirroring layout.ts and teamsWorkflowsPayload
# ---------------------------------------------------------------------------

$script:TvMovableBlocks = @("summary", "details", "items", "note", "footer")
$script:TvHideableBlocks = @("summary", "details", "items", "note", "footer", "button")
$script:TvSeverityRank = @{ info = 0; warning = 1; critical = 2 }
$script:TvEventGroups = [ordered]@{
    backups = @("backup.failed", "backup.warning", "backup.succeeded", "backup.missed")
    restores = @("restore.completed", "restore.partial", "restore.failed")
    drift = @("drift.detected")
    changes = @("intune.change", "entra.change")
    alerts = @("credential.expiring", "watcher.stale", "health.finding")
}

function Get-TvCleanStyleText {
    param([object]$Value, [int]$Max)
    if ($Value -isnot [string]) { return "" }
    $text = [regex]::Replace($Value, '[\x00-\x1f\x7f]+', ' ')
    $text = [regex]::Replace($text, '\s+', ' ').Trim()
    if ($text.Length -gt $Max) { $text = $text.Substring(0, $Max) }
    return $text
}

function Get-TvStyleChoice {
    param([object]$Value, [string[]]$Allowed, [string]$Fallback)
    if ($Value -is [string] -and $Allowed -ccontains $Value) { return $Value }
    return $Fallback
}

function Get-TvStyleFlag {
    param([object]$Value, [bool]$Fallback)
    if ($Value -is [bool]) { return $Value }
    return $Fallback
}

# A list field of a layout, or $null when it is missing or not a list. Read directly,
# because returning through Get-TvProp unrolls a one item list into a plain string,
# and a plain string must not count as a list (parseCardStyle only accepts arrays).
function Get-TvStyleList {
    param([object]$Raw, [Parameter(Mandatory)][string]$Name)
    $value = $null
    if ($Raw -is [System.Collections.IDictionary]) {
        if ($Raw.Contains($Name)) { $value = $Raw[$Name] }
    } elseif ($null -ne $Raw -and $Raw.PSObject.Properties[$Name]) {
        $value = $Raw.PSObject.Properties[$Name].Value
    }
    if ($value -is [array]) { return ,$value }
    return $null
}

# Mirrors parseCardStyle: unknown fields are dropped and invalid values fall back to
# the default, so a damaged layout never stops a delivery.
function ConvertTo-TvCardStyle {
    param([object]$Raw)
    $order = [System.Collections.Generic.List[string]]::new()
    $orderList = Get-TvStyleList $Raw "order"
    foreach ($entry in @(if ($null -ne $orderList) { $orderList })) {
        if ($entry -is [string] -and $script:TvMovableBlocks -ccontains $entry -and -not $order.Contains($entry)) { $order.Add($entry) }
    }
    foreach ($block in $script:TvMovableBlocks) { if (-not $order.Contains($block)) { $order.Add($block) } }
    # A missing or non-list value means the default (note hidden); an empty list hides nothing.
    $hiddenValue = Get-TvStyleList $Raw "hidden"
    $hiddenSet = @{}
    if ($null -eq $hiddenValue) { $hiddenSet["note"] = $true }
    else { foreach ($entry in $hiddenValue) { if ($entry -is [string]) { $hiddenSet[$entry] = $true } } }
    $hidden = @($script:TvHideableBlocks | Where-Object { $hiddenSet.ContainsKey($_) })
    $hiddenDetails = [System.Collections.Generic.List[string]]::new()
    $hiddenDetailsList = Get-TvStyleList $Raw "hiddenDetails"
    foreach ($entry in @(if ($null -ne $hiddenDetailsList) { $hiddenDetailsList })) {
        $label = Get-TvCleanStyleText $entry 80
        if ($label -and -not $hiddenDetails.Contains($label) -and $hiddenDetails.Count -lt 20) { $hiddenDetails.Add($label) }
    }
    # The text form is checked before any conversion: a cast of "many", an array or an
    # oversized number would throw and turn a damaged layout into a failed delivery.
    $maxItems = 20
    $maxRaw = Get-TvProp $Raw "maxItems"
    $maxParsed = 0
    if (($maxRaw -is [string] -or $maxRaw -is [int] -or $maxRaw -is [long] -or $maxRaw -is [double]) -and "$maxRaw" -match '^\d{1,2}$' -and [int]::TryParse("$maxRaw", [ref]$maxParsed) -and @(3, 5, 10, 20) -contains $maxParsed) { $maxItems = $maxParsed }
    return [pscustomobject][ordered]@{
        order = @($order.ToArray())
        hidden = $hidden
        severityStyle = Get-TvStyleChoice (Get-TvProp $Raw "severityStyle") @("both", "tint", "label") "both"
        accent = Get-TvStyleChoice (Get-TvProp $Raw "accent") @("severity", "accent", "emphasis", "good") "severity"
        titlePrefix = Get-TvCleanStyleText (Get-TvProp $Raw "titlePrefix") 40
        summaryText = Get-TvCleanStyleText (Get-TvProp $Raw "summaryText") 300
        hiddenDetails = @($hiddenDetails.ToArray())
        maxItems = $maxItems
        itemStyle = Get-TvStyleChoice (Get-TvProp $Raw "itemStyle") @("line", "stacked") "line"
        itemDetail = Get-TvStyleFlag (Get-TvProp $Raw "itemDetail") $true
        itemActor = Get-TvStyleFlag (Get-TvProp $Raw "itemActor") $true
        itemTime = Get-TvStyleFlag (Get-TvProp $Raw "itemTime") $true
        noteText = Get-TvCleanStyleText (Get-TvProp $Raw "noteText") 300
        noteMinSeverity = Get-TvStyleChoice (Get-TvProp $Raw "noteMinSeverity") @("info", "warning", "critical") "warning"
        buttonDestination = Get-TvStyleChoice (Get-TvProp $Raw "buttonDestination") @("auto", "intune", "entra") "auto"
        buttonLabel = Get-TvCleanStyleText (Get-TvProp $Raw "buttonLabel") 40
        footerSource = Get-TvStyleFlag (Get-TvProp $Raw "footerSource") $true
        footerTime = Get-TvStyleFlag (Get-TvProp $Raw "footerTime") $true
        footerEventId = Get-TvStyleFlag (Get-TvProp $Raw "footerEventId") $true
        density = Get-TvStyleChoice (Get-TvProp $Raw "density") @("comfortable", "compact") "comfortable"
        timeFormat = Get-TvStyleChoice (Get-TvProp $Raw "timeFormat") @("friendly", "iso") "friendly"
    }
}

# The style an event type uses: its group's override, else the base. Mirrors styleFor.
function Get-TvCardStyleFor {
    param([object]$Layout, [string]$Type)
    if ($null -eq $Layout) { return ConvertTo-TvCardStyle $null }
    foreach ($group in $script:TvEventGroups.Keys) {
        if ($script:TvEventGroups[$group] -ccontains $Type) {
            $override = Get-TvProp (Get-TvProp $Layout "overrides") $group
            if ($null -ne $override) { return ConvertTo-TvCardStyle $override }
        }
    }
    return ConvertTo-TvCardStyle (Get-TvProp $Layout "base")
}

function Get-TvSeverityLabel {
    param([string]$Severity)
    switch ($Severity) { "critical" { return "Critical" } "warning" { return "Warning" } default { return "Info" } }
}

# Mirrors fillPlaceholders: unknown names stay as written.
function Get-TvFilledText {
    param([string]$Text, [object]$Envelope, [string]$TimeFormat)
    if (-not $Text) { return "" }
    $tenant = Get-TvProp $Envelope "tenant"
    $tenantLabel = Get-TvProp $tenant "name"
    if (-not $tenantLabel) { $tenantLabel = Get-TvProp $tenant "id" }
    $values = @{
        tenant = [string]$tenantLabel
        title = [string](Get-TvProp $Envelope "title")
        severity = Get-TvSeverityLabel ([string](Get-TvProp $Envelope "severity"))
        eventType = [string](Get-TvProp $Envelope "type")
        count = [string](@(Get-TvProp $Envelope "items" | Where-Object { $null -ne $_ }).Count + [int](Get-TvProp $Envelope "moreCount"))
        occurredAt = if ($TimeFormat -eq "iso") { ConvertTo-TvIso (Get-TvProp $Envelope "occurredAt") } else { Get-TvFriendlyTime (Get-TvProp $Envelope "occurredAt") }
    }
    return [regex]::Replace($Text, '\{([A-Za-z]+)\}', {
        param($match)
        $name = $match.Groups[1].Value
        if ($values.ContainsKey($name)) { return $values[$name] }
        return $match.Value
    })
}

# Teams Workflows refuses messages over 28 KB without saying how it counts, so a card must
# fit both as UTF-8 bytes and as UTF-16, with 1 KB to spare. Same rule as render.ts.
$script:TvTeamsBudgetBytes = 27 * 1024

function Get-TvTeamsPayloadBytes {
    param([object]$Payload)
    $json = ConvertTo-TenuVaultCanonicalJson $Payload
    return [Math]::Max([Text.Encoding]::UTF8.GetByteCount($json), $json.Length * 2)
}

# Mirrors fitTeamsPayload: a card over the limit is shortened instead of refused, change
# lines first (they become "And N more"), then detail rows from the end, then the summary.
function New-TvTeamsPayload {
    param([object]$Envelope, [object]$Style)
    if ($null -eq $Style) { $Style = ConvertTo-TvCardStyle $null }
    $itemCount = @(@(Get-TvProp $Envelope "items") | Where-Object { $null -ne $_ }).Count
    $detailCount = @(@(Get-TvProp $Envelope "details") | Where-Object { $_ }).Count
    $itemLimit = [Math]::Min([int]$Style.maxItems, $itemCount)
    $detailLimit = $detailCount
    $payload = New-TvTeamsPayloadCore $Envelope $Style $itemLimit $detailLimit -1 $true
    if ((Get-TvTeamsPayloadBytes $payload) -le $script:TvTeamsBudgetBytes) { return $payload }
    while ($itemLimit -gt 0) {
        $itemLimit--
        $payload = New-TvTeamsPayloadCore $Envelope $Style $itemLimit $detailLimit -1 $true
        if ((Get-TvTeamsPayloadBytes $payload) -le $script:TvTeamsBudgetBytes) { return $payload }
    }
    while ($detailLimit -gt 0) {
        $detailLimit--
        $payload = New-TvTeamsPayloadCore $Envelope $Style $itemLimit $detailLimit -1 $true
        if ((Get-TvTeamsPayloadBytes $payload) -le $script:TvTeamsBudgetBytes) { return $payload }
    }
    $payload = New-TvTeamsPayloadCore $Envelope $Style $itemLimit $detailLimit 200 $true
    if ((Get-TvTeamsPayloadBytes $payload) -le $script:TvTeamsBudgetBytes) { return $payload }
    # A note can expand placeholders far past the limit on its own; it is the last part to go.
    return New-TvTeamsPayloadCore $Envelope $Style $itemLimit $detailLimit 200 $false
}

function New-TvTeamsPayloadCore {
    param([object]$Envelope, [object]$Style, [int]$ItemLimit, [int]$DetailLimit, [int]$SummaryMax, [bool]$IncludeNote = $true)
    $severityName = [string](Get-TvProp $Envelope "severity")
    $severity = switch ($severityName) {
        "critical" { @{ container = "attention"; color = "Attention"; label = "Critical" } }
        "warning" { @{ container = "warning"; color = "Warning"; label = "Warning" } }
        default { @{ container = "emphasis"; color = "Accent"; label = "Info" } }
    }
    $timeFormat = [string]$Style.timeFormat
    $compact = $Style.density -eq "compact"
    # ConvertFrom-Json turns ISO strings into DateTime values (envelopes reloaded from
    # state.json), so ISO output is normalized instead of cast to a locale string.
    $formatTime = { param($iso) if ($timeFormat -eq "iso") { ConvertTo-TvIso $iso } else { Get-TvFriendlyTime $iso } }

    # TextBlock has no severity style: the header sits in a Container with a named container
    # style, and a small label carries a named text color. Same shape as render.ts.
    $headerItems = [System.Collections.Generic.List[object]]::new()
    if ($Style.severityStyle -ne "tint") {
        $headerItems.Add([pscustomobject][ordered]@{ type = "TextBlock"; size = "Small"; weight = "Bolder"; color = $severity.color; text = $severity.label; wrap = $true })
    }
    # Prefixes are stored trimmed, so the space before the title is added here.
    $titlePrefix = Get-TvFilledText $Style.titlePrefix $Envelope $timeFormat
    $titleText = if ($titlePrefix) { "$titlePrefix $([string](Get-TvProp $Envelope 'title'))" } else { [string](Get-TvProp $Envelope "title") }
    $headerItems.Add([pscustomobject][ordered]@{ type = "TextBlock"; size = "Medium"; weight = "Bolder"; text = Get-TvMarkdownEscape $titleText; wrap = $true; spacing = "None" })
    $containerStyle = if ($Style.accent -ne "severity") { [string]$Style.accent } elseif ($Style.severityStyle -eq "label") { "default" } else { $severity.container }
    $body = [System.Collections.Generic.List[object]]::new()
    $body.Add([pscustomobject][ordered]@{ type = "Container"; style = $containerStyle; bleed = $true; items = @($headerItems.ToArray()) })

    foreach ($block in @($Style.order)) {
        if (@($Style.hidden) -ccontains $block) { continue }
        switch ($block) {
            "summary" {
                $summaryText = if ($Style.summaryText) { Get-TvFilledText $Style.summaryText $Envelope $timeFormat } else { [string](Get-TvProp $Envelope "summary") }
                if ($SummaryMax -ge 0 -and $summaryText.Length -gt $SummaryMax) { $summaryText = $summaryText.Substring(0, $SummaryMax) + "..." }
                $summaryBlock = [ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape $summaryText; wrap = $true }
                if ($compact) { $summaryBlock["spacing"] = "Small" }
                $body.Add([pscustomobject]$summaryBlock)
            }
            "details" {
                $facts = @(@(Get-TvProp $Envelope "details") | Where-Object { $_ } | Select-Object -First $DetailLimit | Where-Object { -not (@($Style.hiddenDetails) -ccontains [string](Get-TvProp $_ "label")) } | ForEach-Object {
                    [pscustomobject][ordered]@{ title = Get-TvMarkdownEscape (Get-TvProp $_ "label"); value = Get-TvMarkdownEscape (Get-TvProp $_ "value") }
                })
                if ($facts.Count -gt 0) {
                    $factBlock = [ordered]@{ type = "FactSet"; facts = $facts }
                    if ($compact) { $factBlock["spacing"] = "Small" }
                    $body.Add([pscustomobject]$factBlock)
                }
            }
            "items" {
                $allItems = @(@(Get-TvProp $Envelope "items") | Where-Object { $null -ne $_ })
                $shown = @($allItems | Select-Object -First $ItemLimit)
                foreach ($item in $shown) {
                    $meta = [System.Collections.Generic.List[string]]::new()
                    if ($Style.itemDetail -and (Get-TvProp $item "detail")) { $meta.Add([string](Get-TvProp $item "detail")) }
                    if ($Style.itemActor -and (Get-TvProp $item "actor")) { $meta.Add("by $(Get-TvProp $item 'actor')") }
                    if ($Style.itemTime -and (Get-TvProp $item "at")) { $meta.Add((& $formatTime (Get-TvProp $item "at"))) }
                    # Bullet and middle dot as char codes: the runbook stays ASCII.
                    $dot = " $([char]0x00B7) "
                    if ($Style.itemStyle -eq "stacked") {
                        $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape ([string](Get-TvProp $item "title")); wrap = $true; weight = "Bolder"; spacing = $(if ($compact) { "Small" } else { "Medium" }) })
                        if ($meta.Count -gt 0) {
                            $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape ($meta -join $dot); wrap = $true; isSubtle = $true; size = "Small"; spacing = "None" })
                        }
                    } else {
                        $line = @("$([char]0x2022) $(Get-TvProp $item 'title')") + @($meta.ToArray())
                        $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape ($line -join $dot); wrap = $true; spacing = $(if ($compact) { "None" } else { "Small" }) })
                    }
                    $settingsText = Get-TvItemSettingsText $item
                    if ($settingsText) {
                        $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape $settingsText; wrap = $true; isSubtle = $true; size = "Small"; spacing = "None" })
                    }
                }
                $more = [int](Get-TvProp $Envelope "moreCount") + ($allItems.Count - $shown.Count)
                if ($more -gt 0) {
                    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = "And $more more. Open TenuVault for the full list."; wrap = $true; isSubtle = $true })
                }
            }
            "note" {
                if ($IncludeNote -and $Style.noteText -and $script:TvSeverityRank[$severityName] -ge $script:TvSeverityRank[[string]$Style.noteMinSeverity]) {
                    $noteBlock = [pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape (Get-TvFilledText $Style.noteText $Envelope $timeFormat); wrap = $true }
                    $body.Add([pscustomobject][ordered]@{ type = "Container"; style = "emphasis"; items = @($noteBlock) })
                }
            }
            "footer" {
                $parts = [System.Collections.Generic.List[string]]::new()
                if ($Style.footerSource) { $parts.Add($(if ((Get-TvProp $Envelope "source") -eq "azure-watcher") { "Azure watcher" } else { "TenuVault desktop" })) }
                if ($Style.footerTime) { $parts.Add((& $formatTime (Get-TvProp $Envelope "occurredAt"))) }
                if ($Style.footerEventId) { $parts.Add("Event $(([string](Get-TvProp $Envelope 'eventId')).Substring(0, 12))") }
                if ($parts.Count -gt 0) {
                    $body.Add([pscustomobject][ordered]@{ type = "TextBlock"; text = Get-TvMarkdownEscape ($parts -join " $([char]0x00B7) "); wrap = $true; isSubtle = $true; size = "Small" })
                }
            }
        }
    }

    $card = [pscustomobject][ordered]@{
        '$schema' = "http://adaptivecards.io/schemas/adaptive-card.json"
        type = "AdaptiveCard"; version = "1.4"; body = @($body.ToArray())
    }
    # Fixed Microsoft destinations only, as cardButton in render.ts. Never tenant data.
    if (-not (@($Style.hidden) -ccontains "button")) {
        $action = switch ([string]$Style.buttonDestination) {
            "intune" { @{ href = "https://intune.microsoft.com"; label = "Open the Intune admin center" } }
            "entra" { @{ href = "https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies"; label = "Open Conditional Access in Entra" } }
            default { Get-TvActionLink $Envelope }
        }
        if ($action) {
            $label = if ($Style.buttonLabel) { Get-TvFilledText $Style.buttonLabel $Envelope $timeFormat } else { $action.label }
            $card | Add-Member -NotePropertyName actions -NotePropertyValue @([pscustomobject][ordered]@{ type = "Action.OpenUrl"; title = $label; url = $action.href })
        }
    }
    return [pscustomobject][ordered]@{
        type = "message"
        attachments = @([pscustomobject][ordered]@{
            contentType = "application/vnd.microsoft.card.adaptive"
            contentUrl = $null
            content = $card
        })
    }
}

# ---------------------------------------------------------------------------
# Watcher plumbing: tokens, configuration, storage state, delivery
# ---------------------------------------------------------------------------

function Get-TvTokenPrincipalId {
    param([string]$Token)
    # The managed identity's object id, read from its own token for the heartbeat.
    # It attributes a run to one Automation account without recording the token.
    try {
        $parts = @($Token -split "\.")
        if ($parts.Count -lt 2) { return $null }
        $payload = $parts[1].Replace("-", "+").Replace("_", "/")
        while ($payload.Length % 4) { $payload += "=" }
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
        $oid = Get-TvText (Get-TvProp $claims "oid")
        if ($oid -match "^[0-9a-fA-F-]{36}$") { return $oid.ToLowerInvariant() }
    } catch { }
    return $null
}

function Get-TvAutomationJobId {
    # Azure Automation exposes the current job in PSPrivateMetadata; the shape differs
    # between Windows PowerShell, PowerShell 7 and hybrid workers, so accept each form.
    $candidates = [System.Collections.Generic.List[object]]::new()
    try {
        $metadata = Get-Variable -Name PSPrivateMetadata -ValueOnly -ErrorAction SilentlyContinue
        $job = Get-TvProp $metadata "JobId"
        if ($job) {
            $guid = Get-TvProp $job "Guid"
            if ($guid) { $candidates.Add([string]$guid) }
            $candidates.Add([string]$job)
        }
    } catch { }
    foreach ($raw in @($env:PSPrivateMetadataJobId, $env:PSPrivateMetadata)) {
        if ($raw) { $candidates.Add([string]$raw) }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -match "^[0-9a-fA-F-]{36}$") { return $candidate.ToLowerInvariant() }
        try {
            $parsed = $candidate | ConvertFrom-Json
            $job = Get-TvProp $parsed "JobId"
            $guid = Get-TvProp $job "Guid"
            $value = if ($guid) { [string]$guid } elseif ($job) { [string]$job } else { $null }
            if ($value -match "^[0-9a-fA-F-]{36}$") { return $value.ToLowerInvariant() }
        } catch { }
    }
    return $null
}

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
    param([object]$Envelope, [string]$Url, [object]$Layout)
    if (-not $Url) { return }
    $style = Get-TvCardStyleFor $Layout ([string](Get-TvProp $Envelope "type"))
    $payload = ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $Envelope $style)
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
        [ValidateSet("Text", "HTML")][string]$BodyContentType = "Text",
        [object[]]$Attachments = @()
    )
    $content = [ordered]@{
        subject = $Subject
        body = [pscustomobject][ordered]@{ contentType = $BodyContentType; content = $BodyText }
        toRecipients = @($To | ForEach-Object {
            [pscustomobject][ordered]@{ emailAddress = [pscustomobject][ordered]@{ address = $_ } }
        })
    }
    if ($Attachments -and $Attachments.Count -gt 0) { $content["attachments"] = @($Attachments) }
    $message = [pscustomobject][ordered]@{
        message = [pscustomobject]$content
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

# ---------------------------------------------------------------------------
# Library: change reports left by cloud backups
# ---------------------------------------------------------------------------
# With TenuVaultChangeReport set, the cloud backup runbook leaves one report per backup under
# cloud-change-reports/ in the results container: the email fields and the report as HTML and
# Markdown, so the watcher never opens a backup itself. The watcher sends it from the
# verified mailbox and deletes it. A report waits while mail is not verified and is deleted
# unsent after 7 days. Reports are not part of state.json or the outbox: they are too large.

$script:TvReportPrefix = "cloud-change-reports/"
$script:TvReportSchema = "tenuvault.cloud-change-report/v1"
$script:TvReportMaxBytes = 4194304
# Graph sendMail takes at most 4 MB per request; base64 adds a third.
$script:TvReportAttachmentBudget = 2500000

# A blob as UTF-8 text. Invoke-WebRequest in Windows PowerShell decodes a body without a
# charset as ISO-8859-1, which would garble policy names in other languages.
function Get-TvBlobUtf8 {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token)
    try {
        $response = Invoke-TvStorageRequest -Uri $Uri -Method Get -Token $Token
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
        throw
    }
    $stream = $response.RawContentStream
    $stream.Position = 0
    return [Text.Encoding]::UTF8.GetString($stream.ToArray())
}

# Report notes can be a few MB. Windows PowerShell's ConvertFrom-Json refuses JSON over 2 MB,
# so there the serializer it uses is called with a higher limit; objects become dictionaries.
function ConvertFrom-TvReportJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ($script:TvNoteJsonParser -eq "SystemTextJson") { return ConvertFrom-TvNoteJson $Text }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    $serializer.RecursionLimit = 100
    return , $serializer.DeserializeObject($Text)
}

function Get-TvReportString {
    param([object]$Value, [int]$Max)
    if ($Value -is [string] -and $Value.Length -le $Max) { return $Value }
    return $null
}

# A report note of this tenant, checked field by field, or $null.
function ConvertFrom-TenuVaultChangeReport {
    param([AllowNull()][object]$Note, [Parameter(Mandatory)][string]$TenantId)
    if ($null -eq $Note -or $Note -is [string] -or $Note -is [array] -or $Note -is [ValueType]) { return $null }
    if ((Get-TvNoteField $Note "schema").Value -cne $script:TvReportSchema) { return $null }
    $tenant = (Get-TvNoteField $Note "tenantId").Value
    if ($tenant -isnot [string] -or $tenant.ToLowerInvariant() -ne $TenantId.ToLowerInvariant()) { return $null }
    $folder = (Get-TvNoteField $Note "backupFolder").Value
    if ($folder -isnot [string] -or $folder -cnotmatch '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\z') { return $null }
    $createdAt = ConvertTo-TvIso (Get-TvNoteField $Note "createdAt").Value
    if (-not $createdAt) { return $null }
    $email = (Get-TvNoteField $Note "email").Value
    if ($null -eq $email -or $email -is [string] -or $email -is [array] -or $email -is [ValueType]) { return $null }
    $severity = Get-TvProp $email "severity"
    if ($severity -cne "info" -and $severity -cne "warning") { return $null }
    $title = Get-TvReportString (Get-TvProp $email "title") 400
    $summary = Get-TvReportString (Get-TvProp $email "summary") 1000
    $naturalKey = Get-TvReportString (Get-TvProp $email "naturalKey") 300
    $occurredAt = ConvertTo-TvIso (Get-TvProp $email "occurredAt")
    $moreCount = Get-TvNoteCount (Get-TvProp $email "moreCount")
    if (-not $title -or -not $summary -or -not $naturalKey -or -not $occurredAt -or $null -eq $moreCount) { return $null }
    $details = [System.Collections.Generic.List[object]]::new()
    foreach ($detail in @(Get-TvProp $email "details")) {
        if ($null -eq $detail) { continue }
        $label = Get-TvReportString (Get-TvProp $detail "label") 80
        $value = Get-TvReportString (Get-TvProp $detail "value") 500
        if (-not $label -or $null -eq $value -or $details.Count -ge 20) { return $null }
        $details.Add([pscustomobject][ordered]@{ label = $label; value = $value })
    }
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-TvProp $email "items")) {
        if ($null -eq $item) { continue }
        $itemTitle = Get-TvReportString (Get-TvProp $item "title") 600
        if (-not $itemTitle -or $items.Count -ge 20) { return $null }
        $entry = [ordered]@{ title = $itemTitle }
        foreach ($field in @("detail", "actor", "at")) {
            $text = Get-TvReportString (Get-TvProp $item $field) 600
            if ($text) { $entry[$field] = $text }
        }
        $items.Add([pscustomobject]$entry)
    }
    $files = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @((Get-TvNoteField $Note "files").Value)) {
        if ($null -eq $file) { continue }
        $name = Get-TvProp $file "name"
        $contentType = Get-TvProp $file "contentType"
        $content = Get-TvProp $file "content"
        if ($name -isnot [string] -or $name -cnotmatch '^change-report-[a-z0-9-]{0,60}[0-9]{4}-[0-9]{2}-[0-9]{2}\.(html|md)\z' -or $content -isnot [string] -or $files.Count -ge 2) { return $null }
        $expected = if ($name.EndsWith(".html")) { "text/html" } else { "text/markdown" }
        if ($contentType -cne $expected) { return $null }
        $files.Add([pscustomobject][ordered]@{ name = $name; contentType = $contentType; content = $content })
    }
    return [pscustomobject][ordered]@{
        backupFolder = $folder; createdAt = $createdAt
        severity = $severity; title = $title; summary = $summary; naturalKey = $naturalKey; occurredAt = $occurredAt
        details = $details.ToArray(); items = $items.ToArray(); moreCount = $moreCount; files = $files.ToArray()
    }
}

# The email of a report: the same envelope and design as the desktop app's report email.
function New-TenuVaultChangeReportEnvelope {
    param([Parameter(Mandatory)][object]$Report, [Parameter(Mandatory)][string]$TenantId, [object]$TenantName, [string]$AttachmentNote)
    $summary = $Report.summary
    if ($AttachmentNote) { $summary = "$summary $AttachmentNote" }
    return New-TvEnvelope -Type "drift.detected" -Severity $Report.severity -TenantId $TenantId -TenantName $TenantName `
        -OccurredAt $Report.occurredAt -NaturalKey $Report.naturalKey -Title $Report.title -Summary $summary `
        -Details $Report.details -Items $Report.items -MoreCount $Report.moreCount
}

# The attachments that fit one Graph request: the HTML (opens in any browser, prints to PDF)
# and the Markdown, the HTML first.
function Get-TvReportAttachments {
    param([Parameter(Mandatory)][object]$Report)
    $chosen = [System.Collections.Generic.List[object]]::new()
    $used = 0
    foreach ($file in @($Report.files | Sort-Object { if ($_.name.EndsWith(".html")) { 0 } else { 1 } })) {
        if ($null -eq $file) { continue }
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$file.content)
        if ($used + $bytes.Length -gt $script:TvReportAttachmentBudget) { continue }
        $used += $bytes.Length
        $chosen.Add([pscustomobject][ordered]@{
            "@odata.type" = "#microsoft.graph.fileAttachment"
            name = $file.name
            contentType = $file.contentType
            contentBytes = [Convert]::ToBase64String($bytes)
        })
    }
    return , $chosen.ToArray()
}

# Sends every waiting report and deletes it once Graph accepted the mail. Reports wait while
# mail is not verified; reports older than MaxAgeDays and invalid ones are deleted unsent.
# $Delivered holds the names of reports Graph accepted whose note is not deleted yet. It lives in
# the watcher state and is saved under the state lease before the delete, so a delete that fails
# is retried by later runs without sending the report again. A failed delete is the run's error.
function Send-TvChangeReports {
    param(
        [Parameter(Mandatory)][string]$ContainerUri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$TenantId,
        [object]$TenantName,
        [bool]$MailEnabled,
        [string]$MailSender,
        [string]$Recipients,
        [string]$GraphToken,
        [Parameter(Mandatory)][scriptblock]$RenewLease,
        [DateTime]$Now = [DateTime]::UtcNow,
        [int]$MaxAgeDays = 7,
        [System.Collections.Generic.List[string]]$Delivered = $null,
        [scriptblock]$SaveState = {},
        [int]$MaxDelivered = 200
    )
    if ($null -eq $Delivered) { $Delivered = [System.Collections.Generic.List[string]]::new() }
    $oldest = ConvertTo-TvIso ($Now.ToUniversalTime().AddDays(-$MaxAgeDays))
    # Messages are returned, not written, so the function's output stays one object.
    $result = [pscustomobject][ordered]@{ Sent = 0; Waiting = 0; Held = 0; Expired = 0; Ignored = 0; Error = $null; Messages = [System.Collections.Generic.List[string]]::new() }
    # Why notes were deleted unsent as invalid: over 4 MB, not readable as JSON, or refused by
    # the report checks (another tenant, or a field over its limit or not in the expected form).
    $ignoredWhy = [ordered]@{ "too large" = 0; "not valid JSON" = 0; "refused by the report checks" = 0 }
    $to = @(($Recipients -split "[,;]") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $canSend = $MailEnabled -and $MailSender -and $GraphToken -and $to.Count -gt 0
    $names = [System.Collections.Generic.List[object]]::new()
    $marker = $null
    try {
        do {
            & $RenewLease
            $listUri = "$ContainerUri`?restype=container&comp=list&prefix=$([uri]::EscapeDataString($script:TvReportPrefix))&maxresults=500"
            if ($marker) { $listUri += "&marker=$([uri]::EscapeDataString($marker))" }
            $listText = [string](Invoke-TvStorageRequest -Uri $listUri -Method Get -Token $Token).Content
            $xmlStart = $listText.IndexOf("<")
            if ($xmlStart -gt 0) { $listText = $listText.Substring($xmlStart) }
            [xml]$listXml = $listText
            $blobsNode = $listXml.EnumerationResults.Blobs
            foreach ($blob in @(if ($blobsNode) { $blobsNode.Blob })) {
                if (-not $blob -or -not $blob.Name) { continue }
                $length = 0L
                [void][long]::TryParse([string]$blob.Properties.'Content-Length', [ref]$length)
                $names.Add([pscustomobject]@{ Name = [string]$blob.Name; Length = $length })
            }
            $marker = [string]$listXml.EnumerationResults.NextMarker
            if (-not $marker) { $marker = $null }
        } while ($marker)
    } catch {
        $result.Error = "Change reports could not be listed in this run: $(Get-TvSafeError $_.Exception.Message)"
        return $result
    }
    # A delivered report whose note is gone was deleted after all: forget it. A name whose note
    # still exists is never dropped, whatever the count: dropping it would send the report again.
    $listed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($blob in $names) { [void]$listed.Add($blob.Name) }
    $forgotten = @($Delivered | Where-Object { -not $listed.Contains($_) })
    if ($forgotten.Count -gt 0) {
        foreach ($name in $forgotten) { [void]$Delivered.Remove($name) }
        & $SaveState
    }
    # Delivered ones first: their deletes free room in the state before new reports are sent.
    $ordered = @(@($names | Where-Object { $Delivered.Contains($_.Name) }) + @($names | Where-Object { -not $Delivered.Contains($_.Name) }))
    foreach ($blob in $ordered) {
        if (-not $blob.Name.StartsWith($script:TvReportPrefix, [StringComparison]::Ordinal)) { continue }
        & $RenewLease
        $encodedName = ($blob.Name -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
        $uri = "$ContainerUri/$encodedName"
        $remove = $false
        $sent = $Delivered.Contains($blob.Name)
        # A lost lease or a state that cannot be saved stops delivery and fails the run: another
        # watcher run may own the state now, and an unrecorded send could be repeated.
        $stop = $null
        try {
            $report = $null
            if ($sent) {
                # Sent by an earlier run whose delete failed: only the delete is retried.
                $remove = $true
            } elseif ($blob.Length -le $script:TvReportMaxBytes) {
                $text = Get-TvBlobUtf8 -Uri $uri -Token $Token
                if ($null -eq $text) { continue }
                $parsed = $null
                try { $parsed = ConvertFrom-TvReportJson $text } catch { $ignoredWhy["not valid JSON"]++ }
                if ($null -ne $parsed) {
                    try { $report = ConvertFrom-TenuVaultChangeReport $parsed $TenantId } catch { $report = $null }
                    if ($null -eq $report) { $ignoredWhy["refused by the report checks"]++ }
                }
            } else {
                $ignoredWhy["too large"]++
            }
            if ($sent) {
            } elseif ($null -eq $report) {
                $result.Ignored++
                $remove = $true
            } elseif ([StringComparer]::Ordinal.Compare([string]$report.createdAt, $oldest) -lt 0) {
                $result.Expired++
                $remove = $true
            } elseif (-not $canSend) {
                $result.Waiting++
            } elseif ($Delivered.Count -ge $MaxDelivered) {
                # The state holds as many sent reports as it may while their deletes fail; this one
                # waits until room is free, so nothing is ever sent twice.
                $result.Held++
            } else {
                $attachments = Get-TvReportAttachments $report
                $note = $null
                if ($attachments.Count -eq 0) { $note = "The report was too large to attach to this message." }
                $envelope = New-TenuVaultChangeReportEnvelope -Report $report -TenantId $TenantId -TenantName $TenantName -AttachmentNote $note
                $subject = "TenuVault: $(if ($envelope.severity -eq 'warning') { '[Warning] ' })$($envelope.title)"
                if ($subject.Length -gt 250) { $subject = $subject.Substring(0, 250) }
                $html = Get-TvEmailHtml $envelope
                # Renewed right before the send: the download and parsing above can take most of
                # the 60 second lease. Without the lease, nothing is sent or deleted.
                try { & $RenewLease } catch { $stop = $_; throw }
                Send-TvRawMail -From $MailSender -To $to -Subject $subject -BodyText $html -GraphToken $GraphToken -BodyContentType "HTML" -Attachments $attachments
                $result.Messages.Add("Sent the change report of $($report.backupFolder) to $($to.Count) recipient(s).")
                $result.Sent++
                $sent = $true
                $remove = $true
                $Delivered.Add($blob.Name)
                try { & $SaveState } catch { $stop = $_; throw }
            }
        } catch {
            if (-not $stop -and -not $result.Error) { $result.Error = "A change report could not be sent: $(Get-TvSafeError $_.Exception.Message)" }
        }
        if ($stop -and -not $sent) { throw $stop }
        if ($remove) {
            $removed = $false
            try { Invoke-TvStorageRequest -Uri $uri -Method Delete -Token $Token | Out-Null; $removed = $true }
            catch {
                if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { $removed = $true }
                else {
                    $why = "Could not remove the change report $($blob.Name): $(Get-TvSafeError $_.Exception.Message).$(if ($sent) { ' It was sent and is not sent again; the next run retries the delete.' })"
                    $result.Messages.Add($why)
                    if (-not $result.Error) { $result.Error = $why }
                }
            }
            # Sent but not recorded: the delete above was the last chance to prevent a resend. When
            # it failed too, the next run sends the report once more. That is accepted on purpose:
            # delivery is at least once, because a rare duplicate after two storage failures is
            # better than a report that is never sent (a claim before the send would risk that).
            if ($stop -and -not $removed) {
                throw "The change report $($blob.Name) was sent but could neither be recorded in the watcher state nor deleted, so the next run may send it once more. $(Get-TvSafeError $stop.Exception.Message)"
            }
            if ($stop) { throw $stop }
            if ($removed -and $sent) {
                [void]$Delivered.Remove($blob.Name)
                & $SaveState
            }
        }
    }
    if ($result.Held -gt 0) {
        $held = "$($result.Held) change report(s) wait: $($Delivered.Count) sent report(s) could not be deleted yet, the most the watcher state keeps. Give the watcher delete access to tenuvault-backup-results (run its setup again)."
        $result.Messages.Add($held)
        # The backlog explains the delete failures too, so it is what the heartbeat shows.
        $result.Error = $held
    }
    if ($result.Expired -gt 0) {
        # Waiting or held reports keep their original 7 day expiry; dropping one is never silent.
        $expired = "$($result.Expired) change report(s) were deleted unsent because they were older than $MaxAgeDays days (they waited for verified mail or for room in the watcher state)."
        $result.Messages.Add($expired)
        $result.Error = if ($result.Error) { "$($result.Error) $expired" } else { $expired }
    }
    if ($result.Ignored -gt 0) {
        # A refused report is never silent either: the admin otherwise only sees no email.
        $reasons = @($ignoredWhy.Keys | Where-Object { $ignoredWhy[$_] -gt 0 } | ForEach-Object { "$($ignoredWhy[$_]) $_" }) -join ", "
        $ignored = "$($result.Ignored) change report(s) were deleted unsent because they are not valid for this watcher ($reasons)."
        $result.Messages.Add($ignored)
        $result.Error = if ($result.Error) { "$($result.Error) $ignored" } else { $ignored }
    }
    if ($result.Waiting -gt 0) { $result.Messages.Add("$($result.Waiting) change report(s) wait for verified mail and report recipients.") }
    return $result
}

# ---------------------------------------------------------------------------
# Library: audit ingestion, shared by the Intune and the Entra audit log
# ---------------------------------------------------------------------------

# Reads one audit log from a saved continuation or from its watermark minus 30
# minutes, dedupes by audit id against earlier runs and returns the new changes.
# The ingestion cap counts NEW changes only. Duplicates inside the 30 minute
# overlap never consume budget, and the newest seen time includes duplicates, so
# a busy overlap window cannot stall progress. The leftover page URL is returned
# as the continuation: the current page when the cap breaks mid page (its rest is
# re-read and deduped), the next link when the page cap stopped the loop, or null
# when paging ran to the end. On failure the partial collection is discarded and
# the caller keeps its watermark, so the next run retries the same window.
# Messages are returned, not written, so the function's output stays one object.
# The Graph token may only ever go to Microsoft Graph. Saved continuations come from
# state.json and next links from responses, so both are checked before use.
function Test-TvGraphUrl {
    param([AllowNull()][AllowEmptyString()][string]$Url)
    if (-not $Url) { return $false }
    $parsed = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed)) { return $false }
    return ($parsed.Scheme -eq "https" -and $parsed.Host -eq "graph.microsoft.com" -and $parsed.IsDefaultPort)
}

function Invoke-TvAuditIngestion {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$FreshUri,
        [AllowNull()][AllowEmptyString()][string]$Continuation,
        [Parameter(Mandatory)][hashtable]$PriorIds,
        [Parameter(Mandatory)][string]$WatermarkIso,
        [AllowNull()][AllowEmptyString()][string]$GraphToken,
        [AllowNull()][AllowEmptyString()][string]$TokenError,
        [Parameter(Mandatory)][scriptblock]$Map,
        [Parameter(Mandatory)][scriptblock]$RenewLease
    )
    $messages = [System.Collections.Generic.List[string]]::new()
    $graphHeaders = @{ Authorization = "Bearer $GraphToken"; ConsistencyLevel = "eventual" }
    $newChanges = [System.Collections.Generic.List[object]]::new()
    $seenThisRun = @{}
    $seenCount = 0
    $newestSeenIso = $WatermarkIso
    $capReached = $false
    $pageCount = 0
    $currentContinuation = if ($Continuation) { $Continuation } else { $null }
    if ($currentContinuation -and -not (Test-TvGraphUrl $currentContinuation)) {
        $messages.Add("The saved $Label audit continuation is not a Microsoft Graph address. It is ignored and the overlap query is used.")
        $currentContinuation = $null
    }
    $nextUri = $FreshUri
    $resumed = $false
    $ingestionError = if ($TokenError) { $TokenError } else { $null }
    if ($currentContinuation) {
        $nextUri = $currentContinuation
        $resumed = $true
    }
    while ($GraphToken -and $nextUri -and -not $capReached -and $pageCount -lt 500) {
        & $RenewLease
        $pageCount++
        $page = $null
        try {
            $page = Invoke-RestMethod -Uri $nextUri -Headers $graphHeaders -Method Get -TimeoutSec 60
        } catch {
            $pageStatusCode = 0
            if ($_.Exception.Response) { $pageStatusCode = [int]$_.Exception.Response.StatusCode }
            if ($resumed -and $pageStatusCode -eq 400) {
                # A stored continuation can expire. Discard it and restart once
                # from the fresh overlap query inside the same run.
                $messages.Add("The saved $Label audit continuation was rejected with HTTP 400. Restarting from the overlap query.")
                $currentContinuation = $null
                $resumed = $false
                $nextUri = $FreshUri
                continue
            }
            # A Graph outage or a persistent 403 must not abort the run here: the
            # caller records it, still runs the missed backup check and every pending
            # delivery, and fails the run nonzero at the very end.
            $ingestionError = "$Label audit ingestion failed: $(Get-TvSafeError $_.Exception.Message)"
            $messages.Add("$ingestionError Pending deliveries will still be attempted.")
            break
        }
        $resumed = $false
        foreach ($rawEvent in @($page.value)) {
            if ($null -eq $rawEvent) { continue }
            $seenCount++
            $rawAt = ConvertTo-TvIso (Get-TvProp $rawEvent "activityDateTime")
            if ($rawAt -and [StringComparer]::Ordinal.Compare($rawAt, $newestSeenIso) -gt 0) { $newestSeenIso = $rawAt }
            $change = & $Map $rawEvent
            if (-not $change) { continue }
            $auditIdValue = [string](Get-TvProp $change "auditId")
            if ($PriorIds.ContainsKey($auditIdValue) -or $seenThisRun.ContainsKey($auditIdValue)) { continue }
            if ($newChanges.Count -ge 500) { $capReached = $true; break }
            $seenThisRun[$auditIdValue] = $true
            $newChanges.Add($change)
        }
        if (-not $capReached) {
            $nextUri = Get-TvText (Get-TvProp $page "@odata.nextLink")
            if ($nextUri -and -not (Test-TvGraphUrl $nextUri)) {
                $ingestionError = "$Label audit ingestion stopped: the next page link is not a Microsoft Graph address."
                $messages.Add($ingestionError)
                break
            }
        }
    }
    if ($ingestionError) {
        $newChanges.Clear()
        $newestSeenIso = $WatermarkIso
    } else {
        $currentContinuation = Get-TvText $nextUri
        # Pages are not in time order, so the watermark only moves once paging ran to the end:
        # unread pages can hold older events, and an expired continuation restarts from it.
        if ($currentContinuation) { $newestSeenIso = $WatermarkIso }
    }
    $messages.Add("Seen $seenCount $Label audit events, $($newChanges.Count) new.")
    return [pscustomobject]@{
        Changes = $newChanges
        NewestSeenIso = $newestSeenIso
        Continuation = $currentContinuation
        Error = $ingestionError
        Messages = $messages
    }
}

# Dedupe ids only need to cover the re-read window: entries older than the
# watermark minus 30 minutes can never be fetched again, so pruning is relative to
# the watermark, never to run time. The cap is a high safety bound that drops the
# oldest entries only.
# While a continuation is saved, the run stopped inside a page that the next run reads
# again from the top, whatever the age of its events, so no id is pruned until paging
# has run to the end (the desktop keeps that page's ids the same way).
function Get-TvRecentAuditList {
    param([Parameter(Mandatory)][hashtable]$RecentById, [Parameter(Mandatory)][string]$WatermarkIso, [bool]$KeepAll = $false)
    $pruneBefore = ConvertTo-TvIso ([DateTimeOffset]::Parse($WatermarkIso).UtcDateTime.AddMinutes(-30))
    $recentList = [System.Collections.Generic.List[object]]::new()
    foreach ($entryId in $RecentById.Keys) {
        $entryAt = $RecentById[$entryId]
        if (-not $KeepAll -and $entryAt -and [StringComparer]::Ordinal.Compare([string]$entryAt, $pruneBefore) -lt 0) { continue }
        $recentList.Add([pscustomobject][ordered]@{ id = [string]$entryId; at = [string]$entryAt })
    }
    $recentTrimmed = @($recentList | Sort-Object { [string](Get-TvProp $_ "at") } -Descending | Select-Object -First 25000)
    [array]::Reverse($recentTrimmed)
    return ,$recentTrimmed
}

function Get-TvRecentById {
    param([object]$State, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$WatermarkIso)
    $recentById = @{}
    if ($State) {
        foreach ($entry in @(Get-TvProp $State $Name)) {
            if ($null -eq $entry) { continue }
            $entryId = Get-TvText (Get-TvProp $entry "id")
            $entryAt = ConvertTo-TvIso (Get-TvProp $entry "at")
            if (-not $entryId -and $entry -is [string]) { $entryId = Get-TvText $entry; $entryAt = $WatermarkIso }
            if ($entryId) { $recentById[$entryId] = $entryAt }
        }
    }
    return $recentById
}

if ($LibraryOnly) { return }

# ---------------------------------------------------------------------------
# Watcher run. Everything below only runs inside Azure Automation (or locally
# with the configuration supplied as environment variables).
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$runbookVersion = "1.4.0"
$runAt = [DateTime]::UtcNow
$runAtIso = ConvertTo-TvIso $runAt
$eventsSent = 0
$lastError = $null
$configVersion = "1"
$configHash = $null
$alertsHash = $null
$alertsSource = $null
$leaseId = $null
$storageToken = $null
$stateBlobUri = $null
$heartbeatBlobUri = $null
$leaseQueryUri = $null
$heartbeatIdentity = $null
$heartbeatJobId = Get-TvAutomationJobId
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
    # Change reports of cloud backups go here, or to the mail recipients when it is not set.
    $reportRecipients = Get-TvAutomationVariable "TenuVaultReportRecipients"
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
    # Conditional Access change watching reads the Entra audit log and needs the
    # AuditLog.Read.All application role (setup -IncludeConditionalAccess).
    $watchConditionalAccessValue = Get-TvAutomationVariable "TenuVaultWatchConditionalAccess"
    $watchConditionalAccess = $watchConditionalAccessValue -match "^(true|1|yes)$"
    # The Teams card layout copied from TenuVault (Alerts > Channels > Teams card).
    # Unreadable JSON falls back to the standard card instead of stopping deliveries.
    $teamsCardLayout = $null
    $teamsCardLayoutValue = Get-TvAutomationVariable "TenuVaultTeamsCardLayout"
    if ($teamsCardLayoutValue) {
        try { $teamsCardLayout = $teamsCardLayoutValue | ConvertFrom-Json }
        catch { Write-Output "TenuVaultTeamsCardLayout is not valid JSON; Teams cards use the standard layout." }
    }

    if (-not $tenantId) { throw "Automation variable TenuVaultTenantId is not set." }
    if (-not $storageAccount) { throw "Automation variable TenuVaultStorageAccount is not set." }
    $alertRulesVariable = Get-TvAutomationVariable "TenuVaultAlertRules"

    if ($webhookUrl -and $webhookUrl -notmatch "^https://") { throw "TenuVaultWebhookUrl must use https." }
    if ($teamsWebhookUrl -and $teamsWebhookUrl -notmatch "^https://") { throw "TenuVaultTeamsWebhookUrl must use https." }


    # Storage first: state, lease and queued deliveries must keep working when
    # Graph token acquisition fails. The Graph failure is deferred like an
    # ingestion failure and surfaces at the end of the run.
    $storageToken = Get-TvManagedIdentityToken "https://storage.azure.com/"
    $graphToken = $null
    $graphTokenError = $null
    try {
        $graphToken = Get-TvManagedIdentityToken "https://graph.microsoft.com/"
        $heartbeatIdentity = Get-TvTokenPrincipalId $graphToken
    } catch {
        $graphTokenError = "Graph token acquisition failed: $(Get-TvSafeError $_.Exception.Message)"
        Write-Output "$graphTokenError Audit ingestion is skipped; missed backup checking and pending deliveries still run."
    }

    $stateContainerUri = "https://$storageAccount.blob.core.windows.net/tenuvault-notification-state"
    # Cloud backup result notes have their own container: the backup identity may write there.
    $resultsContainerUri = "https://$storageAccount.blob.core.windows.net/tenuvault-backup-results"
    $stateBlobUri = "$stateContainerUri/state.json"
    $heartbeatBlobUri = "$stateContainerUri/heartbeat.json"
    $leaseQueryUri = "$stateBlobUri`?comp=lease"
    $alertsBlobUri = "$stateContainerUri/alerts.json"

    # The alerts copied from TenuVault. The desktop app writes them to alerts.json next to the
    # state (Alerts page > Update watcher), and setup -AlertRulesPath writes the same file, so
    # alerts change without touching the Automation account. A watcher set up before that keeps
    # the TenuVaultAlertRules variable until alerts.json exists. The variable is used only when
    # the file does not exist: a file that cannot be read never brings back older alerts.
    # Without alerts every event goes to every destination. An unreadable file or value does the
    # same and says so, because sending too much is safer than silently sending nothing.
    $alertsSource = "none"
    $alertRulesValue = $null
    try {
        $alertsBlobText = Get-TvBlobText -Uri $alertsBlobUri -Token $storageToken
        if ($null -ne $alertsBlobText) {
            $alertsSource = "storage"
            $alertRulesValue = $alertsBlobText.Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
            if ($alertRulesValue.Length -gt 1000000) { $alertRulesValue = "too large" }
            # An empty file is unreadable, not "no alerts": it must say so like a damaged one.
            if (-not $alertRulesValue) { $alertRulesValue = "empty" }
        }
    } catch {
        # Sending too much is safer than filtering with alerts that may be out of date.
        $alertsSource = "storage"
        $alertRulesValue = "read failed"
        Write-Output "alerts.json could not be read ($(Get-TvSafeError $_.Exception.Message))."
    }
    if ($alertsSource -eq "none" -and $alertRulesVariable) { $alertsSource = "setup"; $alertRulesValue = $alertRulesVariable }
    $alertsLabel = if ($alertsSource -eq "storage") { "alerts.json" } else { "TenuVaultAlertRules" }
    $watcherAlerts = $null
    $alertsHash = Get-TvWatcherAlertsHash $alertRulesValue
    if ($alertRulesValue) {
        $watcherAlerts = ConvertFrom-TvWatcherAlerts $alertRulesValue
        if ($null -eq $watcherAlerts) { Write-Output "$alertsLabel could not be read; every event goes to every destination until it is set again." }
        elseif (@($watcherAlerts).Count -eq 0) {
            # Set but nothing usable (no alerts, unknown event types or destinations): never fall silent.
            $watcherAlerts = $null
            Write-Output "$alertsLabel holds no alert this runbook can use; every event goes to every destination until it is set again."
        }
        else { Write-Output "Alerts from TenuVault ($alertsLabel): $(@($watcherAlerts).Count)." }
    }

    # Fingerprint of the effective configuration for the heartbeat: non-secret values
    # in full, secrets only as presence flags, so drift is visible without leaking.
    $configFingerprint = @(
        "tenantId=$($tenantId.ToLowerInvariant())"
        "tenantName=$tenantName"
        "storageAccount=$storageAccount"
        "mailSender=$mailSender"
        "mailRecipients=$mailRecipients"
        "reportRecipients=$reportRecipients"
        "mailProbeMailbox=$mailProbeMailbox"
        "missedBackupHours=$missedBackupHours"
        "includeActor=$($includeActor.ToString().ToLowerInvariant())"
        "watchConditionalAccess=$($watchConditionalAccess.ToString().ToLowerInvariant())"
        "teamsCardLayout=$(if ($teamsCardLayoutValue) { Get-TvSha256Hex $teamsCardLayoutValue } else { 'standard' })"
        "alertRules=$(if ($alertRulesValue) { Get-TvSha256Hex $alertRulesValue } else { 'none' })"
        "alertsSource=$alertsSource"
        "configVersion=$configVersion"
        "webhookUrl=$(if ($webhookUrl) { 'present' } else { 'absent' })"
        "webhookSecret=$(if ($webhookSecret) { 'present' } else { 'absent' })"
        "teamsWebhookUrl=$(if ($teamsWebhookUrl) { 'present' } else { 'absent' })"
    ) -join "|"
    $configHash = Get-TvSha256Hex $configFingerprint

    # Only configuration version 1 is understood. Anything else stops the run
    # before any polling, with the reason recorded in the heartbeat.
    if ($configVersion -ne "1") {
        $lastError = "Unsupported TenuVaultConfigVersion '$configVersion'. This runbook supports version 1 only."
        try {
            $rejectedHeartbeat = [pscustomobject][ordered]@{
                runAt = $runAtIso
                runbookVersion = $runbookVersion
                identityPrincipalId = $heartbeatIdentity
                jobId          = $heartbeatJobId
                configVersion = $configVersion
                configHash = $configHash
                alertsHash = $alertsHash
                alertsSource = $alertsSource
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

    $recentById = Get-TvRecentById -State $state -Name "recentAuditIds" -WatermarkIso $watermarkIso
    # The Entra audit log keeps its own position. A watcher that starts watching
    # Conditional Access begins an hour back, like a new watcher does for Intune.
    $entraWatermarkIso = if ($state) { ConvertTo-TvIso (Get-TvProp $state "entraWatermark") } else { $null }
    if (-not $entraWatermarkIso) { $entraWatermarkIso = ConvertTo-TvIso $runAt.AddHours(-1) }
    $entraRecentById = Get-TvRecentById -State $state -Name "entraRecentAuditIds" -WatermarkIso $entraWatermarkIso
    $entraContinuation = if ($state) { Get-TvText (Get-TvProp $state "entraContinuation") } else { $null }
    $sentEventIds = [System.Collections.Generic.List[string]]::new()
    if ($state) {
        foreach ($entry in @(Get-TvProp $state "sentEventIds")) {
            $entryText = Get-TvText $entry
            if ($entryText) { $sentEventIds.Add($entryText) }
        }
    }
    $lastMissedKey = if ($state) { Get-TvText (Get-TvProp $state "lastMissedKey") } else { $null }
    # Backup folders a cloud backup reported as Failed. The missed backup check does not count
    # them, so a backup that fails every day still raises "No recent backup".
    $failedBackupFolders = [System.Collections.Generic.List[string]]::new()
    if ($state) {
        $savedFailed = Get-TvStyleList $state "failedBackupFolders"
        foreach ($entry in @(if ($null -ne $savedFailed) { $savedFailed })) {
            if ($entry -is [string] -and $entry -cmatch '^backup-\d{4}-\d{2}-\d{2}-\d{6}$' -and -not $failedBackupFolders.Contains($entry)) { $failedBackupFolders.Add($entry) }
        }
    }
    $continuation = if ($state) { Get-TvText (Get-TvProp $state "continuation") } else { $null }
    # Change reports Graph accepted whose note could not be deleted yet; never sent again.
    $deliveredReports = [System.Collections.Generic.List[string]]::new()
    if ($state) {
        foreach ($entry in @(Get-TvProp $state "deliveredReports")) {
            if ($entry -is [string] -and $entry -cmatch '^cloud-change-reports/backup-\d{4}-\d{2}-\d{2}-\d{6}\.json$' -and -not $deliveredReports.Contains($entry)) { $deliveredReports.Add($entry) }
        }
    }
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
        $recentTrimmed = Get-TvRecentAuditList -RecentById $recentById -WatermarkIso $watermarkIso -KeepAll ([bool]$continuation)
        $entraRecentTrimmed = Get-TvRecentAuditList -RecentById $entraRecentById -WatermarkIso $entraWatermarkIso -KeepAll ([bool]$entraContinuation)
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
            failedBackupFolders = @($failedBackupFolders.ToArray() | Sort-Object -Descending | Select-Object -First 200)
            # Never trimmed: Send-TvChangeReports keeps it at 200 names by holding new reports back.
            deliveredReports = @($deliveredReports.ToArray())
            continuation = $continuation
            # While Conditional Access is not watched its position is not kept, so turning it
            # on later starts an hour back instead of replaying everything since an old watermark.
            entraWatermark = $(if ($watchConditionalAccess) { $entraWatermarkIso } else { $null })
            entraRecentAuditIds = @(if ($watchConditionalAccess) { $entraRecentTrimmed })
            entraContinuation = $(if ($watchConditionalAccess) { $entraContinuation } else { $null })
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
            identityPrincipalId = $heartbeatIdentity
            jobId          = $heartbeatJobId
            configVersion = $configVersion
            configHash = $configHash
            alertsHash = $alertsHash
            alertsSource = $alertsSource
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

    # --- Audit events: Intune, and Conditional Access when watched ---------------
    $renewLease = { Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId }
    $priorRecent = @{}
    foreach ($priorId in $recentById.Keys) { $priorRecent[[string]$priorId] = $true }
    $filterFrom = ConvertTo-TvIso ([DateTimeOffset]::Parse($watermarkIso).UtcDateTime.AddMinutes(-30))
    $select = "id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources"
    # No $orderby: with it, Graph scans the whole audit history from the oldest event and answers
    # with empty pages until it reaches the window. Alerts are sorted after reading.
    $query = "`$select=$([uri]::EscapeDataString($select))&`$filter=$([uri]::EscapeDataString("activityDateTime gt $filterFrom and activityOperationType ne 'Get' and activityOperationType ne 'Search'"))&`$top=200"
    $intuneResult = Invoke-TvAuditIngestion -Label "Intune" -FreshUri "https://graph.microsoft.com/beta/deviceManagement/auditEvents?$query" `
        -Continuation $continuation -PriorIds $priorRecent -WatermarkIso $watermarkIso -GraphToken $graphToken -TokenError $graphTokenError `
        -Map { param($raw) ConvertFrom-TenuVaultAuditEvent $raw } -RenewLease $renewLease
    foreach ($message in $intuneResult.Messages) { Write-Output $message }
    $newChanges = $intuneResult.Changes
    $newestSeenIso = $intuneResult.NewestSeenIso
    $continuation = $intuneResult.Continuation
    $ingestionError = $intuneResult.Error

    # Same filter and fields as entra.ts. Graph still returns each event's modified
    # property values and the actor's IP address; the mapper never reads them.
    $entraChanges = [System.Collections.Generic.List[object]]::new()
    $entraNewestSeenIso = $entraWatermarkIso
    if ($watchConditionalAccess) {
        $entraPrior = @{}
        foreach ($priorId in $entraRecentById.Keys) { $entraPrior[[string]$priorId] = $true }
        $entraFrom = ConvertTo-TvIso ([DateTimeOffset]::Parse($entraWatermarkIso).UtcDateTime.AddMinutes(-30))
        $entraSelect = "id,activityDateTime,activityDisplayName,category,operationType,result,loggedByService,initiatedBy,targetResources"
        $entraFilter = "(loggedByService eq 'Conditional Access' or startswith(activityDisplayName,'Authentication Strength')) and activityDateTime gt $entraFrom"
        $entraQuery = "`$select=$([uri]::EscapeDataString($entraSelect))&`$filter=$([uri]::EscapeDataString($entraFilter))&`$orderby=$([uri]::EscapeDataString('activityDateTime asc'))&`$top=200"
        $entraResult = Invoke-TvAuditIngestion -Label "Conditional Access" -FreshUri "https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$entraQuery" `
            -Continuation $entraContinuation -PriorIds $entraPrior -WatermarkIso $entraWatermarkIso -GraphToken $graphToken -TokenError $graphTokenError `
            -Map { param($raw) ConvertFrom-TenuVaultEntraAuditEvent $raw } -RenewLease $renewLease
        foreach ($message in $entraResult.Messages) { Write-Output $message }
        $entraChanges = $entraResult.Changes
        $entraNewestSeenIso = $entraResult.NewestSeenIso
        $entraContinuation = $entraResult.Continuation
        if ($entraResult.Error -and -not $ingestionError) { $ingestionError = $entraResult.Error }
        elseif ($entraResult.Error -and $entraResult.Error -ne $ingestionError) { $ingestionError = "$ingestionError $($entraResult.Error)" }
    }
    if ($ingestionError -and -not $lastError) { $lastError = $ingestionError }

    $candidateEnvelopes = [System.Collections.Generic.List[object]]::new()
    # With alerts, change envelopes come from the alert plan and carry the destinations of the
    # alerts that picked them; other envelopes get theirs at enqueue time below.
    $plannedDestinations = @{}
    foreach ($serviceRun in @(@{ Service = "intune"; Changes = $newChanges }, @{ Service = "conditionalAccess"; Changes = $entraChanges })) {
        if ($null -eq $serviceRun.Changes -or @($serviceRun.Changes).Count -eq 0) { continue }
        if ($null -eq $watcherAlerts) {
            $candidateEnvelopes.Add((New-TenuVaultAuditDigest -TenantId $tenantId -TenantName $tenantName `
                -Changes @($serviceRun.Changes) -IncludeActor $includeActor -Service $serviceRun.Service))
            continue
        }
        $plan = Get-TvChangeAlertPlan -Service $serviceRun.Service -Changes @($serviceRun.Changes) -Alerts @($watcherAlerts) `
            -TenantId $tenantId -TenantName $tenantName -IncludeActor $includeActor
        foreach ($plannedAlert in $plan) {
            $candidateEnvelopes.Add($plannedAlert.envelope)
            $plannedDestinations[[string]$plannedAlert.envelope.eventId] = Get-TvAlertDestinations -Alerts @($watcherAlerts) -AlertIds @($plannedAlert.alertIds.ToArray())
        }
    }

    # --- Cloud backup results ----------------------------------------------------
    # Result notes the cloud backup runbook left in tenuvault-backup-results (see
    # src/shared/notifications/cloud-outcome.ts). Each becomes a backup alert through the
    # outbox below. A note is deleted only after the state holding its alert is saved, so a
    # crash in between rereads it and the outbox dedupes it by event id. Reading them must
    # never block the rest of the run.
    $outcomeRead = Read-TvBackupOutcomes -ContainerUri $resultsContainerUri -Token $storageToken -TenantId $tenantId -TenantName $tenantName `
        -RenewLease { Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId }
    foreach ($envelope in $outcomeRead.Envelopes) { $candidateEnvelopes.Add($envelope) }
    foreach ($folder in $outcomeRead.FailedFolders) { if (-not $failedBackupFolders.Contains($folder)) { $failedBackupFolders.Add($folder) } }
    $processedOutcomeNames = $outcomeRead.Processed
    $ignoredOutcomes = $outcomeRead.Ignored
    if ($outcomeRead.Error) {
        Write-Output $outcomeRead.Error
        if (-not $lastError) { $lastError = $outcomeRead.Error }
    }
    if ($processedOutcomeNames.Count -gt 0) { Write-Output "Read $($processedOutcomeNames.Count) cloud backup result(s)." }
    if ($ignoredOutcomes -gt 0) { Write-Output "Removed $ignoredOutcomes cloud backup result note(s) that are not valid for this tenant or too large." }
    if ($outcomeRead.Expired -gt 0) { Write-Output "Removed $($outcomeRead.Expired) cloud backup result note(s) older than 7 days without an alert." }

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
                # A folder a cloud backup reported as Failed holds no usable backup.
                if ($failedBackupFolders.Contains($name.TrimEnd("/"))) { continue }
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
        $wanted = Get-TvIntendedDestinations -Alerts $watcherAlerts -Envelope $candidate -Planned $plannedDestinations[$candidateId] -Configured @($configuredDestinations.ToArray())
        foreach ($channelName in $wanted) { $intendedChannels.Add([string]$channelName) }
        # With alerts, an envelope no alert takes (or whose destinations are not set up here) is owed nothing.
        if ($null -ne $watcherAlerts -and $intendedChannels.Count -eq 0) { continue }
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
    foreach ($change in $entraChanges) {
        $entraRecentById[[string](Get-TvProp $change "auditId")] = [string](Get-TvProp $change "at")
    }
    $entraWatermarkIso = $entraNewestSeenIso
    if ($missedKeyToSet) { $lastMissedKey = $missedKeyToSet }
    $watermarkIso = $newestSeenIso
    & $saveState

    # The alerts of the cloud backup results are in the saved outbox now, so their notes go.
    foreach ($blobName in $processedOutcomeNames) {
        # Losing the lease stays fatal, like everywhere else; only the delete itself is best effort.
        Update-TvStateLease -LeaseQueryUri $leaseQueryUri -Token $storageToken -LeaseId $leaseId
        try {
            $encodedName = ($blobName -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
            Invoke-TvStorageRequest -Uri "$resultsContainerUri/$encodedName" -Method Delete -Token $storageToken | Out-Null
        } catch {
            Write-Output "Could not remove the cloud backup result $($blobName): $(Get-TvSafeError $_.Exception.Message). The next run reads it again and sends nothing twice."
        }
    }

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
                        "teams" { Send-TvTeams -Envelope $envelope -Url $teamsWebhookUrl -Layout $teamsCardLayout }
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

    # --- Change reports left by cloud backups ---------------------------------------
    # Reports need the verified sender and their own recipients, not the alert recipients.
    $reportTo = if ($reportRecipients) { $reportRecipients } else { $mailRecipients }
    $reportRun = Send-TvChangeReports -ContainerUri $resultsContainerUri -Token $storageToken -TenantId $tenantId -TenantName $tenantName `
        -MailEnabled ([bool]($mailSender -and $reportTo -and $senderVerified)) -MailSender $mailSender -Recipients $reportTo `
        -GraphToken $graphToken -RenewLease $renewLease -Now $runAt -Delivered $deliveredReports -SaveState $saveState
    foreach ($message in $reportRun.Messages) { Write-Output $message }
    if ($reportRun.Error -and -not $lastError) { $lastError = $reportRun.Error }

    # --- Persist final state and heartbeat ------------------------------------------
    & $saveState

    $heartbeat = [pscustomobject][ordered]@{
        runAt = $runAtIso
        runbookVersion = $runbookVersion
        identityPrincipalId = $heartbeatIdentity
        jobId          = $heartbeatJobId
        configVersion = $configVersion
        configHash = $configHash
        alertsHash = $alertsHash
        alertsSource = $alertsSource
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
    # A results container that cannot be read (missing role or container) would otherwise stop
    # cloud backup alerts silently; failing the job raises the Azure Monitor alert instead.
    if ($outcomeRead.Error) { throw "$($outcomeRead.Error) Run the watcher setup again to grant access to tenuvault-backup-results." }
    if ($newlyExhausted.Count -gt 0) { throw "A notification destination exhausted its retries and its events need attention: $($newlyExhausted -join '; ')" }
} catch {
    $lastError = Get-TvSafeError $_.Exception.Message
    if ($leaseId -and $storageToken -and $heartbeatBlobUri) {
        try {
            $failedHeartbeat = [pscustomobject][ordered]@{
                runAt = $runAtIso
                runbookVersion = $runbookVersion
                identityPrincipalId = $heartbeatIdentity
                jobId          = $heartbeatJobId
                configVersion = $configVersion
                configHash = $configHash
                alertsHash = $alertsHash
                alertsSource = $alertsSource
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



