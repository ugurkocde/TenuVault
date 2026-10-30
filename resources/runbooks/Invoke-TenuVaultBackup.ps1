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

    Every blob is sealed before upload with the same TVAZ1 envelope the desktop app uses
    (AES-256-GCM, key derived with HKDF-SHA256 from the current backup recovery key, the tenant,
    host and blob path as additional data). The recovery key is read from Azure Key Vault at the
    start of the run and never logged. Without it the run stops: plaintext backups are never
    uploaded.

    The type table below mirrors src/shared/intune/registry.ts in the desktop app (paths, expands,
    selects, extras, the singleton and the built-in skips). test/cloud-backup-runbook.test.ts
    fails when the two drift apart. Encrypted OMA-URI values are handled like the desktop Backup
    Reader: Microsoft returns plain text only with a write permission, so a refused read keeps the
    masked value (****), records MaskedSecretItems, and the profile is not restorable from this
    backup until a backup with an admin's sign-in captures it.

    The runbook deletes nothing. Retention is applied by the next desktop backup made with an
    admin's sign-in, or by an Azure lifecycle rule on the container. A per tenant
    cloud-backup-status-<tenant>.json blob in the container records the last run so the desktop
    app can show cloud status without opening the Automation account.

    Configuration comes from Automation variables (environment variables of the same name are
    accepted outside Azure Automation so the flow can be exercised locally):
      TenuVaultTenantId          Entra tenant id (GUID) to back up. Required.
      TenuVaultStorageAccount    Storage account holding the intune-backups container. Required.
      TenuVaultKeyVault          Key Vault holding the recovery key secret. Required.
      TenuVaultScope             "everything" (default when unset) or "policies" (leave out Apps).
      TenuVaultExcludedFolders   Comma separated type folders to leave out; wins over the scope.
      TenuVaultAppOnlyExcluded   Comma separated folders the managed identity has no permission
                                 for by design (setup sets DeviceCategories,DeviceCleanupRules
                                 unless the device inventory permission was granted).

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

$script:RunbookVersion = "1.0.0"
$script:GraphBeta = "https://graph.microsoft.com/beta"
$script:Container = "intune-backups"
# One status blob per tenant, so status blobs never collide when tenants share tooling.
$script:StatusBlobPrefix = "cloud-backup-status-"
$script:OriginalFolders = @("DeviceConfigurations", "CompliancePolicies", "ConfigurationPolicies", "GroupPolicyConfigurations")

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
# TVAZ1 sealing (mirror src/main/storage/azure-seal.ts)
# ---------------------------------------------------------------------------

function Get-TvRecoveryMasterKey {
    param([Parameter(Mandatory)][string]$RecoveryKey)
    $trimmed = $RecoveryKey.Trim()
    $encoded = $null
    if ($trimmed.StartsWith("TVK2.")) { $encoded = ($trimmed.Substring(5) -split "\.")[0] }
    elseif ($trimmed.StartsWith("TVK1.")) { $encoded = $trimmed.Substring(5) }
    if (-not $encoded -or $encoded -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw "The Key Vault secret is not a TenuVault recovery key. Save the TVK2 bundle (or a legacy TVK1 key) from TenuVault Settings, Storage and recovery, Save recovery key."
    }
    $base64 = $encoded.Replace("-", "+").Replace("_", "/") + "="
    $key = [Convert]::FromBase64String($base64)
    if ($key.Length -ne 32) { throw "The Key Vault secret is not a TenuVault recovery key." }
    return $key
}

function Get-TvAzureKey {
    param([Parameter(Mandatory)][byte[]]$Master)
    return [Security.Cryptography.HKDF]::DeriveKey(
        [Security.Cryptography.HashAlgorithmName]::SHA256, $Master, 32,
        [byte[]]::new(0), [Text.Encoding]::UTF8.GetBytes("tenuvault-azure-backup-v1"))
}

# Seals one blob body. $Pathname is the URL pathname of the blob, still percent encoded.
function Protect-TvAzureBlob {
    param(
        [Parameter(Mandatory)][byte[]]$Plain,
        [Parameter(Mandatory)][byte[]]$Master,
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][string]$Pathname
    )
    $decodedPath = [uri]::UnescapeDataString($Pathname)
    $aadJson = ConvertTo-TvCanonicalJson @($TenantId.ToLowerInvariant(), $HostName, $decodedPath)
    # Canonical JSON of an array is the same compact form JSON.stringify produces for the AAD.
    $aad = [Text.Encoding]::UTF8.GetBytes($aadJson)
    $key = Get-TvAzureKey $Master
    $nonce = [byte[]]::new(12)
    [Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
    $cipher = [byte[]]::new($Plain.Length)
    $tag = [byte[]]::new(16)
    # Single argument on purpose: the Automation PowerShell 7.2 runtime (.NET 6) has no
    # tag size constructor. Its only tag size is the same 16 bytes the envelope uses.
    $aes = [Security.Cryptography.AesGcm]::new($key)
    try { $aes.Encrypt($nonce, $Plain, $cipher, $tag, $aad) } finally { $aes.Dispose() }
    $magic = [Text.Encoding]::ASCII.GetBytes("TVAZ1`n")
    $sealed = [byte[]]::new($magic.Length + $nonce.Length + $tag.Length + $cipher.Length)
    [Buffer]::BlockCopy($magic, 0, $sealed, 0, $magic.Length)
    [Buffer]::BlockCopy($nonce, 0, $sealed, $magic.Length, $nonce.Length)
    [Buffer]::BlockCopy($tag, 0, $sealed, $magic.Length + $nonce.Length, $tag.Length)
    [Buffer]::BlockCopy($cipher, 0, $sealed, $magic.Length + $nonce.Length + $tag.Length, $cipher.Length)
    return $sealed
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

function Invoke-TvHttp {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [string]$Method = "Get",
        [hashtable]$Headers,
        [byte[]]$BodyBytes,
        [string]$ContentType
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
        try { $response = $script:HttpClient.SendAsync($request).GetAwaiter().GetResult() }
        catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Seconds $attempt; continue }
            throw [TvHttpError]::new(0, (Get-TvSafeError $_.Exception.Message))
        }
        $status = [int]$response.StatusCode
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ($status -ge 200 -and $status -lt 300) {
            return @{ Status = $status; Bytes = $bytes; Text = [Text.Encoding]::UTF8.GetString($bytes) }
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
            $retryAfter = $null
            if ($response.Headers.RetryAfter -and $response.Headers.RetryAfter.Delta) { $delay = [Math]::Ceiling($response.Headers.RetryAfter.Delta.TotalSeconds) }
            if ($delay -gt 300) { throw $lastError }
            Start-Sleep -Seconds ([Math]::Max(1, $delay))
            continue
        }
        throw $lastError
    }
    throw $lastError
}

# ---------------------------------------------------------------------------
# Storage writes, always sealed
# ---------------------------------------------------------------------------

function Get-TvBlobTarget {
    param([Parameter(Mandatory)][string]$Account, [Parameter(Mandatory)][string]$BlobName)
    $hostName = "$Account.blob.core.windows.net"
    $encoded = ($BlobName -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
    $pathname = "/$script:Container/$encoded"
    return @{ HostName = $hostName; Pathname = $pathname; Uri = "https://$hostName$pathname" }
}

function Set-TvSealedBlob {
    param(
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$BlobName,
        [Parameter(Mandatory)][string]$Body,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][byte[]]$Master,
        [Parameter(Mandatory)][string]$TenantId,
        [switch]$CreateOnly
    )
    $target = Get-TvBlobTarget $Account $BlobName
    $sealed = Protect-TvAzureBlob ([Text.Encoding]::UTF8.GetBytes($Body)) $Master $TenantId $target.HostName $target.Pathname
    $headers = @{
        "x-ms-blob-type" = "BlockBlob"
        "x-ms-version"   = "2021-12-02"
        "x-ms-date"      = [DateTime]::UtcNow.ToString("R", [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($CreateOnly) { $headers["If-None-Match"] = "*" }
    [void](Invoke-TvHttp -Uri $target.Uri -Token $Token -Method "Put" -Headers $headers -BodyBytes $sealed -ContentType "application/octet-stream")
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
                # App-only read roles cannot decrypt: keep the masked value, like the Backup Reader.
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
    )
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
    try { Set-TvSealedBlob $Context.StorageAccount "$script:StatusBlobPrefix$($Context.TenantId.Substring(0, 8).ToLowerInvariant()).json" $body $Context.StorageToken $Context.Master $Context.TenantId }
    catch { Write-Output "Could not record the cloud backup status: $(Get-TvSafeError $_.Exception.Message)" }
}

function Invoke-TvBackup {
    $started = [DateTime]::UtcNow
    $runId = [guid]::NewGuid().ToString()
    $tenantId = Get-TvRequiredVariable "TenuVaultTenantId"
    if ($tenantId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw "TenuVaultTenantId is not a tenant id (GUID)." }
    $storageAccount = Get-TvRequiredVariable "TenuVaultStorageAccount"
    if ($storageAccount -notmatch '^[a-z0-9]{3,24}$') { throw "TenuVaultStorageAccount is not a storage account name." }
    $keyVault = Get-TvRequiredVariable "TenuVaultKeyVault"

    $scope = Get-TvAutomationVariable "TenuVaultScope"
    $excluded = Get-TvFolderList (Get-TvAutomationVariable "TenuVaultExcludedFolders")
    if (-not $excluded.Count -and $scope -eq "policies") { $excluded = @("Apps") }
    $appOnlyExcluded = Get-TvFolderList (Get-TvAutomationVariable "TenuVaultAppOnlyExcluded")

    Write-Output "Backing up tenant $tenantId to storage account $storageAccount (runbook $script:RunbookVersion, run $runId)."
    $graphToken = Get-TvManagedIdentityToken "https://graph.microsoft.com/"
    $storageToken = Get-TvManagedIdentityToken "https://storage.azure.com/"
    $vaultToken = Get-TvManagedIdentityToken "https://vault.azure.net"
    $secret = Invoke-TvHttp -Uri "https://$keyVault.vault.azure.net/secrets/tenuvault-recovery-key/?api-version=7.4" -Token $vaultToken -Method "Get"
    $master = Get-TvRecoveryMasterKey ([string](Get-TvProp ($secret.Text | ConvertFrom-Json) "value"))
    $context = @{ TenantId = $tenantId; StorageAccount = $storageAccount; StorageToken = $storageToken; Master = $master }

    $allTypes = Get-TvTypes
    $known = @($allTypes | ForEach-Object { $_.Folder })
    $excluded = @($known | Where-Object { $excluded -contains $_ })
    $notReadable = @($known | Where-Object { $appOnlyExcluded -contains $_ -and $excluded -notcontains $_ })
    $types = @($allTypes | Where-Object { $excluded -notcontains $_.Folder -and $appOnlyExcluded -notcontains $_.Folder })
    if (-not $types.Count) { throw "The configured scope leaves nothing to back up." }
    if ($excluded.Count) { Write-Output "Leaving out $($excluded.Count) of $($known.Count) types: $($excluded -join ', ')." }
    if ($notReadable.Count) { Write-Output "Leaving out $($notReadable.Count) type(s) the cloud identity has no permission for: $($notReadable -join ', '). Desktop backups include them." }

    # List everything first, like the desktop engine, so a denied list is reported per type.
    # A run that stops anywhere before the write phase still records why, now that the key and
    # tokens exist; failures before the key was read cannot be recorded anywhere sealed.
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
        Set-TvSealedBlob $storageAccount "$backupFolder/.tenuvault-owner.json" $owner $storageToken $master $tenantId -CreateOnly
    } catch [TvHttpError] {
        if ($_.Exception.Status -in @(409, 412)) {
            throw "Backup folder $backupFolder is already in use by another backup for this tenant and storage. Nothing from this backup was written. Wait for the other backup to finish, then try again."
        }
        throw
    }
    } catch {
        Set-TvCloudStatus $context "Failed" (Get-TvSafeError $_.Exception.Message) $null
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
                    Set-TvSealedBlob $storageAccount "$backupFolder/$($type.Folder)/$fileName.json" $body $storageToken $master $tenantId
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
        Set-TvSealedBlob $storageAccount "$backupFolder/metadata.json" ($metadata | ConvertTo-Json -Depth 100) $storageToken $master $tenantId
        Write-Output "Backup completed: $totalPolicies policies in $($metadata.Duration) ($status). Older backups were kept: the cloud identity cannot delete. The next desktop backup made with an admin's sign-in applies retention."
        Set-TvCloudStatus $context $status "Backup $status, $totalPolicies policies." $backupFolder
        if ($status -eq "Failed") { throw "The backup saved no policies. See the runbook output above." }
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
            Set-TvSealedBlob $storageAccount "$backupFolder/metadata.json" ($failed | ConvertTo-Json -Depth 100) $storageToken $master $tenantId -CreateOnly
        } catch { Write-Output "Could not record this backup as Failed: $(Get-TvSafeError $_.Exception.Message). It is listed as incomplete." }
        Set-TvCloudStatus $context "Failed" $reason $backupFolder
        throw
    }
}

if (-not $LibraryOnly) {
    $ErrorActionPreference = "Stop"
    Invoke-TvBackup
}



