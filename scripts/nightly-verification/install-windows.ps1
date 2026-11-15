# Installs a published Windows nightly as users get it and verifies its signatures.
#
#   ./install-windows.ps1 -Downloads <folder with the release's x64 EXE and MSI> -ExpectedPublisher <name>
#
# Every installer in the folder must carry a valid Authenticode signature of the expected
# publisher, all with the same certificate subject, before anything runs: the x64 EXE and MSI,
# and the arm64 and combined EXE when they are there (those are checked, not installed). The MSI
# is installed silently for all users, its app and capture helper signatures are checked, and it
# is removed again. Then the x64 NSIS installer runs silently for the current user, the same
# checks run on that installation, and the installed app's subject must match the installers'.
# Its TenuVault.exe path is written to GITHUB_OUTPUT as `app` (or printed without GitHub Actions).
param(
    [Parameter(Mandatory = $true)][string]$Downloads,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher
)
$ErrorActionPreference = 'Stop'
$checkSignatures = Join-Path $PSScriptRoot '..\check-capture-signatures.ps1'

# Returns the signer certificate subject.
function Assert-Signed([string]$File) {
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw "Invalid Authenticode signature for $([IO.Path]::GetFileName($File)) ($($signature.Status))."
    }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if (-not [string]::Equals($publisher, $ExpectedPublisher, [StringComparison]::Ordinal)) {
        throw "Unexpected Authenticode publisher for $([IO.Path]::GetFileName($File))."
    }
    Write-Host "Signature verified: $([IO.Path]::GetFileName($File))"
    return $signature.SignerCertificate.Subject
}

$subject = $null
function Assert-Publisher([string]$File) {
    $found = Assert-Signed $File
    if ($null -eq $script:subject) { $script:subject = $found }
    elseif (-not [string]::Equals($found, $script:subject, [StringComparison]::Ordinal)) {
        throw "$([IO.Path]::GetFileName($File)) is signed with another certificate subject than the other installers."
    }
}

# The install folder an installer registered for TenuVault, from the uninstall entries.
function Find-Install([string[]]$Roots, [string]$Fallback) {
    foreach ($root in $Roots) {
        foreach ($entry in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            $properties = Get-ItemProperty $entry.PSPath
            if ($properties.DisplayName -like 'TenuVault*' -and $properties.InstallLocation -and (Test-Path (Join-Path $properties.InstallLocation 'TenuVault.exe'))) {
                return $properties.InstallLocation.TrimEnd('\')
            }
        }
    }
    if (Test-Path (Join-Path $Fallback 'TenuVault.exe')) { return $Fallback }
    throw "TenuVault.exe was not found after the installation (looked in the uninstall entries and $Fallback)."
}

$exe = @(Get-ChildItem $Downloads -Filter '*-win-x64.exe')
$msi = @(Get-ChildItem $Downloads -Filter '*-win-x64.msi')
if ($exe.Count -ne 1 -or $msi.Count -ne 1) { throw "Expected one x64 EXE and one x64 MSI in $Downloads." }
Assert-Publisher $exe[0].FullName
Assert-Publisher $msi[0].FullName
# The other published installers: signature checks only.
foreach ($other in @(Get-ChildItem $Downloads -Filter '*.exe' | Where-Object { $_.Name -like '*-win-arm64.exe' -or $_.Name -like '*-win.exe' })) {
    Assert-Publisher $other.FullName
}

# MSI: per machine, as Intune or Configuration Manager deploy it.
$log = Join-Path $env:RUNNER_TEMP 'tenuvault-msi.log'
$process = Start-Process msiexec.exe -ArgumentList @('/i', "`"$($msi[0].FullName)`"", '/qn', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
if ($process.ExitCode -ne 0) { Get-Content $log -Tail 40; throw "The MSI did not install (exit code $($process.ExitCode))." }
$msiDir = Find-Install @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') (Join-Path $env:ProgramFiles 'TenuVault')
Write-Output "MSI installed to $msiDir"
& $checkSignatures -AppDirectory $msiDir -ExpectedPublisher $ExpectedPublisher
$process = Start-Process msiexec.exe -ArgumentList @('/x', "`"$($msi[0].FullName)`"", '/qn', '/norestart') -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "The MSI did not uninstall (exit code $($process.ExitCode))." }
Write-Output 'MSI removed again'

# NSIS: the download from the website and the release page, for the current user.
$process = Start-Process $exe[0].FullName -ArgumentList @('/S', '/currentuser') -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "The installer did not install (exit code $($process.ExitCode))." }
$appDir = Find-Install @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall') (Join-Path $env:LOCALAPPDATA 'Programs\TenuVault')
Write-Output "Installed to $appDir"
& $checkSignatures -AppDirectory $appDir -ExpectedPublisher $ExpectedPublisher
$installed = (Get-AuthenticodeSignature -LiteralPath (Join-Path $appDir 'TenuVault.exe')).SignerCertificate.Subject
if (-not [string]::Equals($installed, $subject, [StringComparison]::Ordinal)) { throw 'The installed app is signed with another certificate subject than its installer.' }
# Nothing the installer started may hold the single instance lock.
Get-Process TenuVault -ErrorAction SilentlyContinue | Stop-Process -Force

$app = Join-Path $appDir 'TenuVault.exe'
if ($env:GITHUB_OUTPUT) { "app=$app" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 } else { Write-Output $app }
