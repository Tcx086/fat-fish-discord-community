param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][string]$Fixtures,
    [Parameter(Mandatory)][string]$Output,
    [ValidateRange(1024,65535)][int]$Port = 18084
)
$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$Model = (Resolve-Path -LiteralPath $Model).Path
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path -LiteralPath $Output).Path
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $probe.Start() } finally { $probe.Stop() }
foreach ($mode in @('cpu4', 'cpu8', 'cpu12', 'cuda4')) {
    $threads = [int]($mode -replace '\D', '')
    $serverArgs = @('-m', ('"' + $Model + '"'), '--host', '127.0.0.1', '--port', $Port, '-t', $threads, '-bs', '1', '-bo', '1', '-nt', '-l', 'auto')
    if ($mode.StartsWith('cpu')) { $serverArgs += '-ng' }
    $server = Start-Process -FilePath $Binary -ArgumentList $serverArgs -PassThru -WindowStyle Hidden -RedirectStandardError "$Output/$mode-server.log" -RedirectStandardOutput "$Output/$mode-stdout.log"
    try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            if ($server.HasExited) { throw "Whisper exited: $mode" }
            try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1 | Out-Null; $ready = $true; break } catch {}
            Start-Sleep -Milliseconds 200
        }
        if (-not $ready) { throw 'Whisper startup timed out' }
        if ($server.HasExited) { throw "Whisper exited before benchmark: $mode" }
        node "$PSScriptRoot/stt-latency.cjs" "http://127.0.0.1:$Port/inference" $Fixtures 3 > "$Output/$mode.json"
        if ($LASTEXITCODE -ne 0) { throw "Benchmark failed: $mode" }
        Write-Output "Completed $mode"
    } finally {
        if (-not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
        $server.Dispose()
    }
}
