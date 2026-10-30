# Run in a dedicated terminal. Ctrl+C stops the resident local STT service.
param(
    [string]$Binary = "$PSScriptRoot/../../local/latency/whisper-cuda/Release/whisper-server.exe",
    [string]$Model = "$PSScriptRoot/../../models/whisper/ggml-small-q5_1.bin",
    [int]$Port = 18082
)
$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$Model = (Resolve-Path -LiteralPath $Model).Path
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid loopback port' }
if ((Get-FileHash -LiteralPath $Model -Algorithm SHA256).Hash -ne 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb') {
    throw 'Expected the validated multilingual small-q5_1 model'
}
Write-Output "Starting resident CUDA STT at http://127.0.0.1:$Port; diagnostics and transcripts are not persisted."
# whisper-server may print recognized text; discard both output channels.
& $Binary -m $Model --host 127.0.0.1 --port $Port -t 4 -bs 1 -bo 1 -nt -l auto *> $null
if ($LASTEXITCODE -ne 0) { throw "Whisper exited with code $LASTEXITCODE" }
