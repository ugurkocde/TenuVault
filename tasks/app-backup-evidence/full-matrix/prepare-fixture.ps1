param([Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=$OutputRoot
if(Test-Path $root){throw 'Fixture directory already exists'}
New-Item -ItemType Directory $root | Out-Null
$src=New-Item -ItemType Directory (Join-Path $root 'original')
@'
$ErrorActionPreference='Stop'
$destination=Join-Path $env:ProgramData 'TenuVaultLab\R0-20261112'
New-Item -ItemType Directory -Force $destination | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'payload.txt') $destination -Force
Copy-Item (Join-Path $PSScriptRoot 'version.txt') $destination -Force
$key='HKLM:\SOFTWARE\TenuVaultLab\R0-20261112'
New-Item -Force $key | Out-Null
New-ItemProperty -Path $key -Name Version -Value ((Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()) -PropertyType String -Force | Out-Null
exit 0
'@ | Set-Content (Join-Path $src 'install.ps1') -Encoding UTF8
@'
$ErrorActionPreference='Stop'
$destination=Join-Path $env:ProgramData 'TenuVaultLab\R0-20261112'
if(Test-Path $destination){Remove-Item $destination -Recurse -Force}
$key='HKLM:\SOFTWARE\TenuVaultLab\R0-20261112'
if(Test-Path $key){Remove-Item $key -Recurse -Force}
exit 0
'@ | Set-Content (Join-Path $src 'uninstall.ps1') -Encoding UTF8
'TenuVault independently authored recovery fixture. No vendor installer.' | Set-Content (Join-Path $src 'payload.txt') -Encoding UTF8
'1' | Set-Content (Join-Path $src 'version.txt') -Encoding ASCII
New-Item -ItemType Directory (Join-Path $src 'nested') | Out-Null
'Unicode filename test: Grüße' | Set-Content (Join-Path $src 'nested\Grüße.txt') -Encoding UTF8
$rng=[Security.Cryptography.RandomNumberGenerator]::Create();$bytes=New-Object byte[] 65536;$rng.GetBytes($bytes);$rng.Dispose();[IO.File]::WriteAllBytes((Join-Path $src 'nested\random.bin'),$bytes)
$manifest=@(Get-ChildItem $src -File -Recurse | ForEach-Object {@{Path=$_.FullName.Substring($src.FullName.Length+1);Size=$_.Length;Sha256=(Get-FileHash $_.FullName).Hash}})
$manifest | ConvertTo-Json | Set-Content (Join-Path $root 'original-manifest.json') -Encoding UTF8
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/microsoft/Microsoft-Win32-Content-Prep-Tool/master/IntuneWinAppUtil.exe' -OutFile (Join-Path $root 'IntuneWinAppUtil.exe')
$out=New-Item -ItemType Directory (Join-Path $root 'package-v1')
& (Join-Path $root 'IntuneWinAppUtil.exe') -c $src.FullName -s (Join-Path $src 'install.ps1') -o $out.FullName -q *> (Join-Path $root 'pack-v1.log')
if($LASTEXITCODE -ne 0){throw "Packaging failed: $LASTEXITCODE"}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $out 'install.intunewin'),(Join-Path $out 'unpacked'))
[xml]$xml=Get-Content (Join-Path $out 'unpacked\IntuneWinPackage\Metadata\Detection.xml') -Raw
$info=$xml.ApplicationInfo.EncryptionInfo
@{fileEncryptionInfo=@{encryptionKey=[string]$info.EncryptionKey;macKey=[string]$info.MacKey;initializationVector=[string]$info.InitializationVector;mac=[string]$info.Mac;profileIdentifier=[string]$info.ProfileIdentifier;fileDigest=[string]$info.FileDigest;fileDigestAlgorithm=[string]$info.FileDigestAlgorithm}} | ConvertTo-Json | Set-Content (Join-Path $out 'commit.json') -Encoding UTF8
$bin=Get-ChildItem (Join-Path $out 'unpacked\IntuneWinPackage\Contents') -File | Select -First 1
@{Name=[string]$xml.ApplicationInfo.FileName;Size=[long]$xml.ApplicationInfo.UnencryptedContentSize;SizeEncrypted=$bin.Length;BinPath=$bin.FullName;PrepToolSha256=(Get-FileHash (Join-Path $root 'IntuneWinAppUtil.exe')).Hash;OriginalFiles=$manifest.Count;PrepToolSignature=(Get-AuthenticodeSignature (Join-Path $root 'IntuneWinAppUtil.exe')).Status.ToString()} | ConvertTo-Json | Set-Content (Join-Path $out 'metadata.json') -Encoding UTF8
Get-Content (Join-Path $out 'metadata.json') -Raw
