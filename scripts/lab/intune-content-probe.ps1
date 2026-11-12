# Lab spike only. Does not install applications, alter assignments, or export the device private key.
param([switch]$Recover, [switch]$KeyAccessOnly, [Parameter(Mandatory=$true)][Guid]$ApplicationId, [string]$ApplicationName='Win32 app', [Parameter(Mandatory=$true)][string]$ApplicationVersion, [Parameter(Mandatory=$true)][Uri]$GatewayBase, [string]$OutputRoot=(Join-Path $env:USERPROFILE 'tv-test\content-recovery'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$watch = [Diagnostics.Stopwatch]::StartNew()
$ownsOutputDirectory = $false
$out = $null
$stage = "gateway"
Add-Type -AssemblyName System.Net.Http
$certs = @(Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and ($_.Extensions.Oid.Value -contains '1.2.840.113556.5.6') })
if ($certs.Count -ne 1) { throw "Expected one current MDM certificate, found $($certs.Count)" }
$cert = $certs[0]
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($KeyAccessOnly) {
    $result = [ordered]@{ Elevated=$elevated; HasPrivateKey=$cert.HasPrivateKey; CanUsePrivateKey=$false }
    $rsa = $null
    try {
        $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        $challenge = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($challenge) } finally { $random.Dispose() }
        $sig = $rsa.SignData($challenge,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $result.CanUsePrivateKey = $rsa.VerifyData($challenge,$sig,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    } catch {
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        $result.ErrorType = $e.GetType().FullName
        $result.HResult = $e.HResult
        $result.Message = $e.Message
    } finally { if ($rsa) { $rsa.Dispose() } }
    $result | ConvertTo-Json
    exit
}
$ext = @($cert.Extensions | Where-Object { $_.Oid.Value -eq '1.2.840.113556.5.6' })[0].RawData
if ($ext.Length -eq 18 -and $ext[0] -eq 4 -and $ext[1] -eq 16) { $ext = [byte[]]$ext[2..17] }
$accountId = (New-Object Guid (,$ext)).ToString()
$deviceId = $cert.Subject.Substring(3)
$imePath = 'C:\Program Files (x86)\Microsoft Intune Management Extension'
$version = (Get-Item "$imePath\Microsoft.Management.Services.IntuneWindowsAgent.AgentCommon.dll").VersionInfo.FileVersion
$session = [Guid]::NewGuid().ToString()
$client = @{ DeviceName=$env:COMPUTERNAME; OperatingSystemVersion=[Environment]::OSVersion.Version.ToString(); SideCarAgentVersion=$version; Win10SMode=$false; ExtendedInventoryMap=@{} }
$payload = @{ ApplicationId=$ApplicationId.ToString(); ApplicationVersion=$ApplicationVersion; ApplicationName=$ApplicationName; Intent=3; CertificateBlob=[Convert]::ToBase64String($cert.RawData); TargetingMethod=0; TargetType=2; InstallContext=2; EspPhase=0; AssignmentFilterIds=@(); ManagedInstallerStatus=1; ApplicationEnforcement=0; AppTypeSpecificPropertiesFormat=0 }
$body = @{ Key=$session; SessionId=$session; RequestContentType='GetContentInfo'; ClientInfo=($client | ConvertTo-Json -Compress); RequestPayload=($payload | ConvertTo-Json -Compress); CheckinReason='OnDemand'; CheckinReasonPayload=(@{ NotificationID=[Guid]::Empty.ToString(); NotificationIntent=''; SyncType='' } | ConvertTo-Json -Compress) } | ConvertTo-Json -Depth 8 -Compress
if ($GatewayBase.Scheme -ne 'https' -or $GatewayBase.Host -notmatch '^agents\.[a-z0-9-]+\.manage\.microsoft\.com$' -or $GatewayBase.Port -ne 443 -or $GatewayBase.UserInfo -or $GatewayBase.Query -or $GatewayBase.Fragment -or $GatewayBase.AbsolutePath -ne '/TrafficGateway/TrafficRoutingService/SideCar/StatelessSideCarGatewayService') { throw 'Unexpected lab gateway endpoint' }
$base = $GatewayBase.AbsoluteUri.TrimEnd('/')
$uri = "$base/SideCarGatewaySessions('$session')?api-version=1.6"
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$handler.ClientCertificates.Add($cert) | Out-Null
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(45)
foreach ($entry in @{AccountId=$accountId; DeviceId=$deviceId; Prefer='return-content'; 'Scenario-Type'='Windows-GetContentInfo'; 'client-request-id'=$session; 'Request-Attempt-Count'='0'}.GetEnumerator()) { $http.DefaultRequestHeaders.TryAddWithoutValidation($entry.Key, [string]$entry.Value) | Out-Null }
try {
    $content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
    $r = $http.PutAsync($uri, $content).GetAwaiter().GetResult()
    $raw = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $summary = [ordered]@{ AppId=$ApplicationId.ToString(); AppName=$ApplicationName; ApplicationVersion=$ApplicationVersion; Auth='MDM certificate only'; HttpStatus=[int]$r.StatusCode; ResponseBytes=$raw.Length; ImeVersion=$version; Elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    if (!$r.IsSuccessStatusCode) { throw "Content request failed with HTTP $([int]$r.StatusCode)" }
    if ($r.IsSuccessStatusCode) {
        $o = $raw | ConvertFrom-Json
        $summary.ResponseContentType = $o.ResponseContentType
        $summary.HasResponsePayload = !!$o.ResponsePayload
        if ($o.ResponsePayload) {
            $p = $o.ResponsePayload | ConvertFrom-Json
            $summary.ReturnedApplicationVersion = $p.ApplicationVersion
            $summary.PayloadFields = @($p.PSObject.Properties.Name)
            $summary.ErrorCode = $p.ErrorCode
            if ($null -ne $p.ErrorCode -and [string]$p.ErrorCode -ne '' -and [string]$p.ErrorCode -ne '0') { throw 'Content service returned a payload error.' }
            $summary.HasContentInfo = !!$p.ContentInfo
            $summary.HasDecryptInfo = !!$p.DecryptInfo
            if ($p.DecryptInfo) {
                Add-Type -AssemblyName System.Security
                $xml = New-Object System.Xml.XmlDocument
                $xml.XmlResolver = $null
                $xml.LoadXml($p.DecryptInfo)
                $node = $xml.SelectSingleNode("//*[local-name()='EncryptedContent']")
                $cms = New-Object System.Security.Cryptography.Pkcs.EnvelopedCms
                $cms.Decode([Convert]::FromBase64String($node.InnerText))
                $cms.Decrypt((New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection($cert)))
                $decText = [Text.Encoding]::UTF8.GetString($cms.ContentInfo.Content)
                try { $dec = $decText | ConvertFrom-Json; $summary.DecryptionFormat='JSON'; $summary.DecryptionFields=@($dec.PSObject.Properties.Name); $summary.ProfileIdentifier=$dec.ProfileIdentifier } catch {
                    $decXml = New-Object System.Xml.XmlDocument
                    $decXml.XmlResolver = $null
                    $decXml.LoadXml($decText)
                    $summary.DecryptionFormat='XML'
                    $summary.DecryptionFields=@($decXml.DocumentElement.ChildNodes.LocalName)
                    $summary.ProfileIdentifier=$decXml.SelectSingleNode("//*[local-name()='ProfileIdentifier']").InnerText
                }
                $summary.CmsUnwrapped=$true
            }
            if ($p.ContentInfo) {
                $ci = $p.ContentInfo | ConvertFrom-Json
                $summary.ContentInfoFields = @($ci.PSObject.Properties.Name)
                $summary.OriginalSize = $ci.OriginalSize
                if ($Recover) {
                    if (!$dec -or $dec.ProfileIdentifier -ne 'ProfileVersion1' -or $dec.UnencryptedFileDigestAlgorithm -ne 'SHA256') { throw 'Unsupported encryption profile in spike' }
                    if ([long]$ci.OriginalSize -gt 268435456) { throw 'Package exceeds 256 MiB spike limit' }
                    $out = Join-Path $OutputRoot ( $ApplicationId.ToString() + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
                    $stage = "staging"
                    New-Item -ItemType Directory -Path $out -ErrorAction Stop | Out-Null
                    $ownsOutputDirectory = $true
                    $summary.OutputDirectory = $out
                    $bin = Join-Path $out 'content.bin'
                    $zip = Join-Path $out 'sources.zip'
                    # The CDN receives no device certificate or authorization header.
                    $stage = "download"
                    $downloadUri = [uri]$ci.UploadLocation
                    if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -notmatch '(^|\.)manage\.microsoft\.com$') { throw 'Unexpected CDN endpoint' }
                    $cdnHandler = New-Object System.Net.Http.HttpClientHandler
                    $cdnHandler.AllowAutoRedirect = $false
                    $cdn = New-Object System.Net.Http.HttpClient($cdnHandler)
                    $cdn.Timeout = [TimeSpan]::FromMinutes(3)
                    $cancel = New-Object Threading.CancellationTokenSource
                    $cancel.CancelAfter([TimeSpan]::FromMinutes(3))
                    try {
                        $download = $cdn.GetAsync($downloadUri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
                        if (!$download.IsSuccessStatusCode) { throw "CDN returned HTTP $([int]$download.StatusCode)" }
                        if ($download.Content.Headers.ContentLength -gt 268435456) { throw 'CDN size exceeds spike limit' }
                        $stream = $download.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                        $dest = [IO.File]::Open($bin, [IO.FileMode]::CreateNew)
                        try {
                            $buffer = New-Object byte[] 1048576
                            [long]$total = 0
                            while (($count = $stream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token).GetAwaiter().GetResult()) -gt 0) {
                                $total += $count
                                if ($total -gt 268435456) { throw 'Downloaded bytes exceed spike limit' }
                                $dest.Write($buffer,0,$count)
                            }
                        } finally { $dest.Dispose(); $stream.Dispose(); $download.Dispose() }
                    } finally { $cancel.Dispose(); $cdn.Dispose(); $cdnHandler.Dispose() }
                    $stage = "verify"
                    $summary.DownloadedBytes = (Get-Item $bin).Length
                    $source = [IO.File]::OpenRead($bin)
                    $hmac = New-Object Security.Cryptography.HMACSHA256
                    try {
                        $headerMac = New-Object byte[] 32
                        $iv = New-Object byte[] 16
                        if ($source.Read($headerMac,0,32) -ne 32 -or $source.Read($iv,0,16) -ne 16) { throw 'Truncated content header' }
                        if ([Convert]::ToBase64String($iv) -cne $dec.IV) { throw 'IV mismatch' }
                        if ([Convert]::ToBase64String($headerMac) -cne $dec.Mac) { throw 'Header MAC mismatch' }
                        $hmac.Key = [Convert]::FromBase64String($dec.MacKey)
                        $source.Position = 32
                        $computedMac = $hmac.ComputeHash($source)
                        if ([Convert]::ToBase64String($computedMac) -cne $dec.Mac) { throw 'HMAC verification failed' }
                        $summary.HmacVerified = $true
                        $source.Position = 48
                        $aes = [Security.Cryptography.Aes]::Create()
                        $aes.Key = [Convert]::FromBase64String($dec.EncryptionKey)
                        $aes.IV = $iv
                        $aes.Mode = [Security.Cryptography.CipherMode]::CBC
                        $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
                        $transform = $aes.CreateDecryptor()
                        $crypto = New-Object Security.Cryptography.CryptoStream($source,$transform,[Security.Cryptography.CryptoStreamMode]::Read)
                        $decoded = [IO.File]::Open($zip,[IO.FileMode]::CreateNew)
                        try { $crypto.CopyTo($decoded,1048576) } finally { $decoded.Dispose(); $crypto.Dispose(); $transform.Dispose(); $aes.Dispose() }
                    } finally { $source.Dispose(); $hmac.Dispose() }
                    $digest = (Get-FileHash $zip -Algorithm SHA256).Hash
                    $expectedDigest = ([BitConverter]::ToString([Convert]::FromBase64String($dec.UnencryptedFileDigest))).Replace('-','')
                    if ($digest -cne $expectedDigest) { throw 'Plaintext SHA256 verification failed' }
                    $summary.PlaintextSha256Verified = $true
                    $summary.PlaintextSha256 = $digest
                    $summary.EncryptedSha256 = (Get-FileHash $bin -Algorithm SHA256).Hash
                    Add-Type -AssemblyName System.IO.Compression.FileSystem
                    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
                    $extract = Join-Path $out 'Extracted'
                    New-Item -ItemType Directory $extract | Out-Null
                    $extractRoot = [IO.Path]::GetFullPath($extract) + [IO.Path]::DirectorySeparatorChar
                    try {
                        if ($archive.Entries.Count -gt 10000) { throw 'Too many archive entries' }
                        [long]$expanded = 0
                        foreach ($entry in $archive.Entries) {
                            $expanded += $entry.Length
                            if ($expanded -gt 1073741824) { throw 'Expanded content exceeds 1 GiB spike limit' }
                            $target = [IO.Path]::GetFullPath((Join-Path $extract $entry.FullName))
                            if (!$target.StartsWith($extractRoot,[StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(':') -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive entry' }
                        }
                    } finally { $archive.Dispose() }
                    [IO.Compression.ZipFile]::ExtractToDirectory($zip,$extract)
                    $summary.ExtractedFiles = @(Get-ChildItem $extract -Recurse -File | ForEach-Object { @{ RelativePath=$_.FullName.Substring($extractRoot.Length); Bytes=$_.Length; Sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash } })
                    if ($summary.ExtractedFiles.Count -lt 1) { throw 'Recovered archive contains no files.' }
                    $summary.ElapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds,2)
                    $summary | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'evidence.json') -Encoding UTF8
                }
            }
        }
    }
    if ($Recover -and (!$ownsOutputDirectory -or !$summary.HmacVerified -or !$summary.PlaintextSha256Verified -or !$summary.Contains('ExtractedFiles') -or $summary.ExtractedFiles.Count -lt 1 -or !(Test-Path -LiteralPath (Join-Path $out 'evidence.json')))) { throw 'Content service did not return a complete verified recovery.' }
    if ($summary.Contains('ExtractedFiles')) {
        $summary.ExtractedFileCount = $summary.ExtractedFiles.Count
        $summary.Remove('ExtractedFiles')
    }
    $summary | ConvertTo-Json -Depth 5
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $failure = [ordered]@{ Elevated=$elevated; ErrorType=$e.GetType().FullName; Message=($e.Message -replace 'https?://[^\s]+','[redacted URL]'); CleanupSucceeded=$true; OwnedOutput=$ownsOutputDirectory; Stage=$stage }
    if ($summary -and $summary.Contains('HttpStatus')) { $failure.HttpStatus = $summary.HttpStatus }
    # Delete only a directory this invocation successfully created. A collision is not ownership.
    if ($ownsOutputDirectory) {
        try { Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction Stop }
        catch { $failure.CleanupSucceeded=$false; $failure.CleanupError='Could not remove failed recovery output.' }
    }
    $failure | ConvertTo-Json
    exit 1
} finally { $http.Dispose(); $handler.Dispose() }
