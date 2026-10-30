# Use Windows PowerShell 5.1 (powershell.exe), which provides System.Speech.
param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path -LiteralPath $Output).Path
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
    foreach ($sample in @(
        @('invocation', 'Microsoft Huihui Desktop', '大肥鱼，你觉得刚刚说的那个怎么样？'),
        @('bare', 'Microsoft Huihui Desktop', '大肥鱼'),
        @('thirdperson', 'Microsoft Huihui Desktop', '我刚才看到一个大肥鱼的视频。'),
        @('english', 'Microsoft David Desktop', 'The first plan is to visit the park. The second plan is to go shopping.')
    )) {
        $voice.SelectVoice($sample[1])
        $voice.SetOutputToWaveFile((Join-Path $Output ($sample[0] + '.wav')), $format)
        $voice.Speak($sample[2])
        $voice.SetOutputToNull()
    }
} finally {
    $voice.Dispose()
}
