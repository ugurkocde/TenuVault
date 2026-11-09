# Reads three responses from a local HTTP server through the cloud backup runbook's Invoke-TvHttp
# with a 1024 byte cap, for test/cloud-change-report.test.ts: one that declares a larger length,
# one sent chunked without a length that runs past the cap, one under the cap, and one that stops
# sending mid-body, read with a 1 second body deadline.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()
$prefix = "http://127.0.0.1:$port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()
$server = [powershell]::Create()
[void]$server.AddScript({
    param($listener)
    for ($i = 0; $i -lt 4; $i++) {
        $context = $listener.GetContext()
        $path = $context.Request.Url.AbsolutePath
        if ($path -eq "/stall") {
            # Declares 500 bytes, sends 100, then stalls longer than the deadline.
            $context.Response.ContentLength64 = 500
            $context.Response.OutputStream.Write([byte[]]::new(100), 0, 100)
            $context.Response.OutputStream.Flush()
            Start-Sleep -Seconds 6
            try { $context.Response.Abort() } catch { }
            continue
        }
        $body = [byte[]]::new($(if ($path -eq "/small") { 100 } else { 65536 }))
        if ($path -eq "/chunked") { $context.Response.SendChunked = $true } else { $context.Response.ContentLength64 = $body.Length }
        try { $context.Response.OutputStream.Write($body, 0, $body.Length) } catch { }
        try { $context.Response.Close() } catch { }
    }
}).AddArgument($listener)
$async = $server.BeginInvoke()
$results = [ordered]@{}
$script:BodyReadSeconds = 1
foreach ($path in @("declared", "chunked", "small", "stall")) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-TvHttp -Uri "$prefix$path" -Token "t" -MaxBytes 1024
        $results[$path] = "read $($response.Bytes.Length)"
    } catch [TvOversizedError] { $results[$path] = "oversized" }
    catch [TvReadTimeoutError] { $results[$path] = "timed out" }
    if ($path -eq "stall") { $results.stallSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 1) }
}
[void]$server.EndInvoke($async)
$listener.Stop()
[Console]::Out.Write(($results | ConvertTo-Json -Compress))
