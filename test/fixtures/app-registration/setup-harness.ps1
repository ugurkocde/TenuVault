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
$arguments = Get-Content -Raw -Encoding UTF8 $ArgumentsFile | ConvertFrom-Json
$parameters = @{}
foreach ($property in $arguments.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
try { & $Script @parameters }
catch { Write-Output $_.Exception.Message; exit 1 }
finally {
    if ($script:browserJob) { Remove-Job $script:browserJob -Force }
}
