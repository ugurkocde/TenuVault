# Lab-only regression checks. Requests existing assigned content; never changes tenant state.
param([string]$ProbePath=(Join-Path $PSScriptRoot '..\intune-content-probe.ps1'), [string]$EvidencePath, [Parameter(Mandatory=$true)][Guid]$RecoveryAppId, [Parameter(Mandatory=$true)][string]$RecoveryVersion, [Parameter(Mandatory=$true)][Guid]$DeniedAppId, [Parameter(Mandatory=$true)][Uri]$GatewayBase)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=Join-Path $env:TEMP ('tenuvault-recovery-regression-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$source=Get-Content -LiteralPath $ProbePath -Raw
$results=@()
try {
 foreach($case in @('digest','midstream','http404','http403','collision','cleanup-failure','missing-payload','missing-content','missing-decrypt','payload-error','empty-archive','success')){
  $script=$source
  $app=$RecoveryAppId.ToString();$version=$RecoveryVersion
  if($case -eq 'cleanup-failure'){$script=$script.Replace('$summary.DownloadedBytes =', '$hold=[IO.File]::Open($zip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); throw ''Injected locked file failure.''; $summary.DownloadedBytes =')}
  if($case -eq 'digest'){$script=$script.Replace('$summary.DownloadedBytes =', '$dec.UnencryptedFileDigest=[Convert]::ToBase64String((New-Object byte[] 32)); $summary.DownloadedBytes =')}
  if($case -eq 'midstream'){$script=$script.Replace('$total += $count', '$total += $count; if($total -ge 1048576){$cancel.Cancel()}')}
  if($case -eq 'http404'){$version='999999'}
  if($case -eq 'http403'){$app=$DeniedAppId.ToString();$version='1'}
  if($case -eq 'missing-payload'){$script=$script.Replace('$o = $raw | ConvertFrom-Json', '$o = $raw | ConvertFrom-Json; $o.ResponsePayload=$null')}
  if($case -eq 'missing-content'){$script=$script.Replace('$p = $o.ResponsePayload | ConvertFrom-Json', '$p = $o.ResponsePayload | ConvertFrom-Json; $p.ContentInfo=$null')}
  if($case -eq 'missing-decrypt'){$script=$script.Replace('$p = $o.ResponsePayload | ConvertFrom-Json', '$p = $o.ResponsePayload | ConvertFrom-Json; $p.DecryptInfo=$null')}
  if($case -eq 'payload-error'){$script=$script.Replace('$p = $o.ResponsePayload | ConvertFrom-Json', '$p = $o.ResponsePayload | ConvertFrom-Json; $p.ErrorCode=123')}
  if($case -eq 'empty-archive'){$script=$script.Replace('$archive = [IO.Compression.ZipFile]::OpenRead($zip)', '[IO.File]::WriteAllBytes($zip,[byte[]]@(80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)); $archive = [IO.Compression.ZipFile]::OpenRead($zip)')}
  $output=Join-Path $root $case
  New-Item -ItemType Directory $output | Out-Null
  if($case -eq 'collision'){
   $line=@($script -split "`n" | Where-Object {$_ -match '^\s*\$out = Join-Path \$OutputRoot '})[0]
   $script=$script.Replace($line, "                    `$out = Join-Path `$OutputRoot 'existing'")
   New-Item -ItemType Directory (Join-Path $output 'existing') | Out-Null
   'keep existing data' | Set-Content (Join-Path $output 'existing\sentinel.txt')
  }
  $path=Join-Path $root ($case+'.ps1');$script | Set-Content -LiteralPath $path -Encoding UTF8
  $raw=& powershell.exe -NoProfile -NonInteractive -File $path -Recover -ApplicationId $app -ApplicationVersion $version -OutputRoot $output -GatewayBase $GatewayBase.AbsoluteUri
  $code=$LASTEXITCODE
  $detail=($raw -join "`n") | ConvertFrom-Json
  $dirs=@(Get-ChildItem -LiteralPath $output -Directory)
  $pass=($code -ne 0 -and $detail.CleanupSucceeded -and $dirs.Count -eq 0)
  if($case -eq 'digest'){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.OwnedOutput -and $detail.Message -eq 'Plaintext SHA256 verification failed'}
  if($case -eq 'midstream'){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.OwnedOutput -and $detail.ErrorType -eq 'System.Threading.Tasks.TaskCanceledException'}
  if($case -eq 'cleanup-failure'){$pass=($detail.HttpStatus -eq 200 -and $code -ne 0 -and $detail.OwnedOutput -and !$detail.CleanupSucceeded -and $detail.Message -eq 'Injected locked file failure.')}
  if($case -eq 'http404'){$pass=$pass -and $detail.HttpStatus -eq 404}
  if($case -eq 'http403'){$pass=$pass -and $detail.HttpStatus -eq 403}
  if($case -eq 'collision'){$pass=($detail.HttpStatus -eq 200 -and $detail.Stage -eq 'staging' -and !$detail.OwnedOutput -and $code -ne 0 -and (Get-Content (Join-Path $output 'existing\sentinel.txt') -Raw).Trim() -eq 'keep existing data')}
  if($case -in @('missing-payload','missing-content')){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.Message -eq 'Content service did not return a complete verified recovery.'}
  if($case -eq 'missing-decrypt'){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.Message -eq 'Unsupported encryption profile in spike'}
  if($case -eq 'payload-error'){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.Message -eq 'Content service returned a payload error.'}
  if($case -eq 'empty-archive'){$pass=$pass -and $detail.HttpStatus -eq 200 -and $detail.OwnedOutput -and $detail.Stage -eq 'verify' -and $detail.Message -eq 'Recovered archive contains no files.'}
  if($case -eq 'success'){$pass=($code -eq 0 -and $detail.HttpStatus -eq 200 -and $detail.HmacVerified -and $detail.PlaintextSha256Verified -and $detail.ExtractedFileCount -gt 0 -and $dirs.Count -eq 1 -and (Test-Path (Join-Path $dirs[0].FullName 'evidence.json')))}
  $result=@{Case=$case;Pass=[bool]$pass;ExitCode=$code;HttpStatus=$detail.HttpStatus;CleanupSucceeded=$detail.CleanupSucceeded;OwnedOutput=$detail.OwnedOutput;Stage=$detail.Stage}
  $results+=$result
  $result | ConvertTo-Json -Compress
 }
 if($EvidencePath){$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8}
 if(@($results | Where-Object {!$_.Pass}).Count){throw 'Recovery failure regression checks failed.'}
} finally {
 Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
}
