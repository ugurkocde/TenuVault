# Reads three responses from a local HTTP server through the cloud backup runbook's Invoke-TvHttp
# with a 1024 byte cap, for test/cloud-change-report.test.ts: one that declares a larger length,
# one sent chunked without a length that runs past the cap, one under the cap, and one that stops
# sending mid-body, read with a 1 second body deadline. Then two 403 answers: one whose error body
# is far over the 64 KiB error cap and one whose error body stalls mid-way.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1") -LibraryOnly
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()
$prefix = "http://127.0.0.1:$port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()
# Two workers, so a stalled answer never delays the next request.
$handler = {
    param($listener)
    while ($true) {
        try { $context = $listener.GetContext() } catch { break }
        $path = $context.Request.Url.AbsolutePath
        if ($path -eq "/errorstall") {
            $context.Response.StatusCode = 403
            $context.Response.ContentLength64 = 500
            $context.Response.OutputStream.Write([byte[]]::new(100), 0, 100)
            $context.Response.OutputStream.Flush()
            Start-Sleep -Seconds 5
            try { $context.Response.Abort() } catch { }
            continue
        }
        if ($path -eq "/errorlarge") {
            # 8 MiB of error body, sent chunked so no length warns the reader.
            $context.Response.StatusCode = 403
            $context.Response.SendChunked = $true
            $chunk = [byte[]]::new(65536)
            try { for ($j = 0; $j -lt 128; $j++) { $context.Response.OutputStream.Write($chunk, 0, $chunk.Length) } } catch { }
            try { $context.Response.Close() } catch { }
            continue
        }
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
}
$servers = @(1, 2) | ForEach-Object {
    $server = [powershell]::Create()
    [void]$server.AddScript($handler).AddArgument($listener)
    [pscustomobject]@{ Server = $server; Async = $server.BeginInvoke() }
}
$results = [ordered]@{}
$script:BodyReadSeconds = 1
foreach ($path in @("declared", "chunked", "small", "errorlarge", "errorstall", "stall")) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-TvHttp -Uri "$prefix$path" -Token "t" -MaxBytes 1024
        $results[$path] = "read $($response.Bytes.Length)"
    } catch [TvOversizedError] { $results[$path] = "oversized" }
    catch [TvReadTimeoutError] { $results[$path] = "timed out" }
    catch [TvHttpError] { $results[$path] = "http $($_.Exception.Status)" }
    $results["$($path)Seconds"] = [Math]::Round($clock.Elapsed.TotalSeconds, 1)
}
$listener.Stop()
foreach ($worker in $servers) { [void]$worker.Server.EndInvoke($worker.Async) }
[Console]::Out.Write(($results | ConvertTo-Json -Compress))
