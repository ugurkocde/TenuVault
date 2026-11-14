param(
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'The expected publisher is required.' }
$app = Join-Path $AppDirectory 'TenuVault.exe'
$helper = Join-Path $AppDirectory 'resources/app-backup/TenuVault.Capture.exe'
$subjects = @()
foreach ($file in @($app, $helper)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing signed binary: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw "Invalid Authenticode signature for $file ($($signature.Status))."
    }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if (-not [string]::Equals($publisher, $ExpectedPublisher, [StringComparison]::Ordinal)) {
        throw "Unexpected Authenticode publisher for $file."
    }
    $subjects += $signature.SignerCertificate.Subject
    Write-Output "Signature verified: $([IO.Path]::GetFileName($file))"
}
if (-not [string]::Equals($subjects[0], $subjects[1], [StringComparison]::Ordinal)) {
    throw 'The app and capture helper have different Authenticode publishers.'
}
