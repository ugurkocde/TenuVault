param([string]$Server, [string]$Script, [string]$ClipboardFile, [string]$ArgumentsFile)
$ErrorActionPreference = 'Stop'
function global:Invoke-RestMethod {
    param($Uri, $Method, $Body, $Headers, $ContentType)
    $address = [uri]$Uri
    if ($address.Host -notin @('login.microsoftonline.com', 'graph.microsoft.com')) { throw 'Unexpected remote host in test.' }
    $parameters = @{ Uri = "$Server/$($address.Host)$($address.PathAndQuery)"; Method = $Method }
    if ($null -ne $Body) { $parameters.Body = $Body }
    if ($Headers) { $parameters.Headers = $Headers }
    if ($ContentType) { $parameters.ContentType = $ContentType }
    Microsoft.PowerShell.Utility\Invoke-RestMethod @parameters
}
function global:Start-Process {
    param([string]$FilePath)
    if ($FilePath -like 'tenuvault:*') {
        if ($env:TENUVAULT_TEST_OPEN_FAIL -eq '1') { throw 'Test launch failure.' }
        Write-Host "Opened test link: $FilePath"
        return
    }
    $address = [uri]$FilePath
    $browserUrl = "$Server/$($address.Host)$($address.PathAndQuery)"
    # A separate job follows the redirect while the script services its loopback listener.
    $script:browserJob = Start-Job -ArgumentList $browserUrl -ScriptBlock {
        param($Url)
        $client = New-Object Net.WebClient
        try { $client.DownloadString($Url) | Out-Null } finally { $client.Dispose() }
    }
}
function global:Set-Clipboard {
    param([string]$Value)
    [IO.File]::WriteAllText($ClipboardFile, $Value)
}
function global:Test-Path {
    param([string]$Path)
    if ($Path -eq 'HKCU:\Software\Classes\tenuvault') { return $env:TENUVAULT_TEST_INSTALLED -eq '1' }
    Microsoft.PowerShell.Management\Test-Path $Path
}
# Native commands are shadowed so installed detection and opening are deterministic on every runner.
function global:/usr/bin/osascript {
    if ($env:TENUVAULT_TEST_INSTALLED -eq '1') { Write-Output '/Applications/TenuVault.app' }
    $global:LASTEXITCODE = 0
}
function global:/usr/bin/open {
    param([string]$Link)
    if ($env:TENUVAULT_TEST_OPEN_FAIL -eq '1') { $global:LASTEXITCODE = 1; return }
    Write-Host "Opened test link: $Link"
    $global:LASTEXITCODE = 0
}
$arguments = Get-Content -Raw -Encoding UTF8 $ArgumentsFile | ConvertFrom-Json
$parameters = @{}
foreach ($property in $arguments.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
try { & $Script @parameters }
catch { Write-Output $_.Exception.Message; exit 1 }
finally {
    if ($script:browserJob) { Remove-Job $script:browserJob -Force }
}
