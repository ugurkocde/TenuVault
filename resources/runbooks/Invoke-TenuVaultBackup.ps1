<#
.SYNOPSIS
    Azure Automation runbook that backs up Microsoft Intune on a schedule, with no admin signed in.

.DESCRIPTION
    Runs in an Azure Automation account in the customer tenant with a system assigned managed
    identity. Each run reads the Intune configuration through Microsoft Graph (beta) with read-only
    application permissions and writes one backup folder to the intune-backups container of the
    customer's own storage account, in exactly the format the TenuVault desktop app writes:
    one JSON file per object under a folder per type, a .tenuvault-owner.json claim written first,
    and a metadata.json summary with per item fingerprints, so Backup History, compare, drift
    detection and restore treat cloud backups like desktop backups.

    Every blob is written as plain JSON (application/json), like the desktop app writes to Azure.
    TenuVault does not encrypt backups in the customer's storage account: Azure encrypts it at rest,
    and Azure role assignments decide who can read it. Anyone who can write to intune-backups is
    trusted like an Intune admin. Runbooks before 1.2.0 sealed every blob with the TVAZ1 envelope
    and the recovery key from Key Vault; the desktop app still opens those backups with the
    recovery key. This runbook has no key and needs no Key Vault: it never changes an existing
    blob, and the only ones it reads are earlier plain backups of the tenant, for the opt-in change
    report. Sealed backups are recognised by their first bytes and skipped, never opened.

    The type table below mirrors src/shared/intune/registry.ts in the desktop app (paths, expands,
    selects, extras, the singleton and the built-in skips). test/cloud-backup-runbook.test.ts
    fails when the two drift apart. Encrypted OMA-URI values are handled like the desktop Backup
    Reader: Microsoft documents DeviceManagementConfiguration.Read.All as enough to read them in
    plain text, and a refused read keeps the masked value (****), records MaskedSecretItems, and the profile is not restorable from this
    backup until a backup with an admin's sign-in captures it.

    The runbook deletes nothing. Retention is applied by the next desktop backup made with an
    admin's sign-in. An age-based lifecycle rule on the container is no substitute: it keeps none
    of the desktop protections (newest backup kept, failed runs never counted). A per tenant
    cloud-backup-status-<tenant>.json blob in the container records the last run so the desktop
    app can show cloud status without opening the Automation account.

    Configuration comes from Automation variables (environment variables of the same name are
    accepted outside Azure Automation so the flow can be exercised locally):
      TenuVaultTenantId          Entra tenant id (GUID) to back up. Required.
      TenuVaultStorageAccount    Storage account holding the intune-backups container. Required.
      TenuVaultScope             "everything" (default when unset) or "policies" (leave out Apps).
      TenuVaultExcludedFolders   Comma separated type folders to leave out; wins over the scope.
      TenuVaultAppOnlyExcluded   Comma separated folders the managed identity has no permission
                                 for by design (setup sets DeviceCategories,DeviceCleanupRules
                                 unless the device inventory permission was granted).
      TenuVaultChangeReport      "off" (default when unset), "names" or "full": after a complete
                                 backup, leave a change report for the notification watcher.
      TenuVaultChangeReportActors "false" leaves out who made each change.
      TenuVaultTenantName        The tenant's name in change reports; the tenant id without it.
    TenuVaultKeyVault, set by setups before 1.2.0, is no longer read.

    Dot source the file with -LibraryOnly to load the library functions without running a backup.
#>
[CmdletBinding()]
param(
    [switch]$LibraryOnly,
    # Which tenant's Automation variables to read: variables are read with this suffix first
    # (TenuVaultTenantId-<key>), then plain. One account serves the Entra tenant its managed
    # identity belongs to; the suffix keeps that tenant's variable set distinctly named.
    [string]$TenantKey = ""
)

$script:RunbookVersion = "1.3.0"
$script:GraphBeta = "https://graph.microsoft.com/beta"
$script:Container = "intune-backups"
# One status blob per tenant, so status blobs never collide when tenants share tooling.
$script:StatusBlobPrefix = "cloud-backup-status-"
$script:OriginalFolders = @("DeviceConfigurations", "CompliancePolicies", "ConfigurationPolicies", "GroupPolicyConfigurations")
# The Entra Conditional Access service is opt-in, like in the desktop app: set the Automation variable
# TenuVaultIncludeConditionalAccess to "true" and grant the managed identity Policy.Read.All.
$script:ConditionalAccessFolders = @("NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies")

# ---------------------------------------------------------------------------
# Small helpers
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

function Set-TvProp {
    param([Parameter(Mandatory)][object]$InputObject, [Parameter(Mandatory)][string]$Name, [object]$Value)
    if ($InputObject -is [System.Collections.IDictionary]) { $InputObject[$Name] = $Value; return }
    $prop = $InputObject.PSObject.Properties[$Name]
    if ($prop) { $prop.Value = $Value } else { $InputObject | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Remove-TvProp {
    param([Parameter(Mandatory)][object]$InputObject, [Parameter(Mandatory)][string]$Name)
    if ($InputObject -is [System.Collections.IDictionary]) { [void]$InputObject.Remove($Name); return }
    $InputObject.PSObject.Properties.Remove($Name)
}

function Get-TvSafeError {
    param([object]$Value)
    $text = [string]$Value -replace "https?://\S+", "[url]"
    $text = $text -replace "[\x00-\x1F\x7F]+", " "
    $text = ($text -replace "\s+", " ").Trim()
    if ($text.Length -gt 500) { $text = $text.Substring(0, 500) }
    return $text
}

function ConvertTo-TvFolderTimestamp {
    param([Parameter(Mandatory)][DateTime]$Utc)
    return $Utc.ToString("yyyy-MM-dd-HHmmss", [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-TvDisplayTime {
    param([Parameter(Mandatory)][DateTime]$Utc)
    return $Utc.ToString("yyyy-MM-dd HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
}

# Same rules as safeFileName in the desktop backup engine.
function Get-TvSafeFileName {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Name)
    $safe = $Name -replace '[<>:"/\\|?*\x00-\x1f]', "_"
    $safe = ($safe -replace "\s+", " ").Trim()
    if ($safe.Length -gt 200) { $safe = $safe.Substring(0, 200) }
    if (-not $safe) { $safe = "unnamed" }
    return $safe
}

# Same rules as uniqueName in the desktop backup engine.
function Get-TvUniqueName {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$Used)
    if (-not $Used.Contains($Name.ToLowerInvariant())) { [void]$Used.Add($Name.ToLowerInvariant()); return $Name }
    $short = if ($Id.Length -ge 8) { $Id.Substring(0, 8) } else { $Id }
    foreach ($candidate in @("$Name ($short)", "$Name ($(Get-TvSafeFileName $Id))")) {
        if (-not $Used.Contains($candidate.ToLowerInvariant())) { [void]$Used.Add($candidate.ToLowerInvariant()); return $candidate }
    }
    for ($n = 2; ; $n++) {
        $candidate = "$Name ($n)"
        if (-not $Used.Contains($candidate.ToLowerInvariant())) { [void]$Used.Add($candidate.ToLowerInvariant()); return $candidate }
    }
}

# ---------------------------------------------------------------------------
# Canonical JSON and fingerprints (mirror comparableSnapshot and snapshotHash)
# ---------------------------------------------------------------------------

$script:VolatileKeys = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@("lastModifiedDateTime", "createdDateTime", "modifiedDateTime", "version", "secretReferenceValueId"))

function Test-TvVolatileKey {
    param([Parameter(Mandatory)][string]$Key)
    return $script:VolatileKeys.Contains($Key) -or $Key -eq "@odata.context" -or
        $Key.EndsWith("@odata.context") -or $Key.EndsWith("@odata.nextLink") -or $Key -eq "__proto__"
}

function ConvertTo-TvJsonString {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { return '""' }
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
                if ([int]$char -lt 0x20) { [void]$sb.Append(("\u{0:x4}" -f [int]$char)) } else { [void]$sb.Append($char) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-TvCanonicalJson {
    param([object]$Value, [switch]$Comparable)
    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
    if ($Value -is [string]) { return ConvertTo-TvJsonString $Value }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [System.Collections.IDictionary]) {
        $parts = @($Value | ForEach-Object { ConvertTo-TvCanonicalJson $_ -Comparable:$Comparable })
        return "[" + ($parts -join ",") + "]"
    }
    if ($Value -is [ValueType]) {
        # Numbers: integers stay integers, anything else uses the shortest round trip form,
        # which is what JSON.stringify produces for the values Intune returns.
        if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
            return ([double]$Value).ToString("R", [Globalization.CultureInfo]::InvariantCulture)
        }
        return ([Int64]$Value).ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    $entries = @()
    if ($Value -is [System.Collections.IDictionary]) {
        $entries = @($Value.GetEnumerator() | ForEach-Object { @{ Key = [string]$_.Key; Value = $_.Value } })
    } else {
        $entries = @($Value.PSObject.Properties | ForEach-Object { @{ Key = $_.Name; Value = $_.Value } })
    }
    if ($Comparable) { $entries = @($entries | Where-Object { -not (Test-TvVolatileKey $_.Key) }) }
    # Keys sort by code unit, like the desktop app's Object.keys().sort(). PowerShell's
    # Sort-Object compares culture aware, which reorders keys such as enableRestrictEditing
    # and enabledSkipKeys and would give the same object a different fingerprint.
    $keys = [string[]]@($entries | ForEach-Object { $_.Key })
    [Array]::Sort($keys, [StringComparer]::Ordinal)
    $byKey = @{}
    foreach ($entry in $entries) { $byKey[$entry.Key] = $entry.Value }
    $entries = @($keys | ForEach-Object { @{ Key = $_; Value = $byKey[$_] } })
    $parts = @($entries | ForEach-Object { (ConvertTo-TvJsonString $_.Key) + ":" + (ConvertTo-TvCanonicalJson $_.Value -Comparable:$Comparable) })
    return "{" + ($parts -join ",") + "}"
}

# SHA256 of the comparable snapshot, base64, first 22 characters, like snapshotHash.
function Get-TvSnapshotHash {
    param([Parameter(Mandatory)][object]$Snapshot)
    $json = ConvertTo-TvCanonicalJson $Snapshot -Comparable
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)) } finally { $sha.Dispose() }
    return [Convert]::ToBase64String($hash).Substring(0, 22)
}

function Copy-TvDeep {
    param([Parameter(Mandatory)][object]$Value)
    return ConvertFrom-TvJson ($Value | ConvertTo-Json -Depth 100)
}

# ---------------------------------------------------------------------------
# JSON parsing without PowerShell's date conversion. ConvertFrom-Json in the
# Automation 7.2 runtime turns ISO strings into [DateTime] values, which both
# breaks hashing and rewrites dates in a culture format when written back.
# System.Text.Json keeps every string exactly as Microsoft Graph sent it.
# Objects become ordered dictionaries, which Get-TvProp and friends understand.
# ---------------------------------------------------------------------------

function ConvertFrom-TvJsonElement {
    param([Parameter(Mandatory)][System.Text.Json.JsonElement]$Element)
    switch ($Element.ValueKind) {
        ([System.Text.Json.JsonValueKind]::Object) {
            $object = [ordered]@{}
            foreach ($property in $Element.EnumerateObject()) {
                $object[$property.Name] = ConvertFrom-TvJsonElement $property.Value
            }
            return $object
        }
        ([System.Text.Json.JsonValueKind]::Array) {
            $items = [System.Collections.Generic.List[object]]::new()
            foreach ($item in $Element.EnumerateArray()) { $items.Add((ConvertFrom-TvJsonElement $item)) }
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

function ConvertFrom-TvJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $document = [System.Text.Json.JsonDocument]::Parse($Text)
    try { return ConvertFrom-TvJsonElement $document.RootElement } finally { $document.Dispose() }
}

# The property names of a parsed object, in document order.
function Get-TvKeys {
    param([Parameter(Mandatory)][object]$InputObject)
    if ($InputObject -is [System.Collections.IDictionary]) { return @($InputObject.Keys) }
    return @($InputObject.PSObject.Properties.Name)
}

# ---------------------------------------------------------------------------
# Tokens and configuration
# ---------------------------------------------------------------------------

function Get-TvManagedIdentityToken {
    param([Parameter(Mandatory)][string]$Resource)
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
    $names = if ($TenantKey) { @("$Name-$TenantKey", $Name) } else { @($Name) }
    foreach ($candidate in $names) {
        if (Get-Command Get-AutomationVariable -ErrorAction SilentlyContinue) {
            try {
                $value = Get-AutomationVariable -Name $candidate -ErrorAction Stop
                if ($null -ne $value -and "$value" -ne "") { return [string]$value }
            } catch { }
        }
        $envValue = [Environment]::GetEnvironmentVariable($candidate)
        if ($envValue) { return $envValue }
    }
    return $null
}

function Get-TvRequiredVariable {
    param([Parameter(Mandatory)][string]$Name)
    $value = Get-TvAutomationVariable $Name
    if (-not $value) { throw "Automation variable $Name is not set. Run New-TenuVaultCloudBackup.ps1 again." }
    return $value
}

function Get-TvFolderList {
    param([AllowNull()][string]$Value)
    if (-not $Value) { return @() }
    return @($Value -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# ---------------------------------------------------------------------------
# HTTP with the retries the desktop engine applies: 3 attempts, Retry-After honored
# ---------------------------------------------------------------------------

$script:HttpClient = [System.Net.Http.HttpClient]::new()
$script:HttpClient.Timeout = [TimeSpan]::FromSeconds(90)

class TvHttpError : System.Exception {
    [int]$Status
    TvHttpError([int]$status, [string]$message) : base($message) { $this.Status = $status }
}

# A response body larger than the cap the caller set; it is never buffered past the cap.
class TvOversizedError : System.Exception {
    TvOversizedError([string]$message) : base($message) { }
}

# A response body that did not arrive in time. HttpClient.Timeout ends once the headers are read
# (ResponseHeadersRead), so the body has a deadline of its own.
class TvReadTimeoutError : System.Exception {
    TvReadTimeoutError([string]$message) : base($message) { }
}

# How long one capped response body may take to arrive, in seconds.
$script:BodyReadSeconds = 90
# The most of an error response body read with a capped request: only its error text is used.
$script:ErrorBodyMaxBytes = 65536

# Reads a successful response body up to $MaxBytes, by its declared length first and then by the
# bytes actually read, so a large or endless body cannot exhaust the sandbox's memory, and within
# $script:BodyReadSeconds, so a stalled body cannot hang the run. Each read is a Stream.ReadAsync
# with a CancellationToken, waited for with Task.Wait(timeout); on the deadline the token is
# cancelled and the response disposed, which ends the pending read. All of these exist in .NET
# Framework 4.7.2 and in .NET for PowerShell 7.
function Read-TvCappedBody {
    param([Parameter(Mandatory)][System.Net.Http.HttpResponseMessage]$Response, [Parameter(Mandatory)][long]$MaxBytes)
    $declared = $Response.Content.Headers.ContentLength
    if ($null -ne $declared -and $declared -gt $MaxBytes) { throw [TvOversizedError]::new("The response is larger than $MaxBytes bytes.") }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $deadline = [TimeSpan]::FromSeconds($script:BodyReadSeconds)
    $cancel = [System.Threading.CancellationTokenSource]::new()
    $stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = [byte[]]::new(81920)
    $memory = [System.IO.MemoryStream]::new()
    try {
        while ($true) {
            $left = $deadline - $clock.Elapsed
            $read = $null
            if ($left -gt [TimeSpan]::Zero) {
                $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
                if (-not $read.Wait($left)) { $read = $null }
            }
            if ($null -eq $read) {
                $cancel.Cancel()
                $Response.Dispose()
                throw [TvReadTimeoutError]::new("The response did not arrive within $($script:BodyReadSeconds) seconds.")
            }
            $count = $read.Result
            if ($count -le 0) { break }
            if ($memory.Length + $count -gt $MaxBytes) { throw [TvOversizedError]::new("The response is larger than $MaxBytes bytes.") }
            $memory.Write($buffer, 0, $count)
        }
        return , $memory.ToArray()
    } finally {
        $stream.Dispose()
        $memory.Dispose()
        $cancel.Dispose()
    }
}

function Invoke-TvHttp {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [string]$Method = "Get",
        [hashtable]$Headers,
        [byte[]]$BodyBytes,
        [string]$ContentType,
        # A cap on the response body in bytes; 0 reads it whole. Over the cap: TvOversizedError.
        [long]$MaxBytes = 0
    )
    $lastError = $null
    foreach ($attempt in 1..3) {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $Token)
        if ($Headers) { foreach ($name in $Headers.Keys) { [void]$request.Headers.TryAddWithoutValidation($name, [string]$Headers[$name]) } }
        if ($null -ne $BodyBytes) {
            $content = [System.Net.Http.ByteArrayContent]::new($BodyBytes)
            if ($ContentType) { $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType) }
            $request.Content = $content
        }
        $response = $null
        $completion = if ($MaxBytes -gt 0) { [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead } else { [System.Net.Http.HttpCompletionOption]::ResponseContentRead }
        try { $response = $script:HttpClient.SendAsync($request, $completion).GetAwaiter().GetResult() }
        catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Seconds $attempt; continue }
            throw [TvHttpError]::new(0, (Get-TvSafeError $_.Exception.Message))
        }
        $status = [int]$response.StatusCode
        $retryAfter = if ($response.Headers.RetryAfter -and $response.Headers.RetryAfter.Delta) { $response.Headers.RetryAfter.Delta } else { $null }
        try {
            if ($MaxBytes -gt 0) {
                if ($status -ge 200 -and $status -lt 300) {
                    $bytes = Read-TvCappedBody $response $MaxBytes
                    return @{ Status = $status; Bytes = $bytes; Text = [Text.Encoding]::UTF8.GetString($bytes) }
                }
                # Only the error text is needed: the same reader with a small cap and the same
                # deadline, so a stalled or large error body can neither hang nor exhaust the run.
                try { $bytes = Read-TvCappedBody $response $script:ErrorBodyMaxBytes }
                catch [TvOversizedError] { $bytes = [byte[]]@() }
                catch [TvReadTimeoutError] { $bytes = [byte[]]@() }
            } else {
                $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                if ($status -ge 200 -and $status -lt 300) {
                    return @{ Status = $status; Bytes = $bytes; Text = [Text.Encoding]::UTF8.GetString($bytes) }
                }
            }
        } finally {
            $response.Dispose()
        }
        $retryable = $status -in @(429, 500, 502, 503, 504)
        $message = "HTTP $status"
        $bodyText = [Text.Encoding]::UTF8.GetString($bytes)
        try {
            $parsed = $bodyText | ConvertFrom-Json -ErrorAction Stop
            $detail = Get-TvProp (Get-TvProp $parsed "error") "message"
            if ($detail) { $message = "HTTP $status $($detail)" }
        } catch {
            # Azure Storage answers errors as XML, not JSON.
            $code = [regex]::Match($bodyText, "<Code>([^<]+)</Code>").Groups[1].Value
            if ($code) { $message = "HTTP $status $code" }
        }
        $lastError = [TvHttpError]::new($status, (Get-TvSafeError $message))
        if ($retryable -and $attempt -lt 3) {
            $delay = $attempt
            if ($retryAfter) { $delay = [Math]::Ceiling($retryAfter.TotalSeconds) }
            if ($delay -gt 300) { throw $lastError }
            Start-Sleep -Seconds ([Math]::Max(1, $delay))
            continue
        }
        throw $lastError
    }
    throw $lastError
}

# ---------------------------------------------------------------------------
# Storage writes, plain JSON. Blobs are only created or replaced; the change report reads earlier
# plain backups with Read-TvPlainJson.
# ---------------------------------------------------------------------------

function Get-TvBlobTarget {
    param([Parameter(Mandatory)][string]$Account, [Parameter(Mandatory)][string]$BlobName)
    $encoded = ($BlobName -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
    return @{ Uri = "https://$Account.blob.core.windows.net/$script:Container/$encoded" }
}

function Set-TvBlob {
    param(
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$BlobName,
        [Parameter(Mandatory)][string]$Body,
        [Parameter(Mandatory)][string]$Token,
        [switch]$CreateOnly
    )
    $target = Get-TvBlobTarget $Account $BlobName
    $headers = @{
        "x-ms-blob-type" = "BlockBlob"
        "x-ms-version"   = "2021-12-02"
        "x-ms-date"      = [DateTime]::UtcNow.ToString("R", [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($CreateOnly) { $headers["If-None-Match"] = "*" }
    [void](Invoke-TvHttp -Uri $target.Uri -Token $Token -Method "Put" -Headers $headers -BodyBytes ([Text.Encoding]::UTF8.GetBytes($Body)) -ContentType "application/json")
}

# ---------------------------------------------------------------------------
# The result note for the notification watcher (mirror src/shared/notifications/cloud-outcome.ts)
# ---------------------------------------------------------------------------
# The notification watcher never opens backups or the status blob: backups from runbooks
# before 1.2.0 are sealed with the recovery key, which it never has, and policy content stays
# out of its reach. So it alerts on this note. The note goes to a container of its
# own, never to intune-backups and never to the watcher's state container (where this
# identity could otherwise rewrite the watcher's state), and carries a fixed set of fields: status, folder
# name, counts, failed type names, run id and time. No policy content, names or messages.
# It is best effort: a missing container (no watcher set up) or a missing role never
# changes the backup's own result.

$script:OutcomeContainer = "tenuvault-backup-results"
$script:OutcomeSent = $false

function Send-TvBackupOutcome {
    param(
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][ValidateSet("Success", "CompletedWithWarnings", "Failed")][string]$Status,
        [AllowNull()][string]$BackupFolder,
        [AllowNull()][object]$TotalPolicies,
        [int]$Failures = 0,
        [string[]]$FailedTypes = @()
    )
    # One note per run: the failure path can follow a Failed result that was already noted.
    if ($script:OutcomeSent) { return }
    $script:OutcomeSent = $true
    $note = [ordered]@{
        schema        = "tenuvault.cloud-backup-outcome/v1"
        tenantId      = $TenantId.ToLowerInvariant()
        runId         = $RunId
        status        = $Status
        backupFolder  = if ($BackupFolder) { $BackupFolder } else { $null }
        finishedAt    = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
        totalPolicies = if ($null -ne $TotalPolicies) { [int]$TotalPolicies } else { $null }
        failures      = [int]$Failures
        failedTypes   = @($FailedTypes | Where-Object { $_ } | Select-Object -First 10 | ForEach-Object { [string]$_ })
    }
    $name = if ($BackupFolder) { $BackupFolder } else { "run-$RunId" }
    $uri = "https://$Account.blob.core.windows.net/$script:OutcomeContainer/cloud-backup-outcomes/$([uri]::EscapeDataString($name)).json"
    $headers = @{
        "x-ms-blob-type" = "BlockBlob"
        "x-ms-version"   = "2021-12-02"
        "x-ms-date"      = [DateTime]::UtcNow.ToString("R", [Globalization.CultureInfo]::InvariantCulture)
        "If-None-Match"  = "*"
    }
    try {
        $body = [Text.Encoding]::UTF8.GetBytes(($note | ConvertTo-Json -Compress))
        [void](Invoke-TvHttp -Uri $uri -Token $Token -Method "Put" -Headers $headers -BodyBytes $body -ContentType "application/json")
        Write-Output "Left the result ($Status) for the notification watcher."
    } catch [TvHttpError] {
        $code = $_.Exception.Status
        if ($code -eq 404) { Write-Output "No $script:OutcomeContainer container in this storage account, so no backup alert is sent. Run the cloud backup setup again to create it." }
        elseif ($code -eq 403) { Write-Output "The cloud backup identity cannot write to $script:OutcomeContainer, so no backup alert is sent. Run the cloud backup setup again to grant it." }
        elseif ($code -in @(409, 412)) { Write-Output "The result for this backup was already left for the notification watcher." }
        else { Write-Output "Could not leave the result for the notification watcher: $(Get-TvSafeError $_.Exception.Message)" }
    } catch {
        Write-Output "Could not leave the result for the notification watcher: $(Get-TvSafeError $_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Microsoft Graph reads (mirror src/shared/intune/read.ts)
# ---------------------------------------------------------------------------

function Get-TvGraphUrl {
    param([Parameter(Mandatory)][string]$Path)
    if ($Path.StartsWith("https://")) {
        if (-not ([uri]$Path).Host.Equals("graph.microsoft.com")) { throw "Invalid Graph continuation link" }
        return $Path
    }
    return "$script:GraphBeta/$Path"
}

function Invoke-TvGraphGet {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Token)
    $result = Invoke-TvHttp -Uri (Get-TvGraphUrl $Path) -Token $Token -Method "Get" -Headers @{ Accept = "application/json" }
    return ConvertFrom-TvJson $result.Text
}

function Invoke-TvGraphList {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Token)
    $items = [System.Collections.Generic.List[object]]::new()
    $next = Get-TvGraphUrl $Path
    $pages = 0
    while ($next) {
        if (++$pages -gt 1000) { throw "Graph listing did not finish after 1000 pages: $Path" }
        $page = Invoke-TvGraphGet $next $Token
        foreach ($item in @(Get-TvProp $page "value")) { if ($null -ne $item) { $items.Add($item) } }
        $next = Get-TvProp $page "@odata.nextLink"
    }
    return $items
}

function Get-TvDetailPath {
    param([Parameter(Mandatory)][hashtable]$Type, [Parameter(Mandatory)][string]$Id)
    if ($Type.Singleton) { return [string]$Type.Path }
    $query = @()
    if ($Type.Expand) { $query += "`$expand=$($Type.Expand)" }
    if ($Type.Select) { $query += "`$select=$($Type.Select)" }
    $path = "$($Type.Path)/$([uri]::EscapeDataString($Id))"
    if ($query.Count) { $path += "?" + ($query -join "&") }
    return $path
}

# The encrypted OMA-URI settings of a device configuration profile, like the registry secrets.
function Get-TvEncryptedOmaSettings {
    param([Parameter(Mandatory)][object]$Detail)
    $settings = Get-TvProp $Detail "omaSettings"
    if ($null -eq $settings) { return @() }
    return @($settings | Where-Object {
        (Get-TvProp $_ "isEncrypted") -eq $true -and (Get-TvProp $_ "secretReferenceValueId") -is [string]
    })
}

function Read-TvObject {
    param(
        [Parameter(Mandatory)][hashtable]$Type,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][hashtable]$Outcome
    )
    $detail = Invoke-TvGraphGet (Get-TvDetailPath $Type $Id) $Token
    if ($Type.Singleton) {
        $snapshot = [ordered]@{ id = $Type.Singleton.Id }
        foreach ($key in $Type.Singleton.Properties) {
            if (($detail -is [System.Collections.IDictionary] -and $detail.Contains($key)) -or $detail.PSObject.Properties[$key]) {
                $snapshot[$key] = Get-TvProp $detail $key
            }
        }
        return $snapshot
    }
    # Large expanded collections page like lists.
    foreach ($key in @(Get-TvKeys $detail)) {
        $value = Get-TvProp $detail $key
        if ($key.EndsWith("@odata.nextLink") -and $value -is [string]) {
            $property = $key.Substring(0, $key.Length - "@odata.nextLink".Length)
            $existing = @(Get-TvProp $detail $property)
            $more = Invoke-TvGraphList $value $Token
            Set-TvProp $detail $property @($existing + $more)
            Remove-TvProp $detail $key
        }
    }
    $encodedId = [uri]::EscapeDataString($Id)
    foreach ($extra in $Type.Extras) {
        $extraPath = ([string]$extra.Template).Replace("{id}", $encodedId)
        if ($extra.Single) {
            $one = Invoke-TvGraphGet $extraPath $Token
            Set-TvProp $detail $extra.Property (Get-TvProp $one $extra.Property)
            continue
        }
        $entries = Invoke-TvGraphList $extraPath $Token
        if ($extra.Each) {
            foreach ($entry in $entries) {
                $entryPath = ([string]$extra.Each.Template).Replace("{id}", $encodedId).Replace("{entryId}", [uri]::EscapeDataString([string](Get-TvProp $entry "id")))
                if ($extra.Each.Property) {
                    Set-TvProp $entry $extra.Each.Property @(Invoke-TvGraphList $entryPath $Token)
                } else {
                    $full = Invoke-TvGraphGet $entryPath $Token
                    foreach ($k in @(Get-TvKeys $full)) { if ($k -ne "@odata.context") { Set-TvProp $entry $k (Get-TvProp $full $k) } }
                }
            }
        }
        Set-TvProp $detail $extra.Property @($entries)
    }
    if ($Type.HasSecrets) {
        foreach ($setting in Get-TvEncryptedOmaSettings $detail) {
            $reference = ([string](Get-TvProp $setting "secretReferenceValueId")).Replace("'", "''")
            $secretPath = "deviceManagement/deviceConfigurations/$encodedId/getOmaSettingPlainTextValue(secretReferenceValueId='$([uri]::EscapeDataString($reference))')"
            try {
                $plain = Invoke-TvGraphGet $secretPath $Token
                $value = Get-TvProp $plain "value"
                if ($value -isnot [string]) { throw "Microsoft Graph did not return an encrypted setting's value" }
                Set-TvProp $setting "value" $value
            } catch [TvHttpError] {
                if ($_.Exception.Status -ne 403) { throw }
                # Microsoft refused the plain-text read: keep the masked value, like the Backup Reader.
                Set-TvProp $setting "value" "****"
                $Outcome.Masked = $true
            }
        }
    }
    Remove-TvProp $detail "@odata.context"
    return $detail
}

# The snapshot as a read that could not decrypt masked values stores it, or $null, like withMaskedSecrets.
function Get-TvMaskedView {
    param([Parameter(Mandatory)][object]$Detail)
    if (-not (Get-TvEncryptedOmaSettings $Detail).Count) { return $null }
    $copy = Copy-TvDeep $Detail
    foreach ($setting in Get-TvEncryptedOmaSettings $copy) { Set-TvProp $setting "value" "****" }
    return $copy
}

# Built-in objects Intune recreates itself, like the registry skip functions.
function Test-TvSkipped {
    param([Parameter(Mandatory)][hashtable]$Type, [Parameter(Mandatory)][object]$Item)
    switch ([string]$Type.Folder) {
        "Remediations" { return (Get-TvProp $Item "isGlobalScript") -eq $true }
        "AppCategories" { return ([string](Get-TvProp $Item "lastModifiedDateTime")).StartsWith("0001-01-01") }
        "ScopeTags" { return (Get-TvProp $Item "isBuiltIn") -eq $true }
        "RoleDefinitions" { return (Get-TvProp $Item "isBuiltIn") -eq $true }
        "AuthenticationStrengths" { return (Get-TvProp $Item "policyType") -eq "builtIn" }
        default { return $false }
    }
}

function Get-TvItemName {
    param([Parameter(Mandatory)][hashtable]$Type, [Parameter(Mandatory)][object]$Item)
    if ($Type.Singleton) { return [string]$Type.Singleton.Name }
    foreach ($key in @([string]$Type.NameKey, "displayName", "name", "id")) {
        $value = Get-TvProp $Item $key
        if ($value) { return [string]$value }
    }
    return "unnamed"
}

# ---------------------------------------------------------------------------
# The type table, generated from src/shared/intune/registry.ts. A test keeps it in step.
# ---------------------------------------------------------------------------

function Get-TvTypes {
    return @(
    @{ Folder = 'DeviceConfigurations'; Label = 'device configuration profiles'; Path = 'deviceManagement/deviceConfigurations'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $true; Singleton = $null; Extras = @() }
    @{ Folder = 'ConfigurationPolicies'; Label = 'settings catalog and endpoint security policies'; Path = 'deviceManagement/configurationPolicies'; NameKey = 'name'; Expand = 'settings'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $true; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'assignments'; Single = $false; Template = 'deviceManagement/configurationPolicies/{id}/assignments'; Each = $null }) }
    @{ Folder = 'GroupPolicyConfigurations'; Label = 'administrative templates'; Path = 'deviceManagement/groupPolicyConfigurations'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'definitionValues'; Single = $false; Template = 'deviceManagement/groupPolicyConfigurations/{id}/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)'; Each = @{ Property = 'presentationValues'; Template = 'deviceManagement/groupPolicyConfigurations/{id}/definitionValues/{entryId}/presentationValues?$expand=presentation($select=id,label)' } }) }
    @{ Folder = 'ReusablePolicySettings'; Label = 'reusable settings'; Path = 'deviceManagement/reusablePolicySettings'; NameKey = 'displayName'; Expand = $null; Select = 'id,displayName,description,settingDefinitionId,settingInstance,createdDateTime,lastModifiedDateTime,version,referencingConfigurationPolicyCount'; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'HardwareConfigurations'; Label = 'BIOS configurations'; Path = 'deviceManagement/hardwareConfigurations'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'CompliancePolicies'; Label = 'compliance policies'; Path = 'deviceManagement/deviceCompliancePolicies'; NameKey = 'displayName'; Expand = 'scheduledActionsForRule($expand=scheduledActionConfigurations),assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'ComplianceSettingsPolicies'; Label = 'settings catalog compliance policies'; Path = 'deviceManagement/compliancePolicies'; NameKey = 'name'; Expand = 'settings'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $true; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'scheduledActionsForRule'; Single = $false; Template = 'deviceManagement/compliancePolicies/{id}/scheduledActionsForRule?$expand=scheduledActionConfigurations'; Each = $null }; @{ Property = 'assignments'; Single = $false; Template = 'deviceManagement/compliancePolicies/{id}/assignments'; Each = $null }) }
    @{ Folder = 'ComplianceScripts'; Label = 'compliance scripts'; Path = 'deviceManagement/deviceComplianceScripts'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'CompliancePolicySettings'; Label = 'compliance policy settings'; Path = 'deviceManagement/settings'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = @{ Id = 'CompliancePolicySettings'; Name = 'Compliance policy settings'; Properties = @('secureByDefault','deviceComplianceCheckinThresholdDays','isScheduledActionEnabled','enhancedJailBreak') }; Extras = @() }
    @{ Folder = 'EndpointSecurityIntents'; Label = 'security baselines and template profiles'; Path = 'deviceManagement/intents'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'settings'; Single = $false; Template = 'deviceManagement/intents/{id}/settings'; Each = $null }; @{ Property = 'assignments'; Single = $false; Template = 'deviceManagement/intents/{id}/assignments'; Each = $null }) }
    @{ Folder = 'PowerShellScripts'; Label = 'Windows PowerShell scripts'; Path = 'deviceManagement/deviceManagementScripts'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'ShellScripts'; Label = 'macOS shell scripts'; Path = 'deviceManagement/deviceShellScripts'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'CustomAttributeScripts'; Label = 'macOS custom attributes'; Path = 'deviceManagement/deviceCustomAttributeShellScripts'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'Remediations'; Label = 'remediations'; Path = 'deviceManagement/deviceHealthScripts'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'FeatureUpdateProfiles'; Label = 'feature update profiles'; Path = 'deviceManagement/windowsFeatureUpdateProfiles'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'QualityUpdateProfiles'; Label = 'expedited quality update profiles'; Path = 'deviceManagement/windowsQualityUpdateProfiles'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'QualityUpdatePolicies'; Label = 'hotpatch quality update policies'; Path = 'deviceManagement/windowsQualityUpdatePolicies'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'DriverUpdateProfiles'; Label = 'driver update profiles'; Path = 'deviceManagement/windowsDriverUpdateProfiles'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppCategories'; Label = 'app categories'; Path = 'deviceAppManagement/mobileAppCategories'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'Apps'; Label = 'apps'; Path = 'deviceAppManagement/mobileApps'; NameKey = 'displayName'; Expand = 'assignments,categories'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'relationships'; Single = $false; Template = 'deviceAppManagement/mobileApps/{id}/relationships'; Each = $null }) }
    @{ Folder = 'AppConfigurationPolicies'; Label = 'app configuration policies for managed devices'; Path = 'deviceAppManagement/mobileAppConfigurations'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'ManagedAppConfigurations'; Label = 'app configuration policies for managed apps'; Path = 'deviceAppManagement/targetedManagedAppConfigurations'; NameKey = 'displayName'; Expand = 'apps,assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppProtectionIOS'; Label = 'iOS app protection policies'; Path = 'deviceAppManagement/iosManagedAppProtections'; NameKey = 'displayName'; Expand = 'apps,assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppProtectionAndroid'; Label = 'Android app protection policies'; Path = 'deviceAppManagement/androidManagedAppProtections'; NameKey = 'displayName'; Expand = 'apps,assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppProtectionWindows'; Label = 'Windows app protection policies'; Path = 'deviceAppManagement/windowsManagedAppProtections'; NameKey = 'displayName'; Expand = 'apps,assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'PolicySets'; Label = 'policy sets'; Path = 'deviceAppManagement/policySets'; NameKey = 'displayName'; Expand = 'items,assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'EnrollmentConfigurations'; Label = 'enrollment configurations'; Path = 'deviceManagement/deviceEnrollmentConfigurations'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AutopilotProfiles'; Label = 'Windows Autopilot deployment profiles'; Path = 'deviceManagement/windowsAutopilotDeploymentProfiles'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppleEnrollmentProfiles'; Label = 'Apple user enrollment profiles'; Path = 'deviceManagement/appleUserInitiatedEnrollmentProfiles'; NameKey = 'displayName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AppleAutomatedEnrollment'; Label = 'Apple automated device enrollment tokens and profiles'; Path = 'deviceManagement/depOnboardingSettings'; NameKey = 'tokenName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'enrollmentProfiles'; Single = $false; Template = 'deviceManagement/depOnboardingSettings/{id}/enrollmentProfiles'; Each = $null }) }
    @{ Folder = 'AndroidEnrollmentProfiles'; Label = 'Android Enterprise enrollment profiles'; Path = 'deviceManagement/androidDeviceOwnerEnrollmentProfiles'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'DeviceCategories'; Label = 'device categories'; Path = 'deviceManagement/deviceCategories'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'TermsAndConditions'; Label = 'terms and conditions'; Path = 'deviceManagement/termsAndConditions'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'assignments'; Single = $false; Template = 'deviceManagement/termsAndConditions/{id}/assignments'; Each = $null }) }
    @{ Folder = 'AssignmentFilters'; Label = 'assignment filters'; Path = 'deviceManagement/assignmentFilters'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'ScopeTags'; Label = 'scope tags'; Path = 'deviceManagement/roleScopeTags'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'assignments'; Single = $false; Template = 'deviceManagement/roleScopeTags/{id}/assignments'; Each = $null }) }
    @{ Folder = 'RoleDefinitions'; Label = 'Intune roles'; Path = 'deviceManagement/roleDefinitions'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'roleAssignments'; Single = $false; Template = 'deviceManagement/roleDefinitions/{id}/roleAssignments'; Each = @{ Property = $null; Template = 'deviceManagement/roleAssignments/{entryId}' } }) }
    @{ Folder = 'NotificationTemplates'; Label = 'compliance notification templates'; Path = 'deviceManagement/notificationMessageTemplates'; NameKey = 'displayName'; Expand = 'localizedNotificationMessages'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'Branding'; Label = 'Company Portal branding'; Path = 'deviceManagement/intuneBrandingProfiles'; NameKey = 'profileName'; Expand = 'assignments'; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @(@{ Property = 'themeColorLogo'; Single = $true; Template = 'deviceManagement/intuneBrandingProfiles/{id}?$select=themeColorLogo'; Each = $null }; @{ Property = 'lightBackgroundLogo'; Single = $true; Template = 'deviceManagement/intuneBrandingProfiles/{id}?$select=lightBackgroundLogo'; Each = $null }; @{ Property = 'landingPageCustomizedImage'; Single = $true; Template = 'deviceManagement/intuneBrandingProfiles/{id}?$select=landingPageCustomizedImage'; Each = $null }) }
    @{ Folder = 'DeviceCleanupRules'; Label = 'device clean-up rules'; Path = 'deviceManagement/managedDeviceCleanupRules'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'MultiAdminApprovalPolicies'; Label = 'multi admin approval policies'; Path = 'deviceManagement/operationApprovalPolicies'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'NamedLocations'; Label = 'named locations'; Path = 'identity/conditionalAccess/namedLocations'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'AuthenticationStrengths'; Label = 'authentication strengths'; Path = 'identity/conditionalAccess/authenticationStrength/policies'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    @{ Folder = 'ConditionalAccessPolicies'; Label = 'Conditional Access policies'; Path = 'identity/conditionalAccess/policies'; NameKey = 'displayName'; Expand = $null; Select = $null; ListQuery = $null; AssignmentsFormerlyExpanded = $false; HasSecrets = $false; Singleton = $null; Extras = @() }
    )
}

# ---------------------------------------------------------------------------
# Change reports (mirror src/shared/reports/change-report.ts and change-report-html.ts,
# src/shared/intune/drift-format.ts, and the documentItems path of /api/detect-drifts)
# ---------------------------------------------------------------------------
# After a successful backup, when TenuVaultChangeReport is "names" or "full", the run compares
# this backup with the previous complete backup of the tenant, setting by setting, names who
# made each change from the Intune audit log, and leaves the report for the notification
# watcher to send by email. test/cloud-change-report.test.ts runs these functions and the
# desktop code on the same backups and expects the same report, Markdown, HTML and email.
#
# The previous backup must be plain JSON and positively owned by this tenant (metadata.json or the
# ownership marker names it, like resolveBackupOwnership). Backups sealed before plain Azure
# backups cannot be opened without a key, so they are skipped: the report compares with the
# newest earlier complete plain backup, and when there is none, no report is made and the job
# output says why.
#
# The report is opt-in: it holds policy and setting names (and, with "full", their values) so the
# watcher can send it without opening any backup. Secret values are redacted before anything is
# compared. It goes to the results container next to the result notes and the watcher deletes it
# once sent, or after 7 days.

class TvUndefinedValue { }
# JavaScript's undefined: a property that is missing, as opposed to one that is null.
$script:TvUndefined = [TvUndefinedValue]::new()
$script:TvRedacted = "[redacted]"
$script:ReportPrefix = "cloud-change-reports/"
$script:MaxReportSettings = 300
$script:MaxOtherActivity = 100
$script:MaxValueLength = 600
$script:MaxDefinitions = 500
$script:GenericGroupName = "Top Level Setting Group Collection"

function Test-TvUndef { param([AllowNull()][object]$Value) return $Value -is [TvUndefinedValue] }
function Test-TvJsArray { param([AllowNull()][object]$Value) return ($Value -is [System.Collections.IList]) -and ($Value -isnot [System.Collections.IDictionary]) -and ($Value -isnot [string]) }
function Test-TvJsObject { param([AllowNull()][object]$Value) return ($Value -is [System.Collections.IDictionary]) -or (Test-TvJsArray $Value) }
function Test-TvTruthy { param([AllowNull()][object]$Value) return -not ((Test-TvUndef $Value) -or $null -eq $Value -or ($Value -is [bool] -and -not $Value) -or ($Value -is [string] -and $Value -eq "") -or ((Test-TvJsNumber $Value) -and ([double]$Value -eq 0 -or [double]::IsNaN([double]$Value)))) }
function Test-TvJsNumber { param([AllowNull()][object]$Value) return ($Value -is [int]) -or ($Value -is [long]) -or ($Value -is [double]) -or ($Value -is [decimal]) -or ($Value -is [float]) }

# A property of a parsed object, or undefined when it has none.
function Get-TvMember {
    param([AllowNull()][object]$InputObject, [Parameter(Mandatory)][string]$Name)
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) { return , $InputObject[$Name] }
        return $script:TvUndefined
    }
    if (Test-TvJsArray $InputObject) {
        $index = 0
        if ([int]::TryParse($Name, [ref]$index) -and $index -ge 0 -and $index -lt $InputObject.Count) { return , $InputObject[$index] }
    }
    return $script:TvUndefined
}

# Object.keys: the keys of an object in document order, the indexes of an array.
function Get-TvJsKeys {
    param([AllowNull()][object]$InputObject)
    if ($InputObject -is [System.Collections.IDictionary]) { return , [string[]]@($InputObject.Keys) }
    if ((Test-TvJsArray $InputObject) -and $InputObject.Count -gt 0) { return , [string[]]@(0..($InputObject.Count - 1) | ForEach-Object { [string]$_ }) }
    return , [string[]]@()
}

# String(value) for a number, like JavaScript.
function ConvertTo-TvJsNumber {
    param([Parameter(Mandatory)][object]$Value)
    if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
        $double = [double]$Value
        if ([Math]::Floor($double) -eq $double -and [Math]::Abs($double) -lt 1e15) { return ([Int64]$double).ToString([Globalization.CultureInfo]::InvariantCulture) }
        return $double.ToString("R", [Globalization.CultureInfo]::InvariantCulture)
    }
    return ([Int64]$Value).ToString([Globalization.CultureInfo]::InvariantCulture)
}

# JSON.stringify without indentation, keys in document order. $null for undefined.
function ConvertTo-TvJsJson {
    param([AllowNull()][object]$Value)
    if (Test-TvUndef $Value) { return $null }
    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
    if ($Value -is [string]) { return ConvertTo-TvJsonString $Value }
    if (Test-TvJsNumber $Value) { return ConvertTo-TvJsNumber $Value }
    if (Test-TvJsArray $Value) {
        $parts = foreach ($entry in $Value) { $json = ConvertTo-TvJsJson $entry; if ($null -eq $json) { "null" } else { $json } }
        return "[" + (@($parts) -join ",") + "]"
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = foreach ($key in $Value.Keys) {
            $json = ConvertTo-TvJsJson $Value[$key]
            if ($null -ne $json) { (ConvertTo-TvJsonString ([string]$key)) + ":" + $json }
        }
        return "{" + (@($parts) -join ",") + "}"
    }
    return ConvertTo-TvJsonString ([string]$Value)
}

# String(value) of a scalar, like JavaScript.
function ConvertTo-TvJsString {
    param([AllowNull()][object]$Value)
    if (Test-TvUndef $Value) { return "undefined" }
    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
    if (Test-TvJsNumber $Value) { return ConvertTo-TvJsNumber $Value }
    return [string]$Value
}

# ---------------------------------------------------------------------------
# Secrets (mirror redactSecrets and redactText in src/shared/compliance/export.ts)
# ---------------------------------------------------------------------------

$script:KeyStems = @("apikey", "privatekey", "presharedkey", "sharedkey", "recoverykey", "encryptionkey", "accesskey", "masterkey", "signingkey", "secretkey", "connectionstring")
$script:PasswordModifiers = @("minimum", "maximum", "required", "expiration", "history", "previous", "block", "minutes", "lockout", "agedays", "complexity", "length", "enabled", "encryptionenabled", "encryptionprincipal", "reset", "warning", "quality", "signin", "inactivity")
$script:TokenModifiers = @("lifetime", "expiration", "creation", "expiry", "usagecount", "name", "type")
$script:SecretText = [regex]::new('(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,})|(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})', [Text.RegularExpressions.RegexOptions]::ECMAScript)

function Test-TvSecretKey {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Key)
    $name = $Key.ToLowerInvariant() -creplace '[^a-z0-9]', ''
    if ($name.Contains("secret") -or $name.Contains("credential")) { return $true }
    foreach ($stem in $script:KeyStems) { if ($name.Contains($stem)) { return $true } }
    if ($name -eq "psk" -or $name.EndsWith("psk") -or $name.StartsWith("psk")) { return $true }
    $passwordAt = [Math]::Max($name.IndexOf("password"), $name.IndexOf("passphrase"))
    if ($passwordAt -ge 0) {
        $word = if ($name.Substring($passwordAt).StartsWith("passphrase")) { "passphrase" } else { "password" }
        $after = $name.Substring($passwordAt + $word.Length)
        $modified = $false
        foreach ($modifier in $script:PasswordModifiers) { if ($after.StartsWith($modifier)) { $modified = $true; break } }
        if (-not $modified) { return $true }
    }
    $tokenAt = $name.IndexOf("token")
    if ($tokenAt -ge 0) {
        $after = $name.Substring($tokenAt + 5)
        $modified = $false
        foreach ($modifier in $script:TokenModifiers) { if ($after.StartsWith($modifier)) { $modified = $true; break } }
        if (-not $modified) { return $true }
    }
    return $false
}

function Get-TvRedactedText {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { return "" }
    return $script:SecretText.Replace($Value, $script:TvRedacted)
}

# A deep copy with secrets replaced, like redactSecrets, and the value of every encrypted
# OMA-URI setting too, like reportRedact in the drift route.
function Get-TvReportRedacted {
    param([AllowNull()][object]$Value, [switch]$SecretsOnly)
    if ($Value -is [string]) { if ($SecretsOnly) { return Get-TvRedactedText $Value } else { return $Value } }
    if (Test-TvJsArray $Value) {
        $list = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in $Value) { $list.Add((Get-TvReportRedacted $entry -SecretsOnly:$SecretsOnly)) }
        return , $list.ToArray()
    }
    if ($Value -isnot [System.Collections.IDictionary]) { return , $Value }
    $copy = [ordered]@{}
    if ($SecretsOnly) {
        $type = $Value["@odata.type"]
        $secretValue = ($type -is [string]) -and ($type -match 'SecretSettingValue$')
        foreach ($key in $Value.Keys) {
            $child = $Value[$key]
            if (($secretValue -and $key -ceq "value") -or ((Test-TvSecretKey ([string]$key)) -and $null -ne $child -and $child -isnot [bool])) { $copy[$key] = $script:TvRedacted }
            else { $copy[$key] = Get-TvReportRedacted $child -SecretsOnly }
        }
        return $copy
    }
    $encrypted = $Value.Contains("isEncrypted") -and $Value["isEncrypted"] -eq $true -and $Value["isEncrypted"] -is [bool]
    foreach ($key in $Value.Keys) {
        $child = $Value[$key]
        if ($encrypted -and $key -ceq "value" -and $null -ne $child) { $copy[$key] = $script:TvRedacted }
        else { $copy[$key] = Get-TvReportRedacted $child }
    }
    return $copy
}

function Get-TvReportSafe {
    param([AllowNull()][object]$Value)
    return Get-TvReportRedacted (Get-TvReportRedacted $Value) -SecretsOnly
}

# ---------------------------------------------------------------------------
# Comparison (mirror compareObjects, documentItem and redactedChanges in /api/detect-drifts)
# ---------------------------------------------------------------------------

$script:CompareSkipped = [System.Collections.Generic.HashSet[string]]::new([string[]]@('@odata.context', 'lastModifiedDateTime', 'createdDateTime', 'modifiedDateTime', 'id', 'version', 'description', 'settings@odata.context', 'secretReferenceValueId'))

# skippedKey: fields the comparison leaves out, annotations included.
function Test-TvSkippedKey {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Key)
    return $script:CompareSkipped.Contains($Key) -or $Key.EndsWith("@odata.context", [StringComparison]::Ordinal) -or $Key.EndsWith("@odata.nextLink", [StringComparison]::Ordinal)
}

# canonical: key order independent text of one value without the skipped fields, for spotting
# unchanged items in unkeyed arrays.
function ConvertTo-TvCanonicalText {
    param([AllowNull()][object]$Value)
    if (Test-TvUndef $Value) { return "undefined" }
    if ($null -eq $Value -or -not (Test-TvJsObject $Value)) { return ConvertTo-TvJsJson $Value }
    $parts = [System.Collections.Generic.List[string]]::new()
    if (Test-TvJsArray $Value) {
        foreach ($entry in $Value) { $parts.Add((ConvertTo-TvCanonicalText $entry)) }
        return "[" + ($parts -join ",") + "]"
    }
    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($key in (Get-TvJsKeys $Value)) { if (-not (Test-TvSkippedKey $key)) { $keys.Add($key) } }
    $keys.Sort([StringComparer]::Ordinal)
    foreach ($key in $keys) { $parts.Add((ConvertTo-TvJsJson $key) + ":" + (ConvertTo-TvCanonicalText $Value[$key])) }
    return "{" + ($parts -join ",") + "}"
}

function New-TvChangeRow {
    param([string]$Field, [AllowNull()][object]$Old, [AllowNull()][object]$New)
    return [ordered]@{ field = $Field; oldValue = $Old; newValue = $New }
}

function Get-TvArrayItemKeys {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object]$Items, [AllowEmptyString()][string]$Path)
    $keys = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $Items) {
        $key = $null
        if ($null -eq $item -or -not (Test-TvJsObject $item)) { $key = ConvertTo-TvJsJson $item }
        elseif ($Path.EndsWith("omaSettings")) {
            # item.displayName || item.omaUri
            $display = Get-TvMember $item "displayName"
            $key = if (Test-TvTruthy $display) { $display } else { Get-TvMember $item "omaUri" }
        } else {
            # App protection and app list entries are identified by their package or bundle ID;
            # without it, one added app would shift every later index.
            $identifier = Get-TvMember $item "mobileAppIdentifier"
            if ((Test-TvUndef $identifier) -or $null -eq $identifier) { $identifier = $item }
            $packageId = Get-TvMember $identifier "packageId"
            $bundleId = Get-TvMember $identifier "bundleId"
            if ($packageId -is [string] -and $packageId) { $key = $packageId }
            elseif ($bundleId -is [string] -and $bundleId) { $key = $bundleId }
            else {
                $instance = Get-TvMember $item "settingInstance"
                $key = if ((Test-TvUndef $instance) -or $null -eq $instance) { $script:TvUndefined } else { Get-TvMember $instance "settingDefinitionId" }
                if ((Test-TvUndef $key) -or $null -eq $key) { $key = Get-TvMember $item "settingDefinitionId" }
            }
        }
        if ($key -isnot [string]) { return $null }
        if (-not $seen.Add($key)) { return $null }
        $keys.Add($key)
    }
    return , $keys.ToArray()
}

# Adds the changes between two values to $Rows, like compareObjects. $EqualityOnly is
# context.equalityOnly: set inside the probes of the unkeyed array matching, which it disables.
function Compare-TvObjects {
    param([AllowNull()][object]$Old, [AllowNull()][object]$New, [AllowEmptyString()][string]$Path = "", [AllowNull()][object]$Parent = $null, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Rows, [bool]$EqualityOnly = $false)
    if ($null -eq $Old -or $null -eq $New -or -not (Test-TvJsObject $Old) -or -not (Test-TvJsObject $New)) {
        if ((ConvertTo-TvJsJson $Old) -cne (ConvertTo-TvJsJson $New)) { $Rows.Add((New-TvChangeRow $Path $Old $New)) }
        return
    }
    if ((Test-TvJsArray $Old) -and (Test-TvJsArray $New)) {
        $oldKeys = Get-TvArrayItemKeys $Old $Path
        $newKeys = Get-TvArrayItemKeys $New $Path
        if ($null -ne $oldKeys -and $null -ne $newKeys) {
            $oldSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$oldKeys, [StringComparer]::Ordinal)
            $newMapOrdinal = [System.Collections.Generic.Dictionary[string, int]]::new([StringComparer]::Ordinal)
            for ($i = 0; $i -lt $newKeys.Count; $i++) { $newMapOrdinal[$newKeys[$i]] = $i }
            for ($i = 0; $i -lt $oldKeys.Count; $i++) {
                $itemPath = "$Path[$($oldKeys[$i])]"
                if ($newMapOrdinal.ContainsKey($oldKeys[$i])) { Compare-TvObjects $Old[$i] $New[$newMapOrdinal[$oldKeys[$i]]] $itemPath $Old[$i] $Rows -EqualityOnly $EqualityOnly }
                else { $Rows.Add((New-TvChangeRow $itemPath $Old[$i] $script:TvUndefined)) }
            }
            for ($i = 0; $i -lt $newKeys.Count; $i++) {
                if (-not $oldSet.Contains($newKeys[$i])) { $Rows.Add((New-TvChangeRow "$Path[$($newKeys[$i])]" $script:TvUndefined $New[$i])) }
            }
        } else {
            # No stable key: match items that are unchanged anywhere in the list first, so an
            # inserted or removed item is reported as itself. What is left is paired in order only
            # when both sides have the same number left; otherwise it is whole added and removed items.
            $newByValue = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int]]]::new([StringComparer]::Ordinal)
            for ($i = 0; $i -lt $New.Count; $i++) {
                $text = ConvertTo-TvCanonicalText $New[$i]
                if (-not $newByValue.ContainsKey($text)) { $newByValue[$text] = [System.Collections.Generic.List[int]]::new() }
                $newByValue[$text].Add($i)
            }
            $matchedNew = [System.Collections.Generic.HashSet[int]]::new()
            $leftoverOld = [System.Collections.Generic.List[int]]::new()
            for ($i = 0; $i -lt $Old.Count; $i++) {
                $text = ConvertTo-TvCanonicalText $Old[$i]
                $match = -1
                if ($newByValue.ContainsKey($text)) { foreach ($index in $newByValue[$text]) { if (-not $matchedNew.Contains($index)) { $match = $index; break } } }
                if ($match -lt 0) { $leftoverOld.Add($i) } else { [void]$matchedNew.Add($match) }
            }
            $leftoverNew = [System.Collections.Generic.List[int]]::new()
            for ($i = 0; $i -lt $New.Count; $i++) { if (-not $matchedNew.Contains($i)) { $leftoverNew.Add($i) } }
            # Items that differ only inside a nested keyed list are unchanged by the comparison's
            # own rules. The probes are capped and run with EqualityOnly, which disables this pass
            # inside them, so nested unkeyed lists cannot stall the comparison.
            if (-not $EqualityOnly -and $leftoverOld.Count * $leftoverNew.Count -le 2500) {
                foreach ($oldIndex in @($leftoverOld.ToArray())) {
                    $equalAt = -1
                    for ($position = 0; $position -lt $leftoverNew.Count; $position++) {
                        $probe = [System.Collections.Generic.List[object]]::new()
                        Compare-TvObjects $Old[$oldIndex] $New[$leftoverNew[$position]] "$Path[$oldIndex]" $Old[$oldIndex] $probe -EqualityOnly $true
                        if ($probe.Count -eq 0) { $equalAt = $position; break }
                    }
                    if ($equalAt -ge 0) {
                        $leftoverNew.RemoveAt($equalAt)
                        [void]$leftoverOld.Remove($oldIndex)
                    }
                }
            }
            if ($leftoverOld.Count -eq $leftoverNew.Count) {
                for ($position = 0; $position -lt $leftoverOld.Count; $position++) {
                    $oldIndex = $leftoverOld[$position]
                    Compare-TvObjects $Old[$oldIndex] $New[$leftoverNew[$position]] "$Path[$oldIndex]" $Old[$oldIndex] $Rows -EqualityOnly $EqualityOnly
                }
            } else {
                foreach ($i in $leftoverOld) { $Rows.Add((New-TvChangeRow "$Path[$i]" $Old[$i] $script:TvUndefined)) }
                foreach ($i in $leftoverNew) { $Rows.Add((New-TvChangeRow "$Path[$i]" $script:TvUndefined $New[$i])) }
            }
        }
        return
    }
    $keys = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($key in (Get-TvJsKeys $Old) + (Get-TvJsKeys $New)) { if ($seen.Add($key)) { $keys.Add($key) } }
    foreach ($key in $keys) {
        if (Test-TvSkippedKey $key) { continue }
        $oldValue = Get-TvMember $Old $key
        $newValue = Get-TvMember $New $key
        $currentPath = if ($Path) { "$Path.$key" } else { $key }
        if ((Test-TvJsObject $oldValue) -and (Test-TvJsObject $newValue)) {
            Compare-TvObjects $oldValue $newValue $currentPath $Old $Rows -EqualityOnly $EqualityOnly
        } elseif ((ConvertTo-TvJsJson $oldValue) -cne (ConvertTo-TvJsJson $newValue)) {
            $row = New-TvChangeRow $currentPath $oldValue $newValue
            if ($currentPath.Contains("omaSettings") -and $key -ceq "value" -and $null -ne $Parent) {
                $display = Get-TvMember $Parent "displayName"
                if (Test-TvTruthy $display) { $row.displayName = $display }
            }
            $Rows.Add($row)
        }
    }
}

function Get-TvEmptyLike {
    param([AllowNull()][object]$Value)
    if (Test-TvJsArray $Value) { return , @() }
    if ($Value -isnot [System.Collections.IDictionary]) { return $script:TvUndefined }
    $copy = [ordered]@{}
    foreach ($key in $Value.Keys) { $copy[$key] = Get-TvEmptyLike $Value[$key] }
    return $copy
}

# Every setting of an added or deleted item, as changes from or to "not set".
function Get-TvDocumentedRows {
    param([AllowNull()][object]$Content, [ValidateSet("added", "deleted")][string]$Change)
    $redacted = Get-TvReportSafe $Content
    $empty = Get-TvEmptyLike $redacted
    $rows = [System.Collections.Generic.List[object]]::new()
    if ($Change -eq "added") { Compare-TvObjects $empty $redacted "" $null $rows } else { Compare-TvObjects $redacted $empty "" $null $rows }
    return , $rows
}

# The changes of a modified item with secrets redacted, plus one Secret values row when a secret changed.
function Get-TvRedactedChangeRows {
    param([AllowNull()][object]$Older, [AllowNull()][object]$Newer)
    $rows = [System.Collections.Generic.List[object]]::new()
    Compare-TvObjects (Get-TvReportSafe $Older) (Get-TvReportSafe $Newer) "" $null $rows
    $shown = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($row in $rows) { [void]$shown.Add($row.field) }
    $raw = [System.Collections.Generic.List[object]]::new()
    Compare-TvObjects $Older $Newer "" $null $raw
    foreach ($row in $raw) {
        if (-not $shown.Contains($row.field)) {
            $secret = New-TvChangeRow "secretValues" $script:TvRedacted $script:TvRedacted
            $secret.displayName = "Secret values"
            $rows.Add($secret)
            break
        }
    }
    return , $rows
}

# ---------------------------------------------------------------------------
# Readable names and values (mirror src/shared/intune/drift-format.ts)
# ---------------------------------------------------------------------------

$script:Acronyms = @{
    os = "OS"; id = "ID"; ids = "IDs"; url = "URL"; urls = "URLs"; uri = "URI"; vpn = "VPN"; pin = "PIN"; ip = "IP"; dns = "DNS"; mdm = "MDM"; oma = "OMA"
    tpm = "TPM"; usb = "USB"; smb = "SMB"; tls = "TLS"; ssl = "SSL"; sso = "SSO"; uac = "UAC"; wifi = "Wi-Fi"; ios = "iOS"; macos = "macOS"; pua = "PUA"
    asr = "ASR"; lsa = "LSA"; ui = "UI"; api = "API"; ssid = "SSID"; eap = "EAP"; ntlm = "NTLM"; rdp = "RDP"; bitlocker = "BitLocker"; onedrive = "OneDrive"
}
$script:Words = [System.Collections.Generic.HashSet[string]]::new([string[]]@(@'
access account accounts action actions active add additional address admin administrator advanced age alert alerts all allow allowed always
and android antivirus app apple application applications apps archive attack audit authentication auto automatic available background
backup banner battery behavior biometric block blocked bluetooth boot browser browsing cache camera certificate change check child
classic clear client cloud code collection command compliance computer config configuration configure connect connection consent
control controlled copy credential credentials critical custom data date day days default defender delete delivery deny detection
device devices diagnostic disable disabled disk display domain download drive drives edge email emails enable enabled encrypt encryption
endpoint enforce enhanced enrollment exclusion exclusions execution experience explorer extension extensions failed feature features
file files filter firewall folder folders for from full game guard guest hello history home host hours identity idle inactive
inbound install installation interval key keyboard kiosk language length level limit list local location lock logon low maximum
microsoft minimum minutes mode monitor monitoring network new notification notifications number of office on outbound password
passwords path personal phone policy power prevent preview print printer privacy private profile prompt protection proxy public
quick real recovery reduction remote removable remove report reporting require required requirement restart restrict restricted
retention rule rules run safe sample samples save scan scans schedule scheduled screen script scripts search secure security sending
sensitive service services session setting settings share sharing shell sign signature size smart software source standard start
startup state storage store submit surface sync system tamper telemetry time timeout to type update updates upload usage user users
value version web window windows wipe with work workplace
'@.Trim() -split '\s+'), [StringComparer]::Ordinal)

function Get-TvAcronym {
    param([AllowEmptyString()][string]$Word)
    if ($script:Acronyms.ContainsKey($Word) -and [StringComparer]::Ordinal.Equals($Word, $Word.ToLowerInvariant())) { return $script:Acronyms[$Word] }
    return $null
}

function Get-TvSplitWords {
    param([Parameter(Mandatory)][string]$Text)
    if ($Text.Length -gt 80) { return $Text }
    $best = [object[]]::new($Text.Length + 1)
    $best[0] = [string[]]@()
    for ($i = 1; $i -le $Text.Length; $i++) {
        for ($j = [Math]::Max(0, $i - 20); $j -lt $i; $j++) {
            $previous = $best[$j]
            $piece = $Text.Substring($j, $i - $j)
            if ($null -ne $previous -and ($script:Words.Contains($piece) -or $null -ne (Get-TvAcronym $piece)) -and ($null -eq $best[$i] -or $previous.Count + 1 -lt $best[$i].Count)) {
                $best[$i] = [string[]]@($previous + $piece)
            }
        }
    }
    if ($null -eq $best[$Text.Length]) { return $Text }
    return ($best[$Text.Length] -join " ")
}

function Get-TvHumanized {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Name)
    $text = $Name -creplace '^@odata\.', ''
    $text = $text -creplace '[_\-.]+', ' '
    $text = $text -creplace '([a-z0-9])([A-Z])', '$1 $2'
    $text = $text -creplace '([A-Z]+)([A-Z][a-z])', '$1 $2'
    $raw = @($text.Trim() -split '\s+' | Where-Object { $_ })
    $joined = [System.Collections.Generic.List[string]]::new()
    foreach ($word in $raw) {
        $combined = if ($joined.Count) { ($joined[$joined.Count - 1] + $word).ToLowerInvariant() } else { $word.ToLowerInvariant() }
        $acronym = if ($joined.Count) { Get-TvAcronym $combined } else { $null }
        if ($joined.Count -and $null -ne $acronym) { $joined[$joined.Count - 1] = $acronym } else { $joined.Add($word) }
    }
    $words = [System.Collections.Generic.List[string]]::new()
    foreach ($word in $joined) {
        if ($word -ceq $word.ToLowerInvariant() -and $word.Length -gt 8 -and $null -eq (Get-TvAcronym $word)) { foreach ($part in ((Get-TvSplitWords $word) -split " ")) { $words.Add($part) } }
        else { $words.Add($word) }
    }
    $out = for ($index = 0; $index -lt $words.Count; $index++) {
        $word = $words[$index]
        $acronym = Get-TvAcronym $word.ToLowerInvariant()
        if ($null -ne $acronym) { $acronym; continue }
        if ($word.Length -gt 1 -and $word -ceq $word.ToUpperInvariant() -and $word -cmatch '[A-Z]') { $word; continue }
        $lower = $word.ToLowerInvariant()
        if ($index -eq 0) { $lower.Substring(0, 1).ToUpperInvariant() + $lower.Substring(1) } else { $lower }
    }
    $result = @($out) -join " "
    if ($result) { return $result }
    return $Name
}

function Get-TvNameLookup {
    param([AllowNull()][object]$Map, [AllowNull()][string]$Key)
    if ($null -eq $Map -or $null -eq $Key) { return $null }
    if ($Map.ContainsKey($Key)) { return [string]$Map[$Key] }
    return $null
}

function Get-TvSettingNameOf {
    param([string]$DefinitionId, [AllowNull()][object]$Names)
    $name = if ($Names) { Get-TvNameLookup $Names.settings $DefinitionId } else { $null }
    if ($name -and $name -cne $script:GenericGroupName) { return $name }
    return $null
}

function Get-TvPayloadSettingId {
    param([Parameter(Mandatory)][string]$DefinitionId)
    $half = ($DefinitionId.Length - 1) / 2
    if ($half -gt 0 -and [Math]::Floor($half) -eq $half -and $DefinitionId[[int]$half] -eq "_" -and $DefinitionId.Substring(0, [int]$half) -ceq $DefinitionId.Substring([int]$half + 1)) { return $DefinitionId.Substring(0, [int]$half) }
    return $DefinitionId
}

$script:VendorPrefix = [regex]::new('^(?:device|user)_vendor_msft_(?:policy_(?:config|result)_)?|^vendor_msft_|^com\.apple\.', [Text.RegularExpressions.RegexOptions]::IgnoreCase)

function Get-TvDefinitionLabel {
    param([Parameter(Mandatory)][string]$DefinitionId, [AllowNull()][object]$Names)
    $named = Get-TvSettingNameOf $DefinitionId $Names
    if ($named) { return $named }
    $stripped = $script:VendorPrefix.Replace((Get-TvPayloadSettingId $DefinitionId), "", 1)
    $parts = @($stripped -split '[_.]' | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $DefinitionId }
    $setting = Get-TvHumanized $parts[$parts.Count - 1]
    if ($parts.Count -eq 1) { return $setting }
    return "$(Get-TvHumanized $parts[$parts.Count - 2]): $setting"
}

$script:ValuePath = [regex]::new('^(?:\.settingInstance)?(?:\.(?:choiceSettingValue|simpleSettingValue|groupSettingCollectionValue|simpleSettingCollectionValue|choiceSettingCollectionValue))?(?:\.value)?$')

function Get-TvSegmentLabel {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Segment)
    $match = [regex]::Match($Segment, '^([^\[]*)(?:\[(.+)\])?$')
    $name = if ($match.Success) { $match.Groups[1].Value } else { $Segment }
    $hasKey = $match.Success -and $match.Groups[2].Success
    $base = if ($name) { Get-TvHumanized $name } else { "Item" }
    if (-not $hasKey) { return $base }
    $key = $match.Groups[2].Value
    if ($key -match '^\d+$') { return "$base (item $([Int64]$key + 1))" }
    return "${base}: $($key -creplace '^"(.*)"$', '$1')"
}

# Mirror COMPLIANCE_SETTINGS in src/shared/intune/compliance-settings.ts.
$script:ComplianceLabels = [ordered]@{
    secureByDefault                       = "Mark devices with no compliance policy assigned as"
    deviceComplianceCheckinThresholdDays  = "Compliance status validity period (days)"
    isScheduledActionEnabled              = "Scheduled actions for noncompliance"
    enhancedJailBreak                     = "Enhanced jailbreak detection"
}

function Get-TvComplianceValue {
    param([string]$Key, [AllowNull()][object]$Value)
    switch -CaseSensitive ($Key) {
        "secureByDefault" { if ($Value -is [bool]) { if ($Value) { return "Not compliant" } else { return "Compliant" } }; return "Not set" }
        "deviceComplianceCheckinThresholdDays" { if ((Test-TvJsNumber $Value) -and $Value -gt 0) { return ConvertTo-TvJsNumber $Value }; return "Not set (Intune uses 30)" }
        { $_ -in @("isScheduledActionEnabled", "enhancedJailBreak") } { if ($Value -is [bool]) { if ($Value) { return "Enabled" } else { return "Disabled" } }; return "Not set" }
    }
    return $null
}

# settingLabel: returns @{ Label; DefinitionId; Property }.
function Get-TvSettingLabel {
    param([Parameter(Mandatory)][object]$Row, [AllowNull()][object]$Names)
    $path = [string]$Row.field
    $displayName = if ($Row.Contains("displayName")) { $Row.displayName } else { $null }
    if (-not $path) { return @{ Label = "Whole item" } }
    $oma = [regex]::Match($path, 'omaSettings\[([^\]]+)\](?:\.(.+))?$')
    if ($oma.Success) {
        $name = if ($null -ne $displayName) { [string]$displayName } else { $oma.Groups[1].Value }
        $property = if ($oma.Groups[2].Success) { $oma.Groups[2].Value } else { $null }
        if ($property -and $property -cne "value") { return @{ Label = "${name}: $(Get-TvHumanized ($property -split '\.')[-1])" } }
        return @{ Label = $name }
    }
    if ($null -ne $displayName) { return @{ Label = [string]$displayName } }
    if ($script:ComplianceLabels.Contains($path)) { return @{ Label = $script:ComplianceLabels[$path]; Property = $path } }
    $definitions = [regex]::Matches($path, '\[([^\]"]*[_.][^\]"]*)\]')
    if ($path.StartsWith("settings[") -and $definitions.Count -gt 0) {
        $last = $definitions[$definitions.Count - 1]
        $definitionId = $last.Groups[1].Value
        $rest = $path.Substring($last.Index + $last.Length)
        $label = Get-TvDefinitionLabel $definitionId $Names
        if ($script:ValuePath.IsMatch($rest)) { return @{ Label = $label; DefinitionId = $definitionId } }
        $property = @($rest -split '\.' | Where-Object { $_ })
        if ($property.Count) { $label = "$label ($((Get-TvSegmentLabel $property[-1]).ToLowerInvariant()))" }
        return @{ Label = $label; DefinitionId = $definitionId }
    }
    $segments = [regex]::Split($path, '\.(?![^\[]*\])')
    $lastSegment = $segments[$segments.Count - 1]
    $parent = if ($segments.Count -ge 2) { $segments[$segments.Count - 2] } else { $null }
    if ($parent -and $lastSegment -match '^(?:value|values)$') { return @{ Label = "$(Get-TvSegmentLabel $parent): $($lastSegment.ToLowerInvariant())" } }
    return @{ Label = Get-TvSegmentLabel $lastSegment }
}

function Get-TvChoiceText {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value, [AllowNull()][string]$DefinitionId)
    if ($DefinitionId -and $Value.ToLowerInvariant().StartsWith("$($DefinitionId.ToLowerInvariant())_")) { return Get-TvHumanized $Value.Substring($DefinitionId.Length + 1) }
    return $Value
}

$script:ChoiceValue = [regex]::new('^(?:device|user)_vendor_msft_[a-z0-9_.]+_([a-z0-9]+)$|^com\.apple\.[a-z0-9_.]+_([a-z0-9]+)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)

function Get-TvSettingSummary {
    param([AllowNull()][object]$Value, [AllowNull()][object]$Names)
    if ($Value -isnot [System.Collections.IDictionary]) { return $null }
    $instance = Get-TvMember $Value "settingInstance"
    if ((Test-TvUndef $instance) -or $null -eq $instance) {
        $id = Get-TvMember $Value "settingDefinitionId"
        $instance = if (Test-TvTruthy $id) { $Value } else { $null }
    }
    if ($instance -isnot [System.Collections.IDictionary]) { return $null }
    $definitionId = Get-TvMember $instance "settingDefinitionId"
    if ($definitionId -isnot [string]) { return $null }
    $label = Get-TvDefinitionLabel $definitionId $Names
    $choice = Get-TvMember (Get-TvMember $instance "choiceSettingValue") "value"
    $simple = Get-TvMember (Get-TvMember $instance "simpleSettingValue") "value"
    if ($choice -is [string]) {
        $option = if ($Names) { Get-TvNameLookup $Names.options $choice } else { $null }
        if ($null -eq $option) { $option = Get-TvChoiceText $choice $definitionId }
        return "$label = $option"
    }
    if (-not (Test-TvUndef $simple) -and ($null -eq $simple -or -not (Test-TvJsObject $simple))) { return "$label = $(ConvertTo-TvJsString $simple)" }
    return $label
}

# formatValue, as the text and whether it was JSON with an optional summary.
function Format-TvValue {
    param([AllowNull()][object]$Value, [AllowNull()][string]$DefinitionId, [AllowNull()][object]$Names, [AllowNull()][string]$Property)
    if ($Property -and ((Test-TvUndef $Value) -or $null -eq $Value -or -not (Test-TvJsObject $Value))) {
        $compliance = Get-TvComplianceValue $Property $(if (Test-TvUndef $Value) { $null } else { $Value })
        if ($null -ne $compliance) { return @{ Kind = "text"; Text = $compliance } }
    }
    if ((Test-TvUndef $Value) -or $null -eq $Value -or ($Value -is [string] -and $Value -eq "")) { return @{ Kind = "empty"; Text = "Not set" } }
    if ($Value -is [bool] -or (Test-TvJsNumber $Value)) { return @{ Kind = "text"; Text = ConvertTo-TvJsString $Value } }
    if ($Value -is [string]) {
        $option = if ($Names) { Get-TvNameLookup $Names.options $Value } else { $null }
        if ($null -ne $option) { return @{ Kind = "text"; Text = $option } }
        $shortened = Get-TvChoiceText $Value $DefinitionId
        if ($shortened -cne $Value) { return @{ Kind = "text"; Text = $shortened } }
        $choice = $script:ChoiceValue.Match($Value)
        if ($choice.Success) { return @{ Kind = "text"; Text = Get-TvHumanized $(if ($choice.Groups[1].Success) { $choice.Groups[1].Value } else { $choice.Groups[2].Value }) } }
        return @{ Kind = "text"; Text = $Value }
    }
    return @{ Kind = "json"; Summary = Get-TvSettingSummary $Value $Names }
}

# ---------------------------------------------------------------------------
# Report values (mirror describeValue and describeAssignment in change-report.ts)
# ---------------------------------------------------------------------------

$script:AssignmentTargets = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
$script:AssignmentTargets["#microsoft.graph.groupAssignmentTarget"] = "Included group"
$script:AssignmentTargets["#microsoft.graph.exclusionGroupAssignmentTarget"] = "Excluded group"
$script:AssignmentTargets["#microsoft.graph.allDevicesAssignmentTarget"] = "All devices"
$script:AssignmentTargets["#microsoft.graph.allLicensedUsersAssignmentTarget"] = "All users"
$script:AssignmentTargets["#microsoft.graph.allUsersAssignmentTarget"] = "All users"

function Get-TvClip {
    param([AllowEmptyString()][string]$Text)
    if ($Text.Length -gt $script:MaxValueLength) { return $Text.Substring(0, $script:MaxValueLength - 3) + "..." }
    return $Text
}

function Get-TvAssignmentLine {
    param([AllowNull()][object]$Value)
    $target = Get-TvMember $Value "target"
    if ($target -isnot [System.Collections.IDictionary]) { return $null }
    $type = Get-TvMember $target "@odata.type"
    $kind = if ($type -is [string]) { if ($script:AssignmentTargets.ContainsKey($type)) { $script:AssignmentTargets[$type] } else { $type -creplace '^#microsoft\.graph\.', '' } } else { "Assignment" }
    $groupId = Get-TvMember $target "groupId"
    $group = if ($groupId -is [string]) { " $groupId" } else { "" }
    $filterType = Get-TvMember $target "deviceAndAppManagementAssignmentFilterType"
    $filterId = Get-TvMember $target "deviceAndAppManagementAssignmentFilterId"
    $filter = ""
    if ($filterId -is [string] -and $filterId -and $filterType -cne "none") {
        $typeText = if ((Test-TvUndef $filterType) -or $null -eq $filterType) { "" } else { ConvertTo-TvJsString $filterType }
        $filter = " (filter $typeText $filterId)"
        $at = $filter.IndexOf("  ")
        if ($at -ge 0) { $filter = $filter.Remove($at, 1) }
    }
    return "$kind$group$filter"
}

function Get-TvReportValue {
    param([string]$Field, [AllowNull()][object]$Value, [AllowNull()][string]$DefinitionId, [AllowNull()][object]$Names, [AllowNull()][string]$Property)
    if ($Field.StartsWith("assignments[") -and (Test-TvJsObject $Value)) {
        $line = Get-TvAssignmentLine $Value
        if ($line) { return $line }
    }
    if ($null -ne $Value -and (Test-TvJsObject $Value)) {
        # An app entry reads as its package or bundle ID.
        $identifier = Get-TvMember $Value "mobileAppIdentifier"
        if ((Test-TvUndef $identifier) -or $null -eq $identifier) { $identifier = $Value }
        $app = Get-TvMember $identifier "packageId"
        if ((Test-TvUndef $app) -or $null -eq $app) { $app = Get-TvMember $identifier "bundleId" }
        if ($app -is [string] -and $app) { return Get-TvClip $app }
    }
    if ($Field -match 'omaSettings\[[^\]]+\]$' -and (Test-TvJsObject $Value)) {
        $uri = Get-TvMember $Value "omaUri"
        $inner = Get-TvMember $Value "value"
        $prefix = if ($uri -is [string]) { "$uri = " } else { "" }
        $text = if ($inner -is [string] -or $inner -is [bool] -or (Test-TvJsNumber $inner)) { ConvertTo-TvJsString $inner } else { ConvertTo-TvJsJson $(if (Test-TvUndef $inner) { $null } else { $inner }) }
        return Get-TvClip "$prefix$text"
    }
    $formatted = Format-TvValue $Value $DefinitionId $Names $Property
    if ($formatted.Kind -ne "json") { return Get-TvClip $formatted.Text }
    if ($formatted.Summary) {
        $summary = [string]$formatted.Summary
        $at = $summary.IndexOf(" = ")
        if ($at -ge 0) { return Get-TvClip $summary.Substring($at + 3) }
        return Get-TvClip $summary
    }
    return Get-TvClip (ConvertTo-TvJsJson $Value)
}

# definitionIdsIn: the Settings Catalog setting definitions the changes mention.
function Get-TvDefinitionIds {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object]$Rows)
    $ids = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $walk = $null
    $walk = {
        param($value, $depth)
        if ($ids.Count -ge $script:MaxDefinitions -or $depth -gt 12 -or -not (Test-TvJsObject $value)) { return }
        if (Test-TvJsArray $value) { foreach ($entry in $value) { & $walk $entry ($depth + 1) }; return }
        $id = Get-TvMember $value "settingDefinitionId"
        if ($id -is [string] -and $id -and $seen.Add($id)) { $ids.Add($id) }
        foreach ($key in $value.Keys) { & $walk $value[$key] ($depth + 1) }
    }
    foreach ($row in $Rows) {
        if (-not ([string]$row.field).StartsWith("settings[")) { continue }
        foreach ($match in [regex]::Matches([string]$row.field, '\[([^\]"]*[_.][^\]"]*)\]')) { if ($seen.Add($match.Groups[1].Value)) { $ids.Add($match.Groups[1].Value) } }
        & $walk $row.oldValue 0
        & $walk $row.newValue 0
        if ($ids.Count -ge $script:MaxDefinitions) { break }
    }
    return , @($ids | Select-Object -First $script:MaxDefinitions)
}

# Setting and option names from Graph setting definition bodies, like readSettingNames.
# $Definitions maps a definition id to its body, or to $null when Graph does not know it.
function ConvertTo-TvSettingNames {
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Ids, [Parameter(Mandatory)][hashtable]$Definitions)
    $names = @{ settings = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal); options = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal) }
    foreach ($id in $Ids) {
        if (-not $Definitions.ContainsKey($id)) { continue }
        $body = $Definitions[$id]
        if ($body -isnot [System.Collections.IDictionary]) { continue }
        $options = [System.Collections.Generic.List[object]]::new()
        $optionList = Get-TvMember $body "options"
        if (Test-TvJsArray $optionList) {
            foreach ($option in $optionList) {
                $itemId = Get-TvMember $option "itemId"
                $display = Get-TvMember $option "displayName"
                if ($itemId -is [string] -and $display -is [string] -and $display.Trim()) { $options.Add(@($itemId, $display.Trim())) }
            }
        }
        $display = Get-TvMember $body "displayName"
        if ($display -isnot [string] -or -not $display.Trim()) { continue }
        $name = $display.Trim()
        if ($name -ceq $script:GenericGroupName) {
            $name = $null
            $keywords = Get-TvMember $body "keywords"
            if (Test-TvJsArray $keywords) { foreach ($word in $keywords) { if ($word -is [string] -and $word.Trim() -ne "") { $name = $word.Trim(); break } } }
        }
        if ($name) { $names.settings[$id] = $name }
        foreach ($option in $options) { $names.options[$option[0]] = $option[1] }
    }
    return $names
}

# ---------------------------------------------------------------------------
# Backups and the items that changed (mirror compareBackups, sameItem and coveredFolders)
# ---------------------------------------------------------------------------

# Mirror LEGACY_FOLDERS in src/shared/intune/scope.ts: what backups covered before they recorded Scope.Included.
$script:LegacyFolders = @(
    "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
    "CompliancePolicies", "ComplianceSettingsPolicies", "ComplianceScripts", "EndpointSecurityIntents", "PowerShellScripts", "ShellScripts",
    "CustomAttributeScripts", "Remediations", "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles",
    "AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid",
    "AppProtectionWindows", "PolicySets", "EnrollmentConfigurations", "AutopilotProfiles", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment",
    "AndroidEnrollmentProfiles", "DeviceCategories", "TermsAndConditions", "AssignmentFilters", "ScopeTags", "RoleDefinitions",
    "NotificationTemplates", "Branding", "DeviceCleanupRules", "MultiAdminApprovalPolicies")
$script:LegacyLabels = @{ DeviceConfigurations = "Device Configuration"; CompliancePolicies = "Compliance Policy"; DeviceCompliancePolicies = "Compliance Policy"; ConfigurationPolicies = "Configuration Policy" }
$script:ConditionalAccessLabels = @("Conditional Access policies", "Named locations", "Authentication strengths")

function Get-TvCoveredFolders {
    param([AllowNull()][object]$Metadata, [Parameter(Mandatory)][string[]]$Known)
    $scope = Get-TvProp $Metadata "Scope"
    $recorded = Get-TvProp $scope "Included"
    $attempted = if (Test-TvJsArray $recorded) { @($recorded | Where-Object { $_ -is [string] }) } else { $script:LegacyFolders }
    $missing = @()
    foreach ($field in @("Excluded", "SkippedTypes", "FailedTypes", "AppOnlyExcludedTypes")) {
        $source = if ($field -eq "Excluded") { Get-TvProp $scope "Excluded" } else { Get-TvProp $Metadata $field }
        if (Test-TvJsArray $source) { $missing += @($source | Where-Object { $_ -is [string] }) }
    }
    return , @($Known | Where-Object { $attempted -ccontains $_ -and $missing -cnotcontains $_ })
}

function Test-TvSameItem {
    param([Parameter(Mandatory)][object]$Previous, [Parameter(Mandatory)][object]$Item)
    if ((Get-TvProp $Previous "hash") -ceq (Get-TvProp $Item "hash")) { return $true }
    $previousMasked = Get-TvProp $Previous "hashWithMaskedSecrets"
    if (((Get-TvProp $Previous "secretsMasked") -eq $true -or (Get-TvProp $Item "secretsMasked") -eq $true) -and $null -ne $previousMasked) { return $previousMasked -ceq (Get-TvProp $Item "hashWithMaskedSecrets") }
    return $null -eq (Get-TvProp $Previous "hashWithEmptyAssignments") -and $null -ne (Get-TvProp $Item "hashWithEmptyAssignments") -and (Get-TvProp $Previous "hash") -ceq (Get-TvProp $Item "hashWithEmptyAssignments")
}

# Severity of a change, like determineSeverity in the drift route.
function Get-TvChangeSeverity {
    param([string]$PolicyType, [string]$ChangeType, [AllowNull()][object]$Rows)
    if ($ChangeType -eq "deleted" -and $PolicyType -ceq "Compliance Policy") { return "critical" }
    if ($script:ConditionalAccessLabels -ccontains $PolicyType) {
        if ($ChangeType -eq "deleted") { return "critical" }
        foreach ($row in @($Rows)) { if ($row -and [string]$row.field -cmatch '^(state|conditions\.users|grantControls|sessionControls|conditions\.locations|ipRanges|countriesAndRegions|isTrusted|allowedCombinations)') { return "critical" } }
        return "warning"
    }
    if ($null -ne $Rows) {
        foreach ($row in @($Rows)) {
            $field = ([string]$row.field).ToLowerInvariant()
            foreach ($critical in @("passwordrequired", "encryption", "jailbreak", "firewall", "antivirus", "bitlocker", "securebydefault")) { if ($field.Contains($critical)) { return "critical" } }
        }
    }
    if ($ChangeType -eq "deleted") { return "warning" }
    if ($ChangeType -eq "modified" -and ($PolicyType -ceq "Compliance Policy" -or $PolicyType -ceq "Device Configuration" -or $PolicyType -ceq "Compliance policy settings")) { return "warning" }
    return "info"
}

# The changed items between two backups as drift entries. $ReadItem returns an item's parsed
# content for (backup name, "<folder>/<file>") or throws; $Types is the runbook type table.
function Get-TvBackupDrifts {
    param(
        [Parameter(Mandatory)][hashtable]$Older,
        [Parameter(Mandatory)][hashtable]$Newer,
        [Parameter(Mandatory)][object[]]$Types,
        [Parameter(Mandatory)][scriptblock]$ReadItem
    )
    $known = [string[]]@($Types | ForEach-Object { $_.Folder })
    $byFolder = @{}
    foreach ($type in $Types) { $byFolder[$type.Folder] = $type }
    $before = Get-TvProp $Older.Metadata "Items"
    $after = Get-TvProp $Newer.Metadata "Items"
    $olderCovered = Get-TvCoveredFolders $Older.Metadata $known
    $shared = @((Get-TvCoveredFolders $Newer.Metadata $known) | Where-Object { $olderCovered -ccontains $_ })
    $drifts = [System.Collections.Generic.List[object]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    $tasks = [System.Collections.Generic.List[object]]::new()
    foreach ($key in (Get-TvKeys $after)) {
        $folder = $key.Substring(0, $key.IndexOf("/"))
        if ($shared -cnotcontains $folder) { continue }
        $item = $after[$key]
        $previous = Get-TvProp $before $key
        if ($null -eq $previous) { $tasks.Add(@{ Change = "added"; Folder = $folder; Newer = $item }) }
        elseif (-not (Test-TvSameItem $previous $item)) { $tasks.Add(@{ Change = "modified"; Folder = $folder; Newer = $item; Older = $previous }) }
    }
    foreach ($key in (Get-TvKeys $before)) {
        $folder = $key.Substring(0, $key.IndexOf("/"))
        if ($shared -ccontains $folder -and $null -eq (Get-TvProp $after $key)) { $tasks.Add(@{ Change = "deleted"; Folder = $folder; Older = $before[$key] }) }
    }
    foreach ($task in $tasks) {
        $type = $byFolder[$task.Folder]
        $policyType = if ($script:LegacyLabels.ContainsKey($task.Folder)) { $script:LegacyLabels[$task.Folder] } elseif ($type) { [string]$type.Label.Substring(0, 1).ToUpperInvariant() + $type.Label.Substring(1) } else { "Unknown Policy" }
        $read = {
            param($backup, $record)
            $file = "$($task.Folder)/$(Get-TvProp $record 'file')"
            try { return , (& $ReadItem $backup.Name $file) }
            catch { $warnings.Add("$file ($($backup.Name)): $(Get-TvSafeError $_.Exception.Message)"); return $null }
        }
        $nameOf = {
            param($content, $record)
            foreach ($candidate in @((Get-TvProp $content "displayName"), (Get-TvProp $content "name"))) { if ($candidate -is [string] -and $candidate) { return $candidate } }
            $file = [string](Get-TvProp $record "file")
            if ($file) { $short = ([regex]'\.json').Replace($file, '', 1); if ($short) { return $short } }
            return "Unknown"
        }
        $entry = $null
        if ($task.Change -eq "added") {
            $content = & $read $Newer $task.Newer
            $name = & $nameOf $content $task.Newer
            $rows = if ($null -ne $content) { Get-TvDocumentedRows $content "added" } else { $null }
            $entry = [ordered]@{ changeType = "added"; type = $policyType; configName = $name; configId = [string](Get-TvProp $content "id"); severity = Get-TvChangeSeverity $policyType "added" $null; changes = $rows; fromBackup = $Older.Name }
            $restored = @((Get-TvProp $content "displayName"), (Get-TvProp $content "name")) | Where-Object { $_ -is [string] -and $_.StartsWith("[Restored]") }
            if (@($restored).Count) { $entry.likelyRestoredCopy = $true }
        } elseif ($task.Change -eq "deleted") {
            $content = & $read $Older $task.Older
            $name = & $nameOf $content $task.Older
            $rows = if ($null -ne $content) { Get-TvDocumentedRows $content "deleted" } else { $null }
            $entry = [ordered]@{ changeType = "deleted"; type = $policyType; configName = $name; configId = [string](Get-TvProp $content "id"); severity = Get-TvChangeSeverity $policyType "deleted" $null; changes = $rows; fromBackup = $Older.Name }
        } else {
            $newContent = & $read $Newer $task.Newer
            $oldContent = & $read $Older $task.Older
            if ($null -eq $newContent -or $null -eq $oldContent) { continue }
            # withoutUnreadAssignments: an older backup that could not read assignments compares without them.
            $unread = Get-TvMember $oldContent "assignments"
            if ($type -and $type.AssignmentsFormerlyExpanded -and $oldContent.Contains("assignments@odata.context") -and (Test-TvJsArray $unread) -and $unread.Count -eq 0) {
                $oldContent = Copy-TvDeep $oldContent; $newContent = Copy-TvDeep $newContent
                $oldContent.Remove("assignments"); if ($newContent -is [System.Collections.IDictionary]) { $newContent.Remove("assignments") }
            }
            $rows = Get-TvRedactedChangeRows $oldContent $newContent
            if ($rows.Count -eq 0) { continue }
            $name = & $nameOf $newContent $task.Older
            $entry = [ordered]@{ changeType = "modified"; type = $policyType; configName = $name; configId = [string](Get-TvProp $newContent "id"); severity = Get-TvChangeSeverity $policyType "modified" $rows; changes = $rows; fromBackup = $Older.Name }
            $previousName = @((Get-TvProp $oldContent "displayName"), (Get-TvProp $oldContent "name")) | Where-Object { $_ -is [string] -and $_ } | Select-Object -First 1
            $currentName = @((Get-TvProp $newContent "displayName"), (Get-TvProp $newContent "name")) | Where-Object { $_ -is [string] -and $_ } | Select-Object -First 1
            if ($previousName -and $previousName -cne $currentName) { $entry.previousName = $previousName }
        }
        $drifts.Add($entry)
    }
    return @{ Drifts = $drifts; Warnings = $warnings }
}

# ---------------------------------------------------------------------------
# The report (mirror buildChangeReport and its text helpers in change-report.ts)
# ---------------------------------------------------------------------------

# publicAuditNote: an audit note fit to show and send. Reports are emailed outside the
# organization, so a raw Microsoft Graph error (URLs, tenant IDs, the request filter) is replaced
# by what it means. Plain sentences pass through. ECMAScript regex options keep \b, \d and \w ASCII.
function Get-TvPublicAuditNote {
    param([AllowNull()][object]$Note)
    if ($Note -isnot [string] -or -not $Note) { return $null }
    $js = [Text.RegularExpressions.RegexOptions]::ECMAScript
    $jsCase = $js -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase
    $space = '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    $text = ([regex]::Replace($Note, $space, " ")).Trim(" ")
    if (-not $text) { return $null }
    $payload = [regex]::IsMatch($text, '[{[]|Operation ID|"_version"|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', $jsCase)
    $raw = $payload -or $text.Length -gt 280 -or [regex]::IsMatch($text, 'https?://', $js)
    if (-not $raw) { return $text }
    if ([regex]::IsMatch($text, '\b429\b|throttl', $jsCase)) { return "Microsoft Graph throttled the audit log request (429). Generate the report again in a few minutes." }
    $status = [regex]::Match($text, '\breturned (\d{3})\b', $js)
    if ($payload) { if ($status.Success) { return "Microsoft Graph returned $($status.Groups[1].Value)." } else { return "The audit log could not be read." } }
    $cleaned = [regex]::Replace([regex]::Replace($text, 'https?://[^ ]+', "", $js), ' +', " ").Trim(" ")
    if ($cleaned.Length -gt 240) { return $cleaned.Substring(0, 237).TrimEnd(" ") + "..." }
    return $cleaned
}

function Get-TvReportTime {
    param([Parameter(Mandatory)][string]$Iso)
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) { return $Iso }
    $utc = $parsed.UtcDateTime
    $months = @("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return "$($utc.Day) $($months[$utc.Month - 1]) $($utc.Year), $($utc.ToString('HH:mm', [Globalization.CultureInfo]::InvariantCulture)) UTC"
}

function Get-TvReportTitle {
    param([Parameter(Mandatory)][object]$Report)
    $from = (Get-TvReportTime $Report.from.timestamp) -creplace ', \d{2}:\d{2} UTC$', ''
    $to = (Get-TvReportTime $Report.to.timestamp) -creplace ', \d{2}:\d{2} UTC$', ''
    $range = if ($from -ceq $to) { $from } else { "$from to $to" }
    return "Changes in $($Report.tenantName), $range"
}

function Get-TvSummaryLine {
    param([Parameter(Mandatory)][object]$Report)
    $s = $Report.summary
    $total = $s.added + $s.modified + $s.deleted
    if ($total -eq 0) { return "No changes between the two backups." }
    $parts = @()
    if ($s.modified) { $parts += "$($s.modified) changed" }
    if ($s.added) { $parts += "$($s.added) added" }
    if ($s.deleted) { $parts += "$($s.deleted) deleted" }
    $text = $parts -join ", "
    if ($Report.audit.status -ne "included") { return "$text. Who made them is unknown: the audit log could not be read." }
    return "$text; $($s.attributed) of $total with matching audit events."
}

function Get-TvReportFileName {
    param([Parameter(Mandatory)][object]$Report)
    $slug = ($Report.tenantName.ToLowerInvariant() -creplace '[^a-z0-9]+', '-') -creplace '^-+|-+$', ''
    if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }
    $parts = @("change-report", $slug, $Report.to.timestamp.Substring(0, 10)) | Where-Object { $_ }
    return $parts -join "-"
}

$script:ChangeLabels = @{ added = "Added"; modified = "Changed"; deleted = "Deleted" }
$script:ChangeOrder = @{ deleted = 0; modified = 1; added = 2 }
$script:SeverityOrder = @{ critical = 0; warning = 1; info = 2 }
$script:SkippedDocumented = '^(?:@odata\.type|displayName|name|settingCount|isAssigned|creationSource|supportsScopeTags|roleScopeTagIds(?:\[.*\])?)$'

function Get-TvActivity {
    param([Parameter(Mandatory)][object]$Event, [bool]$IncludeActors)
    $who = $null
    if ($IncludeActors) { $who = if ($Event.actorUpn) { $Event.actorUpn } elseif ($Event.actorAppName) { $Event.actorAppName } else { $null } }
    return [ordered]@{ at = $Event.at; change = $Event.changeType; who = $who; activity = $Event.activity; source = $Event.source }
}

function Compare-TvLocale {
    param([string]$A, [string]$B)
    return [string]::Compare($A, $B, [Globalization.CultureInfo]::InvariantCulture, [Globalization.CompareOptions]::None)
}

# buildChangeReport. $Audit is @{ Changes = mapped events with a source; Note = text or $null } or @{ Error = text }.
function New-TvChangeReport {
    param(
        [Parameter(Mandatory)][object]$Drift,
        [Parameter(Mandatory)][hashtable]$Audit,
        [Parameter(Mandatory)][hashtable]$Options
    )
    $hasAudit = $Audit.ContainsKey("Changes")
    # Events oldest first, ties in the order they were read, like the stable sort of the desktop.
    $events = @()
    if ($hasAudit) {
        $sorted = [System.Collections.Generic.List[object]]::new()
        $position = 0
        foreach ($event in @($Audit.Changes)) { if ($null -ne $event) { $sorted.Add([pscustomobject]@{ Event = $event; Index = $position++ }) } }
        $sorted.Sort([Comparison[object]] { param($a, $b) $c = [string]::CompareOrdinal([string]$a.Event.at, [string]$b.Event.at); if ($c) { $c } else { $a.Index - $b.Index } })
        $events = @($sorted | ForEach-Object { $_.Event })
    }
    $used = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $items = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($entry in $Drift.drifts) {
        $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        if ($entry.configId) { [void]$ids.Add($entry.configId.ToLowerInvariant()) }
        $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in @($entry.configName, $(if ($entry.Contains("previousName")) { $entry.previousName } else { $null }))) { if ($name) { [void]$names.Add(([string]$name).ToLowerInvariant()) } }
        $matching = @($events | Where-Object {
            # A name match only when the event names no ID at all, so two items sharing a name are not mixed up.
            $byId = [bool]$_.resourceId -and $ids.Contains(([string]$_.resourceId).ToLowerInvariant())
            $byName = -not $_.resourceId -and $null -ne $_.resourceName -and $names.Contains(([string]$_.resourceName).ToLowerInvariant())
            $byId -or $byName
        })
        foreach ($event in $matching) { [void]$used.Add($event.auditId) }
        $settings = [System.Collections.Generic.List[object]]::new()
        foreach ($row in @($entry.changes | Where-Object { $null -ne $_ })) {
            if ($entry.changeType -ne "modified" -and [string]$row.field -cmatch $script:SkippedDocumented) { continue }
            $label = Get-TvSettingLabel $row $Drift.settingNames
            $before = $null; $after = $null
            if ($Options.IncludeValues) {
                if ($entry.changeType -ne "added") { $before = Get-TvReportValue $row.field $row.oldValue $label.DefinitionId $Drift.settingNames $label.Property }
                if ($entry.changeType -ne "deleted") { $after = Get-TvReportValue $row.field $row.newValue $label.DefinitionId $Drift.settingNames $label.Property }
            }
            $settings.Add([ordered]@{ name = $label.Label; path = [string]$row.field; before = $before; after = $after })
        }
        $item = [ordered]@{ change = $entry.changeType; type = $entry.type; name = $entry.configName }
        if ($entry.Contains("previousName") -and $entry.previousName) { $item.previousName = $entry.previousName }
        $item.id = $entry.configId
        $item.severity = $entry.severity
        $item.settings = @($settings | Select-Object -First $script:MaxReportSettings)
        $item.moreSettings = [Math]::Max(0, $settings.Count - $script:MaxReportSettings)
        $item.activity = @($matching | ForEach-Object { Get-TvActivity $_ $Options.IncludeActors })
        if ($entry.changeType -ne "added") { $item.restoreFrom = $entry.fromBackup }
        if ($entry.Contains("likelyRestoredCopy") -and $entry.likelyRestoredCopy) { $item.likelyRestoredCopy = $true }
        $items.Add([pscustomobject]@{ Item = $item; Index = $index++ })
    }
    # Type and name compare locale aware, like localeCompare; the sort keeps the drift order for ties.
    $list = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $items) { $list.Add($entry) }
    $list.Sort([Comparison[object]] {
        param($a, $b)
        $c = $script:ChangeOrder[$a.Item.change] - $script:ChangeOrder[$b.Item.change]
        if ($c) { return $c }
        $c = $script:SeverityOrder[$a.Item.severity] - $script:SeverityOrder[$b.Item.severity]
        if ($c) { return $c }
        $c = Compare-TvLocale $a.Item.type $b.Item.type
        if ($c) { return $c }
        $c = Compare-TvLocale $a.Item.name $b.Item.name
        if ($c) { return $c }
        return $a.Index - $b.Index
    })
    $reportItems = @($list | ForEach-Object { $_.Item })
    $other = @($events | Where-Object { -not $used.Contains($_.auditId) } | ForEach-Object {
        $activity = Get-TvActivity $_ $Options.IncludeActors
        $activity.target = if ($null -ne $_.resourceName) { $_.resourceName } elseif ($null -ne $_.resourceType) { $_.resourceType } else { $_.category }
        $activity
    })
    $report = [ordered]@{
        schemaVersion = 1
        tenantId = $Options.TenantId.ToLowerInvariant()
        tenantName = $Options.TenantName
        generatedAt = $Options.GeneratedAt
        trigger = "scheduled"
        from = $Drift.baseline
        to = $Drift.comparison
        summary = [ordered]@{
            added = @($reportItems | Where-Object { $_.change -eq "added" }).Count
            modified = @($reportItems | Where-Object { $_.change -eq "modified" }).Count
            deleted = @($reportItems | Where-Object { $_.change -eq "deleted" }).Count
            critical = @($reportItems | Where-Object { $_.severity -eq "critical" }).Count
            attributed = @($reportItems | Where-Object { @($_.activity).Count -gt 0 }).Count
        }
        items = $reportItems
        otherActivity = @($other | Select-Object -Last $script:MaxOtherActivity)
        moreActivity = [Math]::Max(0, $other.Count - $script:MaxOtherActivity)
        audit = [ordered]@{
            status = if ($hasAudit) { "included" } else { "unavailable" }
            note = Get-TvPublicAuditNote $(if ($hasAudit) { $Audit.Note } else { $Audit.Error })
            actors = [bool]$Options.IncludeActors
        }
        values = [bool]$Options.IncludeValues
        warnings = @($Drift.warnings | Select-Object -First 50)
    }
    return $report
}

function Get-TvActivityLine {
    param([Parameter(Mandatory)][object]$Event)
    $verb = $Event.change.Substring(0, 1).ToUpperInvariant() + $Event.change.Substring(1)
    $who = if ($Event.who) { " by $($Event.who)" } else { "" }
    return "$verb$who, $(Get-TvReportTime $Event.at) ($($Event.source): $($Event.activity))"
}

# ---------------------------------------------------------------------------
# Markdown (mirror changeReportMarkdown)
# ---------------------------------------------------------------------------

function Get-TvMarkdownText {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    $text = (Get-TvRedactedText $Value) -creplace '\r?\n', ' '
    return [regex]::Replace($text, '[\\`*_{}\[\]()#+!|<>~]', { param($m) "\" + $m.Value })
}

function ConvertTo-TvReportMarkdown {
    param([Parameter(Mandatory)][object]$Report)
    $lines = [System.Collections.Generic.List[string]]::new()
    $md = { param($v) Get-TvMarkdownText $v }
    $lines.Add("# $(& $md (Get-TvReportTitle $Report))"); $lines.Add("")
    $lines.Add("- Tenant: $(& $md $Report.tenantName) ($($Report.tenantId))")
    $lines.Add("- From backup: $($Report.from.id) ($(Get-TvReportTime $Report.from.timestamp))")
    $lines.Add("- To backup: $($Report.to.id) ($(Get-TvReportTime $Report.to.timestamp))")
    $lines.Add("- Generated: $(Get-TvReportTime $Report.generatedAt)$(if ($Report.trigger -eq 'scheduled') { ' after a scheduled backup' })")
    $lines.Add("- Summary: $(& $md (Get-TvSummaryLine $Report))")
    $auditNote = Get-TvPublicAuditNote $Report.audit.note
    if ($auditNote) { $lines.Add("- Audit log: $(& $md $auditNote)") }
    if (-not $Report.values) { $lines.Add("- Setting values are left out of this report.") }
    $lines.Add("")
    if (@($Report.items).Count -eq 0) { $lines.Add("No items were added, changed or deleted between the two backups."); $lines.Add("") }
    foreach ($change in @("deleted", "modified", "added")) {
        $items = @($Report.items | Where-Object { $_.change -eq $change })
        if (-not $items.Count) { continue }
        $lines.Add("## $($script:ChangeLabels[$change]) ($($items.Count))"); $lines.Add("")
        foreach ($item in $items) {
            $lines.Add("### $(& $md $item.name)"); $lines.Add("")
            $lines.Add("- Type: $(& $md $item.type)")
            if ($item.Contains("previousName")) { $lines.Add("- Previously named: $(& $md $item.previousName)") }
            $lines.Add("- Severity: $($item.severity)")
            if ($item.id) { $lines.Add("- ID: $(& $md $item.id)") }
            if ($item.Contains("restoreFrom")) { $lines.Add("- Previous version in backup: $($item.restoreFrom)") }
            if ($item.Contains("likelyRestoredCopy")) { $lines.Add("- Likely a copy made by a restore") }
            foreach ($event in @($item.activity)) { $lines.Add("- $(& $md (Get-TvActivityLine $event))") }
            if (-not @($item.activity).Count -and $Report.audit.status -eq "included") { $lines.Add("- No matching audit event in this window") }
            $lines.Add("")
            if (@($item.settings).Count) {
                if (-not $Report.values) {
                    $lines.Add("| Setting |"); $lines.Add("| --- |")
                    foreach ($setting in $item.settings) { $lines.Add("| $(& $md $setting.name) |") }
                } elseif ($change -eq "modified") {
                    $lines.Add("| Setting | Before | After |"); $lines.Add("| --- | --- | --- |")
                    foreach ($setting in $item.settings) { $lines.Add("| $(& $md $setting.name) | $(& $md $(if ($null -ne $setting.before) { $setting.before } else { '' })) | $(& $md $(if ($null -ne $setting.after) { $setting.after } else { '' })) |") }
                } else {
                    $lines.Add("| Setting | Value |"); $lines.Add("| --- | --- |")
                    foreach ($setting in $item.settings) {
                        $value = if ($change -eq "added") { $setting.after } else { $setting.before }
                        $lines.Add("| $(& $md $setting.name) | $(& $md $(if ($null -ne $value) { $value } else { '' })) |")
                    }
                }
                if ($item.moreSettings) { $lines.Add(""); $lines.Add("$($item.moreSettings) more settings are not listed.") }
                $lines.Add("")
            }
        }
    }
    if (@($Report.otherActivity).Count) {
        $lines.Add("## Other activity ($(@($Report.otherActivity).Count + $Report.moreActivity))"); $lines.Add("")
        $lines.Add("Audit events in this window that match no item in the report, for example a change that was undone before the second backup."); $lines.Add("")
        $lines.Add("| When | What | Object | Who |"); $lines.Add("| --- | --- | --- | --- |")
        foreach ($event in $Report.otherActivity) { $lines.Add("| $(Get-TvReportTime $event.at) | $(& $md "$($event.source): $($event.activity)") | $(& $md $(if ($null -ne $event.target) { $event.target } else { '' })) | $(& $md $(if ($null -ne $event.who) { $event.who } else { '' })) |") }
        if ($Report.moreActivity) { $lines.Add(""); $lines.Add("$($Report.moreActivity) older events are not listed.") }
        $lines.Add("")
    }
    if (@($Report.warnings).Count) {
        $lines.Add("## Not compared"); $lines.Add("")
        foreach ($warning in $Report.warnings) { $lines.Add("- $(& $md $warning)") }
        $lines.Add("")
    }
    return ($lines -join "`n").TrimEnd() + "`n"
}

# ---------------------------------------------------------------------------
# HTML (mirror buildChangeReportDocument in change-report-html.ts, TenuVault design)
# ---------------------------------------------------------------------------

$script:ReportFontStack = '"Segoe UI Variable", "Segoe UI", -apple-system, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans CJK JP", "Hiragino Sans", "Microsoft YaHei", sans-serif'
# The resolved TenuVault theme as CSS variables (themeCssVariables(TENUVAULT_THEME)).
$script:ReportRootVariables = @'
:root { --primary: rgb(22 21 20); --strong: rgb(22 21 20); --primary-tint: rgb(238 236 233); --accent: rgb(228 103 75); --accent-text: rgb(201 75 48); --accent-wash: rgb(253 244 241); --accent-border: rgb(247 203 190); --on-band: rgb(255 255 255); --band-muted: rgb(210 206 201); --band-accent: rgb(241 167 146); --band-rule: rgb(62 61 60); --ring-soft: rgb(51 32 28); --ring-strong: rgb(109 55 43); --door: rgb(244 243 241); --ink: rgb(43 41 39); --body: rgb(69 66 62); --muted: rgb(118 113 107); --faint: rgb(163 158 152); --rule: rgb(228 225 221); --border: rgb(218 214 209); --panel: rgb(244 243 241); --zebra: rgb(249 248 247); --tint: rgb(238 236 233); --track: rgb(228 225 221); --dashed: rgb(210 206 201); --white: rgb(255 255 255); --good-text: rgb(24 104 64); --good-fill: rgb(231 242 236); --warn-text: rgb(143 79 16); --warn-fill: rgb(250 239 227); --bad-text: rgb(173 62 38); --bad-fill: rgb(252 236 231); --neutral-text: rgb(71 85 105); --neutral-fill: rgb(238 240 243); --info-text: rgb(22 21 20); --info-fill: rgb(238 236 233); --conflict-text: rgb(185 28 28); --conflict-fill: rgb(251 233 233); }
'@.Trim()
$script:ReportStyle = ("`n" + @'
@page { size: A4; margin: 21mm 15mm 21mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font-family: __FONT_STACK__; color: var(--ink); font-size: 7.6pt; line-height: 1.4; }
h1, h2, h3, p { margin: 0; }
.band { padding: 7mm 7mm 6mm; border-radius: 2.5mm; background: var(--primary); color: var(--on-band); margin-bottom: 6mm; }
.brand { display: flex; align-items: center; gap: 2.4mm; height: 7mm; }
.brand-name { font-size: 10pt; font-weight: 700; }
.logo { display: block; max-width: 40mm; max-height: 10mm; }
.logo.plate { background: var(--white); border-radius: 1.5mm; padding: 1.5mm 2mm; }
.eyebrow { margin-top: 6mm; font-size: 7pt; font-weight: 700; letter-spacing: 0.25mm; text-transform: uppercase; color: var(--band-accent); }
h1 { margin-top: 1.4mm; font-size: 19pt; line-height: 1.15; overflow-wrap: anywhere; }
.period { margin-top: 2mm; font-size: 9pt; color: var(--band-muted); }
.facts { display: flex; flex-wrap: wrap; gap: 1.2mm 8mm; margin-top: 4mm; padding-top: 3mm; border-top: 0.25mm solid var(--band-rule); font-size: 7.6pt; }
.facts span { color: var(--band-muted); margin-right: 1.4mm; }
.tiles { display: flex; gap: 3mm; margin-bottom: 4mm; }
.tile { flex: 1 1 0; min-width: 0; padding: 3.4mm 3.6mm; border: 0.25mm solid var(--border); border-radius: 2mm; }
.tile .key { font-size: 5.8pt; font-weight: 700; letter-spacing: 0.1mm; text-transform: uppercase; color: var(--muted); }
.tile .value { margin-top: 1.2mm; font-size: 18pt; font-weight: 700; line-height: 1; color: var(--strong); }
.lead { margin-bottom: 5mm; font-size: 8.8pt; color: var(--body); }
.callout { padding: 3.4mm 4.4mm; margin-bottom: 5mm; border: 0.25mm solid var(--accent-border); border-radius: 2mm; background: var(--accent-wash); font-size: 8pt; }
.callout b { color: var(--accent-text); }
h2 { margin: 7mm 0 3mm; padding-bottom: 1.4mm; border-bottom: 0.4mm solid var(--strong); font-size: 12pt; color: var(--strong); break-after: avoid; }
.item { margin-bottom: 5mm; break-inside: auto; }
.keep { break-inside: avoid; break-after: avoid; }
.item-head { break-inside: avoid; break-after: avoid; }
h3 { font-size: 10pt; color: var(--strong); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 1.2mm; margin: 1.2mm 0 1.6mm; }
.pill { display: inline-block; padding: 0.5mm 2.2mm; border-radius: 2mm; font-size: 6.4pt; font-weight: 700; }
.tone-good { color: var(--good-text); background: var(--good-fill); }
.tone-warn { color: var(--warn-text); background: var(--warn-fill); }
.tone-bad { color: var(--bad-text); background: var(--bad-fill); }
.tone-neutral { color: var(--neutral-text); background: var(--neutral-fill); }
.meta { font-size: 7.2pt; color: var(--muted); overflow-wrap: anywhere; }
.activity { margin: 1mm 0 2mm; padding: 0; list-style: none; font-size: 7.4pt; color: var(--body); }
.activity li { padding: 0.4mm 0; overflow-wrap: anywhere; }
.activity li::before { content: ""; display: inline-block; width: 1.4mm; height: 1.4mm; margin-right: 1.6mm; border-radius: 50%; background: var(--accent); vertical-align: 0.2mm; }
.unknown { font-style: italic; color: var(--muted); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 1mm; }
thead { display: table-header-group; }
th { padding: 0 1.5mm 1.2mm; text-align: left; font-size: 5.8pt; font-weight: 700; letter-spacing: 0.2mm; text-transform: uppercase; color: var(--muted); border-bottom: 0.3mm solid var(--strong); }
td { padding: 1.6mm 1.5mm; vertical-align: top; border-bottom: 0.2mm solid var(--rule); overflow-wrap: anywhere; font-size: 7.3pt; }
tbody tr:nth-child(even) td { background: var(--zebra); }
tr { break-inside: avoid; }
td.before { color: var(--bad-text); }
td.after { color: var(--good-text); }
td.empty { color: var(--faint); font-style: italic; }
.more { margin-top: 1.2mm; font-size: 7pt; color: var(--muted); }
.none { font-size: 8pt; font-style: italic; color: var(--muted); }
.provenance { margin-top: 8mm; padding-top: 3mm; border-top: 0.2mm solid var(--rule); font-size: 7pt; color: var(--muted); break-inside: avoid; }
@media screen { body { max-width: 210mm; margin: 0 auto; padding: 10mm 12mm; background: var(--white); } }
'@ + "`n").Replace("__FONT_STACK__", $script:ReportFontStack)

function Get-TvHtmlText {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    $text = Get-TvRedactedText $Value
    return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&#39;")
}

function Get-TvCssString {
    param([AllowEmptyString()][string]$Value, [int]$Max)
    $line = ((Get-TvRedactedText $Value) -replace '[\x00-\x1F\x7F]+', ' ').Trim()
    if ($line.Length -gt $Max) { $line = $line.Substring(0, $Max - 3).TrimEnd() + "..." }
    $sb = [Text.StringBuilder]::new()
    foreach ($rune in $line.EnumerateRunes()) {
        $char = $rune.ToString()
        if ($char -cmatch '^[A-Za-z0-9 .,:;|()_-]$') { [void]$sb.Append($char) } else { [void]$sb.Append("\" + $rune.Value.ToString("x") + " ") }
    }
    return '"' + $sb.ToString() + '"'
}

function Get-TvPlural {
    param([int]$Count, [string]$One, [string]$Many)
    if ($Count -eq 1) { return "$Count $One" }
    return "$Count $Many"
}

function ConvertTo-TvReportItemHtml {
    param([Parameter(Mandatory)][object]$Item, [Parameter(Mandatory)][object]$Report)
    $tones = @{ added = "good"; modified = "warn"; deleted = "bad" }
    $chips = "<span class=`"pill tone-$($tones[$Item.change])`">$(Get-TvHtmlText $script:ChangeLabels[$Item.change])</span>"
    $chips += "<span class=`"pill tone-neutral`">$(Get-TvHtmlText $Item.type)</span>"
    if ($Item.severity -ne "info") {
        $tone = if ($Item.severity -eq "critical") { "bad" } else { "warn" }
        $label = if ($Item.severity -eq "critical") { "Critical" } else { "Warning" }
        $chips += "<span class=`"pill tone-$tone`">$(Get-TvHtmlText $label)</span>"
    }
    if ($Item.Contains("likelyRestoredCopy") -and $Item.likelyRestoredCopy) { $chips += '<span class="pill tone-neutral">Likely a restored copy</span>' }
    $meta = @()
    if ($Item.Contains("previousName") -and $Item.previousName) { $meta += "Previously named $($Item.previousName)" }
    if ($Item.id) { $meta += "ID $($Item.id)" }
    if ($Item.Contains("restoreFrom") -and $Item.restoreFrom) { $meta += "Previous version in backup $($Item.restoreFrom)" }
    $metaText = $meta -join " $([char]0x00B7) "
    $activity = ""
    if (@($Item.activity).Count) {
        $activity = '<ul class="activity">' + ((@($Item.activity) | ForEach-Object { "<li>$(Get-TvHtmlText (Get-TvActivityLine $_))</li>" }) -join "") + '</ul>'
    } elseif ($Report.audit.status -eq "included") { $activity = '<p class="activity unknown">No matching audit event in this window.</p>' }
    $cell = {
        param($value, $kind)
        if ($null -eq $value -or $value -ceq "Not set") { return '<td class="empty">Not set</td>' }
        return "<td class=`"$kind`">$(Get-TvHtmlText $value)</td>"
    }
    $table = ""
    if (@($Item.settings).Count) {
        if (-not $Report.values) {
            $table = '<table><thead><tr><th>Setting</th></tr></thead><tbody>' + ((@($Item.settings) | ForEach-Object { "<tr><td>$(Get-TvHtmlText $_.name)</td></tr>" }) -join "") + '</tbody></table>'
        } elseif ($Item.change -eq "modified") {
            $table = '<table><colgroup><col style="width:36%"><col style="width:32%"><col style="width:32%"></colgroup><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>' + ((@($Item.settings) | ForEach-Object { "<tr><td>$(Get-TvHtmlText $_.name)</td>$(& $cell $_.before 'before')$(& $cell $_.after 'after')</tr>" }) -join "") + '</tbody></table>'
        } else {
            $added = $Item.change -eq "added"
            $table = '<table><colgroup><col style="width:40%"><col style="width:60%"></colgroup><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>' + ((@($Item.settings) | ForEach-Object { "<tr><td>$(Get-TvHtmlText $_.name)</td>$(& $cell $(if ($added) { $_.after } else { $_.before }) '')</tr>" }) -join "") + '</tbody></table>'
        }
    }
    $more = if ($Item.moreSettings) { "<p class=`"more`">$(Get-TvPlural $Item.moreSettings 'more setting is' 'more settings are') not listed.</p>" } else { "" }
    $metaHtml = if ($metaText) { "<p class=`"meta`">$(Get-TvHtmlText $metaText)</p>" } else { "" }
    return "<div class=`"item`"><div class=`"item-head`"><h3>$(Get-TvHtmlText $Item.name)</h3><div class=`"chips`">$chips</div>$metaHtml$activity</div>$table$more</div>"
}

function ConvertTo-TvReportHtml {
    param([Parameter(Mandatory)][object]$Report)
    $title = Get-TvReportTitle $Report
    $footer = "TenuVault | Change report"
    $facts = @(@("Tenant", $Report.tenantName), @("Tenant ID", $Report.tenantId), @("Generated", (Get-TvReportTime $Report.generatedAt)))
    $factsHtml = ($facts | ForEach-Object { "<div><span>$(Get-TvHtmlText $_[0])</span><b>$(Get-TvHtmlText $_[1])</b></div>" }) -join ""
    $header = "<header class=`"band`"><div class=`"brand`"><span class=`"brand-name`">TenuVault</span></div>`n<p class=`"eyebrow`">Change report</p><h1>$(Get-TvHtmlText $title)</h1>`n<p class=`"period`">From backup $(Get-TvHtmlText $Report.from.id) ($(Get-TvHtmlText (Get-TvReportTime $Report.from.timestamp))) to $(Get-TvHtmlText $Report.to.id) ($(Get-TvHtmlText (Get-TvReportTime $Report.to.timestamp)))</p>`n<div class=`"facts`">$factsHtml</div></header>"
    $s = $Report.summary
    $tile = { param($label, $value) "<div class=`"tile`"><div class=`"key`">$(Get-TvHtmlText $label)</div><div class=`"value`">$(Get-TvHtmlText ([string]$value))</div></div>" }
    $attributed = if ($Report.audit.status -eq "included") { $s.attributed } else { "Unknown" }
    $tiles = "<div class=`"tiles`">$(& $tile 'Changed' $s.modified)$(& $tile 'Added' $s.added)$(& $tile 'Deleted' $s.deleted)$(& $tile 'Critical' $s.critical)$(& $tile 'With audit events' $attributed)</div>"
    $callouts = ""
    $auditNote = Get-TvPublicAuditNote $Report.audit.note
    if ($Report.audit.status -ne "included") {
        $note = if ($null -ne $auditNote) { $auditNote } else { "The audit log could not be read." }
        $callouts += "<div class=`"callout`"><b>Who made the changes is unknown.</b> $(Get-TvHtmlText $note)</div>"
    } elseif ($auditNote) { $callouts += "<div class=`"callout`"><b>Part of the audit log was not read.</b> $(Get-TvHtmlText $auditNote)</div>" }
    if (-not $Report.values) { $callouts += '<div class="callout"><b>Setting values are left out.</b> This report lists which settings changed, not their values.</div>' }
    $sections = ""
    foreach ($change in @("deleted", "modified", "added")) {
        $items = @($Report.items | Where-Object { $_.change -eq $change })
        if (-not $items.Count) { continue }
        $sections += "<section><h2>$(Get-TvHtmlText $script:ChangeLabels[$change]) ($($items.Count))</h2>" + (($items | ForEach-Object { ConvertTo-TvReportItemHtml $_ $Report }) -join "") + "</section>"
    }
    $empty = if (@($Report.items).Count) { "" } else { '<p class="none">No items were added, changed or deleted between the two backups.</p>' }
    $other = ""
    if (@($Report.otherActivity).Count) {
        $rows = (@($Report.otherActivity) | ForEach-Object {
            $target = if ($null -ne $_.target) { $_.target } else { "" }
            $who = if ($null -ne $_.who) { $_.who } else { "" }
            "<tr><td>$(Get-TvHtmlText (Get-TvReportTime $_.at))</td><td>$(Get-TvHtmlText "$($_.source): $($_.activity)")</td><td>$(Get-TvHtmlText $target)</td><td>$(Get-TvHtmlText $who)</td></tr>"
        }) -join ""
        $moreHtml = if ($Report.moreActivity) { "<p class=`"more`">$(Get-TvPlural $Report.moreActivity 'older event is' 'older events are') not listed.</p>" } else { "" }
        $other = "<section><div class=`"keep`"><h2>Other activity ($(@($Report.otherActivity).Count + $Report.moreActivity))</h2><p class=`"lead`">Audit events in this window that match no item above, for example a change that was undone before the second backup, or an object TenuVault does not back up.</p></div>`n<table><colgroup><col style=`"width:20%`"><col style=`"width:34%`"><col style=`"width:26%`"><col style=`"width:20%`"></colgroup><thead><tr><th>When</th><th>What</th><th>Object</th><th>Who</th></tr></thead><tbody>$rows</tbody></table>$moreHtml</section>"
    }
    $warnings = if (@($Report.warnings).Count) { '<section><h2>Not compared</h2><ul class="activity">' + ((@($Report.warnings) | ForEach-Object { "<li>$(Get-TvHtmlText $_)</li>" }) -join "") + '</ul></section>' } else { "" }
    $provenance = "<p class=`"provenance`">$(Get-TvHtmlText "Generated by TenuVault from the backups $($Report.from.id) and $($Report.to.id) of tenant $($Report.tenantId). Values are shown as the backups recorded them; secret values are never shown. Who made a change comes from the Intune and Entra audit logs and is shown only when an audit event names the item.")</p>"
    $margin = { param($box, $content, $extra) "@$box { content: $content; font-family: $($script:ReportFontStack); font-size: 6.5pt; color: var(--muted); $extra }" }
    $pageBoxes = "@page {`n  $(& $margin 'top-left' (Get-TvCssString $title 90) 'vertical-align: bottom; padding-bottom: 1.6mm; border-bottom: 0.2mm solid var(--rule); width: 130mm; font-weight: 700; color: var(--strong);')`n  $(& $margin 'top-right' (Get-TvCssString $Report.tenantName 40) 'vertical-align: bottom; padding-bottom: 1.6mm; border-bottom: 0.2mm solid var(--rule); width: 50mm; text-align: right;')`n  $(& $margin 'bottom-left' (Get-TvCssString $footer 76) 'vertical-align: top; padding-top: 2.4mm; border-top: 0.2mm solid var(--rule); width: 130mm;')`n  $(& $margin 'bottom-right' '"Page " counter(page) " of " counter(pages)' 'vertical-align: top; padding-top: 2.4mm; border-top: 0.2mm solid var(--rule); width: 50mm; text-align: right;')`n}"
    $head = "<!doctype html><html lang=`"en`"><head><meta charset=`"utf-8`"><meta http-equiv=`"Content-Security-Policy`" content=`"default-src 'none'; style-src 'unsafe-inline'; img-src data:`"><title>$(Get-TvHtmlText $title)</title><style>$($script:ReportRootVariables)$($script:ReportStyle)$pageBoxes</style></head><body>"
    return "$head`n$header`n$tiles`n<p class=`"lead`">$(Get-TvHtmlText (Get-TvSummaryLine $Report))</p>`n$callouts$empty$sections$other$warnings$provenance`n</body></html>"
}

# The email summary the watcher sends (mirror reportEmail in src/main/features/reports): the
# watcher builds the notification envelope and its HTML from these fields.
function Get-TvReportEmail {
    param([Parameter(Mandatory)][object]$Report)
    $s = $Report.summary
    $verbs = @{ added = "Created"; modified = "Changed"; deleted = "Deleted" }
    $items = @(@($Report.items) | Select-Object -First 20 | ForEach-Object {
        $count = @($_.settings).Count + $_.moreSettings
        $detail = $_.type
        if (@($_.settings).Count) { $detail += ", $count $(if ($_.change -eq 'modified') { 'changed ' })$(if ($count -eq 1) { 'setting' } else { 'settings' })" }
        $entry = [ordered]@{ title = "$($verbs[$_.change]): $($_.name)"; detail = $detail }
        $first = @($_.activity) | Select-Object -First 1
        if ($first -and $first.who) { $entry.actor = $first.who }
        if ($first) { $entry.at = $first.at }
        $entry
    })
    return [ordered]@{
        severity = if ($s.deleted -gt 0 -or $s.critical -gt 0) { "warning" } else { "info" }
        title = Get-TvReportTitle $Report
        summary = Get-TvSummaryLine $Report
        naturalKey = "report:$($Report.from.id):$($Report.to.id):$($Report.generatedAt)"
        occurredAt = $Report.generatedAt
        details = @(
            [ordered]@{ label = "From backup"; value = $Report.from.id },
            [ordered]@{ label = "To backup"; value = $Report.to.id },
            [ordered]@{ label = "Changed"; value = [string]$s.modified },
            [ordered]@{ label = "Added"; value = [string]$s.added },
            [ordered]@{ label = "Deleted"; value = [string]$s.deleted }
        )
        items = $items
        moreCount = [Math]::Max(0, @($Report.items).Count - 20)
    }
}

# ---------------------------------------------------------------------------
# Audit events (mirror mapAuditEvent in src/shared/notifications/audit.ts, as the watcher does;
# a change report matches items by resourceId, the object the event names)
# ---------------------------------------------------------------------------

function Get-TvAuditText {
    param([AllowNull()][object]$Value)
    if ($Value -is [string] -and $Value.Trim()) {
        $trimmed = $Value.Trim()
        if ($trimmed.ToLowerInvariant() -eq "<null>") { return $null }
        return $trimmed
    }
    return $null
}

function ConvertFrom-TvAuditEvent {
    param([AllowNull()][object]$Raw)
    if ($null -eq $Raw) { return $null }
    $id = Get-TvAuditText (Get-TvProp $Raw "id")
    $atText = Get-TvAuditText (Get-TvProp $Raw "activityDateTime")
    $parsed = [DateTimeOffset]::MinValue
    if (-not $id -or -not $atText -or -not [DateTimeOffset]::TryParse($atText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) { return $null }
    $at = $parsed.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    $operationText = Get-TvAuditText (Get-TvProp $Raw "activityOperationType")
    $operationLower = if ($operationText) { $operationText.ToLowerInvariant() } else { "" }
    if ($operationLower -eq "get" -or $operationLower -eq "search") { return $null }
    $resultText = Get-TvAuditText (Get-TvProp $Raw "activityResult")
    $resultLower = if ($resultText) { $resultText.ToLowerInvariant() } else { "" }
    if ($resultLower.Contains("fail") -or $resultLower.Contains("error")) { return $null }
    # Live events carry the operation in activityType with activity null, like mapAuditEvent.
    $activity = Get-TvAuditText (Get-TvProp $Raw "activity")
    if (-not $activity) { $activity = Get-TvAuditText (Get-TvProp $Raw "activityType") }
    if (-not $activity) { $activity = Get-TvAuditText (Get-TvProp $Raw "displayName") }
    $activityLower = (@((Get-TvAuditText (Get-TvProp $Raw "activityType")), (Get-TvAuditText (Get-TvProp $Raw "activity")), (Get-TvAuditText (Get-TvProp $Raw "displayName"))) -join " ").ToLowerInvariant()
    $resources = @(@(Get-TvProp $Raw "resources") | Where-Object { $_ -is [System.Collections.IDictionary] })
    $isAssignment = $activityLower.Contains("assignment")
    if (-not $isAssignment) {
        foreach ($entry in $resources) {
            $entryType = (@((Get-TvAuditText (Get-TvProp $entry "type")), (Get-TvAuditText (Get-TvProp $entry "auditResourceType"))) -join " ").ToLowerInvariant()
            if ($entryType.Contains("assignment")) { $isAssignment = $true; break }
        }
    }
    $changeType = "changed"
    if ($isAssignment) {
        if ($operationLower.Contains("delet") -or $operationLower.Contains("remov") -or $activityLower -match "(^|\s)(delete|remove|unassign)") { $changeType = "unassigned" } else { $changeType = "assigned" }
    } else {
        foreach ($source in @($operationLower, $activityLower)) {
            if ($source.Contains("assign")) { $changeType = "assigned"; break }
            if ($source.Contains("creat") -or $source -eq "post") { $changeType = "created"; break }
            if ($source.Contains("delet") -or $source.Contains("remov") -or $source -eq "delete") { $changeType = "deleted"; break }
            if ($source.Contains("updat") -or $source.Contains("patch") -or $source.Contains("edit") -or $source -eq "put") { $changeType = "updated"; break }
        }
    }
    $resource = $null
    foreach ($entry in $resources) { if (Get-TvAuditText (Get-TvProp $entry "displayName")) { $resource = $entry; break } }
    if (-not $resource -and $resources.Count -gt 0) { $resource = $resources[0] }
    $resourceName = if ($resource) { Get-TvAuditText (Get-TvProp $resource "displayName") } else { $null }
    if ($resourceName -and $resourceName.Length -gt 200) { $resourceName = $resourceName.Substring(0, 200) }
    $resourceType = $null
    if ($resource) {
        $resourceType = Get-TvAuditText (Get-TvProp $resource "type")
        if (-not $resourceType) { $resourceType = Get-TvAuditText (Get-TvProp $resource "auditResourceType") }
    }
    if (-not $resourceType) { $resourceType = Get-TvAuditText (Get-TvProp $Raw "componentName") }
    $actor = Get-TvProp $Raw "actor"
    $category = Get-TvAuditText (Get-TvProp $Raw "category")
    return [ordered]@{
        auditId = $id; at = $at; category = $(if ($category) { $category } else { "Unknown" }); changeType = $changeType
        resourceName = $resourceName; resourceType = $resourceType
        actorUpn = Get-TvAuditText (Get-TvProp $actor "userPrincipalName"); actorAppId = Get-TvAuditText (Get-TvProp $actor "applicationId"); actorAppName = Get-TvAuditText (Get-TvProp $actor "applicationDisplayName")
        activity = $(if ($activity) { $activity } else { "Change" })
        resourceId = $(if ($resource) { $resourceIdText = Get-TvAuditText (Get-TvProp $resource "resourceId"); if ($resourceIdText -and $resourceIdText.Length -gt 200) { $resourceIdText.Substring(0, 200) } else { $resourceIdText } } else { $null })
        source = "Intune"
    }
}

# ---------------------------------------------------------------------------
# Reading the previous backup, setting names and audit events, and leaving the report
# ---------------------------------------------------------------------------

# Backups in Azure are plain JSON. Blobs sealed in the legacy TVAZ1 envelope (cloud backups
# before runbook 1.2.0, desktop backups before plain Azure backups) need a key this runbook never
# has, so they are recognised by their first bytes, like isLegacySealed, and never opened.
class TvSealedBlobError : System.Exception {
    TvSealedBlobError([string]$message) : base($message) { }
}

function Test-TvSealedBlob {
    param([AllowNull()][byte[]]$Raw)
    $magic = [Text.Encoding]::ASCII.GetBytes("TVAZ1`n")
    if ($null -eq $Raw -or $Raw.Length -lt $magic.Length) { return $false }
    for ($i = 0; $i -lt $magic.Length; $i++) { if ($Raw[$i] -ne $magic[$i]) { return $false } }
    return $true
}

# The most TenuVault reads of one backup file, like MAX_BACKUP_ARCHIVE_BYTES in the app.
$script:MaxBlobBytes = 33554432

# One plain JSON object from intune-backups, at most $script:MaxBlobBytes, checked before it is
# buffered or parsed. A sealed blob throws TvSealedBlobError, a larger one TvOversizedError, a
# missing one TvHttpError 404, and anything that is not a JSON object a plain error.
function Read-TvPlainJson {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$BlobName)
    $target = Get-TvBlobTarget $Context.StorageAccount $BlobName
    $file = ($BlobName -split "/")[-1]
    $tooLarge = "$file is larger than the 32 MiB TenuVault reads."
    try { $result = Invoke-TvHttp -Uri $target.Uri -Token $Context.StorageToken -Method "Get" -Headers @{ "x-ms-version" = "2021-12-02" } -MaxBytes $script:MaxBlobBytes }
    catch [TvOversizedError] { throw [TvOversizedError]::new($tooLarge) }
    catch [TvReadTimeoutError] { throw [TvReadTimeoutError]::new("$file did not arrive within $($script:BodyReadSeconds) seconds.") }
    if ($result.Bytes.Length -gt $script:MaxBlobBytes) { throw [TvOversizedError]::new($tooLarge) }
    if (Test-TvSealedBlob $result.Bytes) { throw [TvSealedBlobError]::new("The backup file is sealed with a key from before plain Azure backups, which TenuVault in Azure does not have.") }
    try { $value = ConvertFrom-TvJson ([Text.Encoding]::UTF8.GetString($result.Bytes)) } catch { throw "The backup file is not valid JSON." }
    if ($value -isnot [System.Collections.IDictionary]) { throw "The backup file is not a JSON object." }
    return , $value
}

# A recorded tenant, like validTenant in backup-ownership.ts: a string that is not blank.
function Test-TvRecordedTenant { param([AllowNull()][object]$Value) return ($Value -is [string]) -and $Value.Trim() -ne "" }

# The ownership marker of a backup folder: owned, other (names another tenant), missing, sealed or
# unreadable (too large, damaged, or naming no tenant), like the marker step of resolveBackupOwnership.
function Read-TvOwnerMarker {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$Name)
    try { $marker = Read-TvPlainJson $Context "$Name/.tenuvault-owner.json" }
    catch [TvSealedBlobError] { return "sealed" }
    catch [TvHttpError] { if ($_.Exception.Status -eq 404) { return "missing" } return "unreadable" }
    catch { return "unreadable" }
    $recorded = $marker["TenantId"]
    if (-not (Test-TvRecordedTenant $recorded)) { return "unreadable" }
    if ($recorded.ToLowerInvariant() -eq $Context.TenantId.ToLowerInvariant()) { return "owned" }
    return "other"
}

# Whether a backup belongs to this tenant, with the rules of resolveBackupOwnership: the
# manifest's TenantId decides; a manifest that names no tenant is placed by the ownership marker.
# Only a positive match counts: another tenant, an untagged backup, a damaged marker or a
# manifest with an invalid tenant are never compared with.
function Test-TvOwnedBackup {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][System.Collections.IDictionary]$Metadata, [Parameter(Mandatory)][string]$Marker)
    if ($Metadata.Contains("TenantId")) {
        $recorded = $Metadata["TenantId"]
        if (-not (Test-TvRecordedTenant $recorded)) { return $false }
        return $recorded.ToLowerInvariant() -eq $Context.TenantId.ToLowerInvariant()
    }
    return $Marker -eq "owned"
}

# A complete backup to compare with: Status (or status) Success, Succeeded or Completed, like the
# app's status normalizer, and no recorded failures (Failures 0 or absent).
function Test-TvCompleteBackup {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Metadata)
    $status = Get-TvProp $Metadata "Status"
    if ($null -eq $status) { $status = Get-TvProp $Metadata "status" }
    if ($status -isnot [string] -or $status.Trim().ToLowerInvariant() -notin @("success", "succeeded", "completed")) { return $false }
    $failures = Get-TvProp $Metadata "Failures"
    if ((Test-TvJsNumber $failures) -and $failures -gt 0) { return $false }
    return $true
}

# "backup-2026-11-05-020000" as 2026-11-05T02:00:00.000Z, like backupFoldersIn.
function Get-TvBackupTimestamp {
    param([Parameter(Mandatory)][string]$Name)
    $match = [regex]::Match($Name, '^backup-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})$')
    if (-not $match.Success) { return $null }
    return "$($match.Groups[1].Value)T$($match.Groups[2].Value):$($match.Groups[3].Value):$($match.Groups[4].Value).000Z"
}

function Get-TvBackupRef {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][object]$Metadata)
    $trigger = Get-TvProp $Metadata "Trigger"
    if ($null -eq $trigger) { $trigger = Get-TvProp $Metadata "trigger" }
    $status = Get-TvProp $Metadata "Status"
    if ($null -eq $status) { $status = Get-TvProp $Metadata "status" }
    return [ordered]@{ id = $Name; timestamp = Get-TvBackupTimestamp $Name; trigger = $(if ($trigger -is [string]) { $trigger } else { $null }); status = $(if ($null -ne $status) { ConvertTo-TvJsString $status } else { "unknown" }) }
}

# Bounds of the search for the previous backup. Ownership markers are tiny, so other tenants'
# folders in a shared storage account are skipped by their marker without downloading their
# manifest, and cannot crowd out this tenant's backups: up to 500 earlier folders are looked
# at, and at most 30 manifests (each at most 32 MiB) are read.
$script:MaxPredecessorFolders = 500
$script:MaxPredecessorManifests = 30

# The newest complete plain backup of this tenant older than $Current that records item
# fingerprints. Sealed backups cannot be opened here: they are skipped and counted, and Notes
# says why other folders were skipped or the search stopped, for the job output.
function Find-TvPreviousBackup {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$Current)
    $names = [System.Collections.Generic.List[string]]::new()
    $marker = $null
    do {
        $uri = "https://$($Context.StorageAccount).blob.core.windows.net/$script:Container`?restype=container&comp=list&delimiter=/&prefix=backup-&maxresults=5000"
        if ($marker) { $uri += "&marker=$([uri]::EscapeDataString($marker))" }
        $text = (Invoke-TvHttp -Uri $uri -Token $Context.StorageToken -Method "Get" -Headers @{ "x-ms-version" = "2021-12-02" }).Text
        foreach ($match in [regex]::Matches($text, '<BlobPrefix><Name>(backup-\d{4}-\d{2}-\d{2}-\d{6})/</Name></BlobPrefix>')) { $names.Add($match.Groups[1].Value) }
        $marker = [regex]::Match($text, '<NextMarker>([^<]+)</NextMarker>').Groups[1].Value
    } while ($marker)
    $older = @($names | Where-Object { [string]::CompareOrdinal($_, $Current) -lt 0 } | Sort-Object -Descending -CaseSensitive -Unique)
    $sealed = 0
    $notes = [System.Collections.Generic.List[string]]::new()
    $examined = 0
    $manifests = 0
    foreach ($name in $older) {
        if ($examined -ge $script:MaxPredecessorFolders -or $manifests -ge $script:MaxPredecessorManifests) {
            $notes.Add("Stopped looking for an earlier backup after $examined folders and $manifests manifests.")
            break
        }
        $examined++
        # Tenant evidence first: a folder whose marker names another tenant is never this tenant's
        # (the manifest of a backup names the same tenant as its marker), so it is skipped unread.
        $owner = Read-TvOwnerMarker $Context $name
        if ($owner -eq "other") { continue }
        $manifests++
        try { $metadata = Read-TvPlainJson $Context "$name/metadata.json" }
        catch [TvSealedBlobError] { $sealed++; continue }
        catch [TvOversizedError] { $notes.Add("Skipped $($name): $($_.Exception.Message)"); continue }
        catch [TvReadTimeoutError] { $notes.Add("Skipped $($name): $($_.Exception.Message)"); continue }
        catch { continue }
        if (-not (Test-TvOwnedBackup $Context $metadata $owner)) { continue }
        if (-not (Test-TvCompleteBackup $metadata)) { continue }
        if ((Get-TvProp $metadata "Items") -isnot [System.Collections.IDictionary]) { continue }
        return @{ Name = $name; Metadata = $metadata; Sealed = $sealed; Notes = $notes }
    }
    return @{ Name = $null; Sealed = $sealed; Notes = $notes }
}

# Setting definitions from Graph, one read each: the runbook only ever reads from Graph, so no
# $batch POST. Unknown IDs (404) are recorded as unknown; any other failure stops the lookup and
# keeps what was read, like readSettingNames, since names only make the report easier to read.
function Read-TvSettingDefinitions {
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Ids, [Parameter(Mandatory)][string]$GraphToken)
    $definitions = @{}
    foreach ($id in $Ids) {
        try { $definitions[$id] = Invoke-TvGraphGet "deviceManagement/configurationSettings/$([uri]::EscapeDataString($id))" $GraphToken }
        catch [TvHttpError] {
            if ($_.Exception.Status -eq 404) { $definitions[$id] = $null; continue }
            break
        }
    }
    return $definitions
}

# Intune audit events between the two backups, like readAudit in the desktop app. No $orderby:
# with it, Graph scans the whole audit history from the oldest event and answers with empty
# pages until it reaches the window; the report sorts the events itself.
function Read-TvReportAudit {
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To, [Parameter(Mandatory)][string]$GraphToken)
    $select = "id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources"
    $filter = [uri]::EscapeDataString("activityDateTime gt $From and activityDateTime le $To and activityOperationType ne 'Get' and activityOperationType ne 'Search'")
    $next = "$script:GraphBeta/deviceManagement/auditEvents?`$select=$select&`$filter=$filter&`$top=200"
    $changes = [System.Collections.Generic.List[object]]::new()
    $pages = 0
    try {
        while ($next -and $pages -lt 200 -and $changes.Count -le 2000) {
            $pages++
            $page = Invoke-TvGraphGet $next $GraphToken
            foreach ($raw in @(Get-TvProp $page "value")) { $change = ConvertFrom-TvAuditEvent $raw; if ($change) { $changes.Add($change) } }
            $next = Get-TvProp $page "@odata.nextLink"
        }
    } catch [TvHttpError] {
        if ($_.Exception.Status -eq 403) { return @{ Error = "Microsoft Graph returned 403 for the Intune audit log. The cloud backup identity needs DeviceManagementApps.Read.All." } }
        if ($_.Exception.Status -eq 429) { return @{ Error = "The Intune audit log could not be read: Microsoft Graph throttled the request (429). Generate the report again in a few minutes." } }
        return @{ Error = "The Intune audit log could not be read: $(Get-TvSafeError $_.Exception.Message)" }
    }
    $note = $null
    if ($changes.Count -gt 2000) { $note = "More than 2000 Intune audit events in this window; not all of them were read, so some changes may have no actors." }
    elseif ($next) { $note = "The Intune audit log was not read to the end of this window, so some changes may have no actors." }
    # Unordered pages: the oldest events are kept, so the report still names who started the changes.
    $kept = @($changes | Sort-Object -Property @{ Expression = { [string]$_.at } } -Stable | Select-Object -First 2000)
    return @{ Changes = $kept; Note = $note }
}

# After a successful backup: the report of what changed since the previous complete backup,
# left in the results container for the watcher. Best effort: never fails the backup.
# The change report level from TenuVaultChangeReport: "names", "full" or "off".
function Get-TvChangeReportLevel {
    $level = ([string](Get-TvAutomationVariable "TenuVaultChangeReport")).Trim().ToLowerInvariant()
    if ($level -in @("names", "full")) { return $level }
    return "off"
}

function Invoke-TvChangeReport {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$BackupFolder, [Parameter(Mandatory)][object]$Metadata, [Parameter(Mandatory)][object[]]$Types, [Parameter(Mandatory)][string]$GraphToken, [Parameter(Mandatory)][string]$RunId)
    $level = Get-TvChangeReportLevel
    if ($level -eq "off") { return }
    try {
        $previous = Find-TvPreviousBackup $Context $BackupFolder
        foreach ($line in $previous.Notes) { Write-Output $line }
        if (-not $previous.Name) {
            $why = if ($previous.Sealed) { " ($($previous.Sealed) earlier backup(s) sealed before plain Azure backups were skipped: TenuVault in Azure cannot open them)" } else { "" }
            Write-Output "No earlier complete plain backup of this tenant to compare with$why, so no change report was made."
            return
        }
        if ($previous.Sealed) { Write-Output "Skipped $($previous.Sealed) newer backup(s) sealed before plain Azure backups: TenuVault in Azure cannot open them. Comparing with $($previous.Name)." }
        $older = @{ Name = $previous.Name; Metadata = $previous.Metadata }
        $newer = @{ Name = $BackupFolder; Metadata = $Metadata }
        $readItem = { param($backup, $file) Read-TvPlainJson $Context "$backup/$file" }
        $compared = Get-TvBackupDrifts -Older $older -Newer $newer -Types $Types -ReadItem $readItem
        $rows = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in $compared.Drifts) { foreach ($row in @($entry.changes | Where-Object { $null -ne $_ })) { $rows.Add($row) } }
        $ids = [string[]](Get-TvDefinitionIds $rows)
        $names = ConvertTo-TvSettingNames $ids $(if ($ids.Count) { Read-TvSettingDefinitions $ids $GraphToken } else { @{} })
        $baseline = Get-TvBackupRef $older.Name $older.Metadata
        $comparison = Get-TvBackupRef $newer.Name $newer.Metadata
        $audit = Read-TvReportAudit $baseline.timestamp $comparison.timestamp $GraphToken
        $drift = @{ drifts = $compared.Drifts; warnings = $compared.Warnings; settingNames = $names; baseline = $baseline; comparison = $comparison }
        $tenantName = Get-TvAutomationVariable "TenuVaultTenantName"
        $options = @{
            TenantId = $Context.TenantId; TenantName = $(if ($tenantName) { [string]$tenantName } else { $Context.TenantId })
            GeneratedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
            IncludeValues = $level -eq "full"; IncludeActors = ([string](Get-TvAutomationVariable "TenuVaultChangeReportActors")).Trim().ToLowerInvariant() -ne "false"
        }
        $report = New-TvChangeReport -Drift $drift -Audit $audit -Options $options
        $fileName = Get-TvReportFileName $report
        $note = [ordered]@{
            schema = "tenuvault.cloud-change-report/v1"
            tenantId = $Context.TenantId.ToLowerInvariant()
            runId = $RunId
            backupFolder = $BackupFolder
            createdAt = $options.GeneratedAt
            changes = @($report.items).Count
            email = Get-TvReportEmail $report
            files = @(
                [ordered]@{ name = "$fileName.html"; contentType = "text/html"; content = ConvertTo-TvReportHtml $report },
                [ordered]@{ name = "$fileName.md"; contentType = "text/markdown"; content = ConvertTo-TvReportMarkdown $report }
            )
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-TvJsJson $note))
        if ($bytes.Length -gt 3500000) {
            # Too large for one mail: the HTML goes first, then the Markdown, so the summary still arrives.
            $note.files = @($note.files | Select-Object -Last 1)
            $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-TvJsJson $note))
            if ($bytes.Length -gt 3500000) { $note.files = @(); $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-TvJsJson $note)) }
        }
        $uri = "https://$($Context.StorageAccount).blob.core.windows.net/$script:OutcomeContainer/$script:ReportPrefix$([uri]::EscapeDataString($BackupFolder)).json"
        $headers = @{ "x-ms-blob-type" = "BlockBlob"; "x-ms-version" = "2021-12-02"; "x-ms-date" = [DateTime]::UtcNow.ToString("R", [Globalization.CultureInfo]::InvariantCulture); "If-None-Match" = "*" }
        [void](Invoke-TvHttp -Uri $uri -Token $Context.StorageToken -Method "Put" -Headers $headers -BodyBytes $bytes -ContentType "application/json; charset=utf-8")
        Write-Output "Left a change report for the notification watcher: $(Get-TvSummaryLine $report)"
    } catch [TvHttpError] {
        $code = $_.Exception.Status
        if ($code -in @(409, 412)) { Write-Output "The change report for this backup was already left for the notification watcher." }
        else { Write-Output "No change report was made: $(Get-TvSafeError $_.Exception.Message)" }
    } catch {
        Write-Output "No change report was made: $(Get-TvSafeError $_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# One backup run
# ---------------------------------------------------------------------------

function Set-TvCloudStatus {
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Message,
        [AllowNull()][string]$BackupFolder
    )
    $body = [ordered]@{
        LastRunAt      = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
        LastStatus     = $Status
        LastMessage    = $Message
        BackupFolder   = $BackupFolder
        RunbookVersion = $script:RunbookVersion
        Source         = "TenuVault Cloud Backup"
        TenantId       = $Context.TenantId.ToLowerInvariant()
    } | ConvertTo-Json
    try { Set-TvBlob $Context.StorageAccount "$script:StatusBlobPrefix$($Context.TenantId.Substring(0, 8).ToLowerInvariant()).json" $body $Context.StorageToken }
    catch { Write-Output "Could not record the cloud backup status: $(Get-TvSafeError $_.Exception.Message)" }
}

function Invoke-TvBackup {
    $started = [DateTime]::UtcNow
    $runId = [guid]::NewGuid().ToString()
    $tenantId = Get-TvRequiredVariable "TenuVaultTenantId"
    if ($tenantId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw "TenuVaultTenantId is not a tenant id (GUID)." }
    $storageAccount = Get-TvRequiredVariable "TenuVaultStorageAccount"
    if ($storageAccount -notmatch '^[a-z0-9]{3,24}$') { throw "TenuVaultStorageAccount is not a storage account name." }

    $scope = Get-TvAutomationVariable "TenuVaultScope"
    $excluded = Get-TvFolderList (Get-TvAutomationVariable "TenuVaultExcludedFolders")
    if (-not $excluded.Count -and $scope -eq "policies") { $excluded = @("Apps") }
    if ([string](Get-TvAutomationVariable "TenuVaultIncludeConditionalAccess") -ne "true") { $excluded = @($excluded) + $script:ConditionalAccessFolders }
    $appOnlyExcluded = Get-TvFolderList (Get-TvAutomationVariable "TenuVaultAppOnlyExcluded")

    Write-Output "Backing up tenant $tenantId to storage account $storageAccount (runbook $script:RunbookVersion, run $runId)."
    # The storage token comes first: the status blob and the result note need only it, so
    # every later failure (Graph token, a scope that leaves nothing) is still recorded and
    # reaches the notification watcher as Failed. A run that cannot even get a storage token
    # is reported by the Azure Monitor alert on failed jobs.
    $storageToken = Get-TvManagedIdentityToken "https://storage.azure.com/"
    $context = @{ TenantId = $tenantId; StorageAccount = $storageAccount; StorageToken = $storageToken }
    try {
        $graphToken = Get-TvManagedIdentityToken "https://graph.microsoft.com/"

        $allTypes = Get-TvTypes
        $known = @($allTypes | ForEach-Object { $_.Folder })
        $excluded = @($known | Where-Object { $excluded -contains $_ })
        $notReadable = @($known | Where-Object { $appOnlyExcluded -contains $_ -and $excluded -notcontains $_ })
        $types = @($allTypes | Where-Object { $excluded -notcontains $_.Folder -and $appOnlyExcluded -notcontains $_.Folder })
        if (-not $types.Count) { throw "The configured scope leaves nothing to back up." }
    } catch {
        Set-TvCloudStatus $context "Failed" (Get-TvSafeError $_.Exception.Message) $null
        Send-TvBackupOutcome -Account $storageAccount -Token $storageToken -TenantId $tenantId -RunId $runId -Status "Failed" -BackupFolder $null -TotalPolicies $null
        throw
    }
    if ($excluded.Count) { Write-Output "Leaving out $($excluded.Count) of $($known.Count) types: $($excluded -join ', ')." }
    if ($notReadable.Count) { Write-Output "Leaving out $($notReadable.Count) type(s) the cloud identity has no permission for: $($notReadable -join ', '). Desktop backups include them." }

    # List everything first, like the desktop engine, so a denied list is reported per type.
    # A run that stops anywhere before the write phase still records why.
    try {
    $counts = [ordered]@{}
    foreach ($type in $types) { $counts[$type.Folder] = 0 }
    $lists = @{}
    $skippedTypes = [System.Collections.Generic.List[string]]::new()
    $failedTypes = [System.Collections.Generic.List[string]]::new()
    $failures = 0
    $consecutiveAuth = 0
    foreach ($type in $types) {
        try {
            $listPath = [string]$type.Path
            if ($type.ListQuery) { $listPath += "?" + $type.ListQuery }
            $all = if ($type.Singleton) {
                $one = Invoke-TvGraphGet $listPath $graphToken
                Set-TvProp $one "id" $type.Singleton.Id
                @($one)
            } else { @(Invoke-TvGraphList $listPath $graphToken) }
            $kept = [System.Collections.Generic.List[object]]::new()
            $seen = [System.Collections.Generic.HashSet[string]]::new()
            $skippedBuiltIn = 0
            foreach ($item in $all) {
                if (Test-TvSkipped $type $item) { $skippedBuiltIn++; continue }
                $id = [string](Get-TvProp $item "id")
                if (-not $seen.Add($id.ToLowerInvariant())) { continue }
                $kept.Add($item)
            }
            Write-Output "Found $($kept.Count) $($type.Label)$(if ($skippedBuiltIn) { " ($skippedBuiltIn built-in skipped)" })."
            $lists[$type.Folder] = @{ Type = $type; Items = $kept }
            $consecutiveAuth = 0
        } catch [TvHttpError] {
            $status = $_.Exception.Status
            if ($status -eq 401) { throw }
            if ($status -in @(401, 403)) {
                if (++$consecutiveAuth -ge 5) { throw "Backup stopped: Microsoft Graph refused five reads in a row ($status). Check the managed identity's Graph application roles." }
            } else { $consecutiveAuth = 0 }
            if ($status -eq 403 -and $script:OriginalFolders -notcontains $type.Folder) {
                $skippedTypes.Add([string]$type.Folder)
                Write-Output "Skipped $($type.Label): access was denied. The managed identity may lack the permission or admin consent."
            } else {
                $failures++
                $failedTypes.Add([string]$type.Folder)
                Write-Output "Could not read $($type.Label): $(Get-TvSafeError $_.Exception.Message)"
            }
        }
    }

    # Claim the folder before writing any policy. The create-only write is atomic.
    $backupFolder = "backup-$(ConvertTo-TvFolderTimestamp $started)"
    $owner = [ordered]@{ Source = "TenuVault Cloud Backup"; TenantId = $tenantId.ToLowerInvariant(); RunId = $runId } | ConvertTo-Json -Compress
    try {
        Set-TvBlob $storageAccount "$backupFolder/.tenuvault-owner.json" $owner $storageToken -CreateOnly
    } catch [TvHttpError] {
        if ($_.Exception.Status -in @(409, 412)) {
            throw "Backup folder $backupFolder is already in use by another backup for this tenant and storage. Nothing from this backup was written. Wait for the other backup to finish, then try again."
        }
        throw
    }
    } catch {
        Set-TvCloudStatus $context "Failed" (Get-TvSafeError $_.Exception.Message) $null
        Send-TvBackupOutcome -Account $storageAccount -Token $storageToken -TenantId $tenantId -RunId $runId -Status "Failed" -BackupFolder $null -TotalPolicies $null -Failures $failures -FailedTypes @($failedTypes)
        throw
    }

    $items = [ordered]@{}
    $maskedItems = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($type in $types) {
            $list = $lists[$type.Folder]
            if (-not $list) { continue }
            $used = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($item in $list.Items) {
                $id = [string](Get-TvProp $item "id")
                $displayName = Get-TvItemName $type $item
                $fileName = Get-TvUniqueName (Get-TvSafeFileName $displayName) $id $used
                try {
                    $outcome = @{ Masked = $false }
                    $detail = Read-TvObject $type $id $graphToken $outcome
                    $body = $detail | ConvertTo-Json -Depth 100
                    Set-TvBlob $storageAccount "$backupFolder/$($type.Folder)/$fileName.json" $body $storageToken
                    $record = [ordered]@{ file = "$fileName.json"; hash = Get-TvSnapshotHash $detail }
                    if ($type.AssignmentsFormerlyExpanded) {
                        $without = Copy-TvDeep $detail
                        Set-TvProp $without "assignments" @()
                        $record.hashWithEmptyAssignments = Get-TvSnapshotHash $without
                    }
                    $maskedView = Get-TvMaskedView $detail
                    if ($maskedView) { $record.hashWithMaskedSecrets = Get-TvSnapshotHash $maskedView }
                    if ($outcome.Masked) {
                        $record.secretsMasked = $true
                        $maskedItems.Add([ordered]@{ Folder = [string]$type.Folder; Id = $id; Name = $displayName })
                    }
                    $items["$($type.Folder)/$id"] = $record
                    $counts[$type.Folder]++
                } catch [TvHttpError] {
                    if ($_.Exception.Status -eq 401) { throw }
                    if ($_.Exception.Status -in @(401, 403)) {
                        if (++$consecutiveAuth -ge 5) { throw "Backup stopped: Microsoft Graph refused five reads in a row. Earlier policies in this run were saved; the backup is incomplete." }
                    } else { $consecutiveAuth = 0 }
                    $failures++
                    Write-Output "Could not back up `"$displayName`": $(Get-TvSafeError $_.Exception.Message)"
                } catch {
                    $failures++
                    Write-Output "Could not back up `"$displayName`": $(Get-TvSafeError $_.Exception.Message)"
                }
            }
            if ($list.Items.Count) { Write-Output "Backed up $($counts[$type.Folder]) $($type.Label)." }
        }

        $ended = [DateTime]::UtcNow
        $seconds = [int][Math]::Round(($ended - $started).TotalSeconds)
        $totalPolicies = 0
        foreach ($count in $counts.Values) { $totalPolicies += $count }
        $itemCounts = [ordered]@{}
        foreach ($key in $counts.Keys) { $itemCounts[$key] = $counts[$key] }
        $itemCounts.TotalPolicies = $totalPolicies
        $sortedItems = [ordered]@{}
        foreach ($key in @($items.Keys | Sort-Object)) { $sortedItems[$key] = $items[$key] }
        $status = if ($failures -gt 0) { if ($totalPolicies -eq 0) { "Failed" } else { "CompletedWithWarnings" } } else { "Success" }
        $metadata = [ordered]@{
            BackupDate     = ConvertTo-TvFolderTimestamp $started
            BackupFolder   = $backupFolder
            StartTime      = ConvertTo-TvDisplayTime $started
            EndTime        = ConvertTo-TvDisplayTime $ended
            Duration       = if ($seconds -lt 60) { "${seconds}s" } else { "{0}m {1}s" -f [Math]::Floor($seconds / 60), ($seconds % 60) }
            DurationSeconds = $seconds
            ItemCounts     = $itemCounts
            Status         = $status
            RunbookVersion = $script:RunbookVersion
            BackupFormat   = "Individual policy files with Intune-compatible JSON"
            Source         = "TenuVault Cloud Backup"
            TenantId       = $tenantId.ToLowerInvariant()
            Trigger        = "scheduled"
            RunId          = $runId
            Scope          = [ordered]@{ Excluded = $excluded; Included = @($types | ForEach-Object { $_.Folder }) }
            Failures       = $failures
            SkippedTypes   = @($skippedTypes)
            FailedTypes    = @($failedTypes)
            AuthMode       = "app-only"
        }
        if ($notReadable.Count) { $metadata.AppOnlyExcludedTypes = $notReadable }
        if ($maskedItems.Count) { $metadata.MaskedSecretItems = @($maskedItems) }
        $metadata.Items = $sortedItems
        Set-TvBlob $storageAccount "$backupFolder/metadata.json" ($metadata | ConvertTo-Json -Depth 100) $storageToken
        Write-Output "Backup completed: $totalPolicies policies in $($metadata.Duration) ($status). Older backups were kept: the cloud identity cannot delete. The next desktop backup made with an admin's sign-in applies retention."
        Set-TvCloudStatus $context $status "Backup $status, $totalPolicies policies." $backupFolder
        Send-TvBackupOutcome -Account $storageAccount -Token $storageToken -TenantId $tenantId -RunId $runId -Status $status -BackupFolder $backupFolder -TotalPolicies $totalPolicies -Failures $failures -FailedTypes @($failedTypes)
        if ($status -eq "Failed") { throw "The backup saved no policies. See the runbook output above." }
        # Only a complete backup is compared, like the desktop app's report after a scheduled backup:
        # items a backup with warnings could not read would show up as deleted.
        # The report is optional: nothing it does may change the backup's result.
        if ($status -eq "Success") {
            try { Invoke-TvChangeReport -Context $context -BackupFolder $backupFolder -Metadata $metadata -Types $types -GraphToken $graphToken -RunId $runId }
            catch { Write-Output "No change report was made: $(Get-TvSafeError $_.Exception.Message)" }
        } else {
            try { if ((Get-TvChangeReportLevel) -ne "off") { Write-Output "No change report: the backup completed with warnings." } } catch { }
        }
    } catch {
        $reason = Get-TvSafeError $_.Exception.Message
        # Record the claimed folder as a failed backup, create-only, like the desktop engine.
        try {
            $ended = [DateTime]::UtcNow
            $seconds = [int][Math]::Round(($ended - $started).TotalSeconds)
            $itemCounts = [ordered]@{}
            foreach ($key in $counts.Keys) { $itemCounts[$key] = $counts[$key] }
            $totalPolicies = 0
            foreach ($count in $counts.Values) { $totalPolicies += $count }
            $itemCounts.TotalPolicies = $totalPolicies
            $sortedItems = [ordered]@{}
            foreach ($key in @($items.Keys | Sort-Object)) { $sortedItems[$key] = $items[$key] }
            $failed = [ordered]@{
                BackupDate = ConvertTo-TvFolderTimestamp $started; BackupFolder = $backupFolder
                StartTime = ConvertTo-TvDisplayTime $started; EndTime = ConvertTo-TvDisplayTime $ended
                Duration = if ($seconds -lt 60) { "${seconds}s" } else { "{0}m {1}s" -f [Math]::Floor($seconds / 60), ($seconds % 60) }
                DurationSeconds = $seconds; ItemCounts = $itemCounts; Status = "Failed"
                RunbookVersion = $script:RunbookVersion; BackupFormat = "Individual policy files with Intune-compatible JSON"
                Source = "TenuVault Cloud Backup"; TenantId = $tenantId.ToLowerInvariant(); Trigger = "scheduled"; RunId = $runId
                Scope = [ordered]@{ Excluded = $excluded; Included = @($types | ForEach-Object { $_.Folder }) }
                Failures = [Math]::Max(1, $failures); SkippedTypes = @($skippedTypes); FailedTypes = @($failedTypes)
                AuthMode = "app-only"; Items = $sortedItems; Error = $reason
            }
            if ($notReadable.Count) { $failed.AppOnlyExcludedTypes = $notReadable }
            if ($maskedItems.Count) { $failed.MaskedSecretItems = @($maskedItems) }
            Set-TvBlob $storageAccount "$backupFolder/metadata.json" ($failed | ConvertTo-Json -Depth 100) $storageToken -CreateOnly
        } catch { Write-Output "Could not record this backup as Failed: $(Get-TvSafeError $_.Exception.Message). It is listed as incomplete." }
        Set-TvCloudStatus $context "Failed" $reason $backupFolder
        Send-TvBackupOutcome -Account $storageAccount -Token $storageToken -TenantId $tenantId -RunId $runId -Status "Failed" -BackupFolder $backupFolder -TotalPolicies $totalPolicies -Failures ([Math]::Max(1, $failures)) -FailedTypes @($failedTypes)
        throw
    }
}

if (-not $LibraryOnly) {
    $ErrorActionPreference = "Stop"
    Invoke-TvBackup
}



