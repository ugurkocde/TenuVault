$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
. (Join-Path $repo "resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly

function New-TvResponse { param([string[]]$Codes)
    $response = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]::NotFound)
    foreach ($code in $Codes) { $null = $response.Headers.TryAddWithoutValidation("x-ms-error-code", $code) }
    return , $response
}
Write-Output (@{
    single = Get-TvErrorCodeHeader (New-TvResponse @("BlobNotFound"))
    container = Get-TvErrorCodeHeader (New-TvResponse @("ContainerNotFound"))
    repeated = Get-TvErrorCodeHeader (New-TvResponse @("BlobNotFound", "AuthorizationFailure"))
    absent = Get-TvErrorCodeHeader (New-TvResponse @())
} | ConvertTo-Json -Compress)
