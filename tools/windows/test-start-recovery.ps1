# Exercise the actual Start branch with synthetic credentials and mocked services/node.
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'FatFish.ps1'))
$testRoot = Join-Path $PSScriptRoot ('start-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    foreach ($case in @('valid','missing-discord','missing-key','unreadable','cancelled')) {
        $caseRoot = Join-Path $testRoot $case
        New-Item -ItemType Directory -Path $caseRoot | Out-Null
        $prefix = $caseRoot.Replace("'", "''")
        $setup = @"
`$settingsFile = Join-Path '$prefix' 'settings.json'
`$env:LOCALAPPDATA = '$prefix'
`$script:configureCalls = 0; `$script:serviceCalls = 0; `$script:nodeCalls = 0
function Write-SyntheticSettings([bool]`$Valid) {
    `$saved = [pscustomobject]@{ discordCipher=(Protect-Secret 'synthetic-discord'); deepseekCipher=(Protect-Secret 'synthetic-key'); enableDeepSeek=`$true }
    if (!`$Valid) {
        if ('$case' -in @('missing-discord','cancelled')) { `$saved.discordCipher = '' }
        if ('$case' -eq 'missing-key') { `$saved.deepseekCipher = '' }
        if ('$case' -eq 'unreadable') { `$saved.discordCipher = 'synthetic-invalid-cipher' }
    }
    [IO.File]::WriteAllText(`$settingsFile, (`$saved | ConvertTo-Json))
}
function Start-LocalServices { `$script:serviceCalls++ }
function node.exe { `$script:nodeCalls++; `$global:LASTEXITCODE = 0 }
Write-SyntheticSettings (`$true -and '$case' -eq 'valid')
`$env:DISCORD_TOKEN = ''; `$env:DEEPSEEK_API_KEY = ''
"@
        $configure = @"
`$script:configureCalls++
        if (`$script:serviceCalls -or `$script:nodeCalls) { throw 'Services ran before credential recovery.' }
        if ('$case' -ne 'cancelled') { Write-SyntheticSettings `$true }
"@
        $script = $source.Replace("if (`$Action -eq 'Start') {", $setup + "`nif (`$Action -eq 'Start') {")
        $script = $script.Replace('& $PSCommandPath -Action Configure', $configure)
        $script = $script.Replace("'Local\FatFishDesktopBot'", ("'Local\FatFishSynthetic-" + [guid]::NewGuid() + "'"))
        # Start returns before the form; wrap it so postconditions still run.
        $script = "& {`n" + $script + "`n} -Action Start`n"
        $script += @"
if ('$case' -eq 'cancelled') {
    if (`$script:serviceCalls -or `$script:nodeCalls) { throw 'Cancelled recovery started a service.' }
} else {
    if (`$script:serviceCalls -ne 1 -or `$script:nodeCalls -ne 2) { throw 'Validated startup did not reach the mocked runner.' }
}
`$expected = if ('$case' -eq 'valid') { 0 } else { 1 }
if (`$script:configureCalls -ne `$expected) { throw 'Unexpected configuration prompt count.' }
if (`$env:DISCORD_TOKEN -or `$env:DEEPSEEK_API_KEY) { throw 'Credentials remained in process environment.' }
Write-Output 'PASS offline startup recovery: $case'
"@
        $file = Join-Path $caseRoot 'run.ps1'
        [IO.File]::WriteAllText($file, $script, [Text.UTF8Encoding]::new($true))
        & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File $file -Action Start
        if ($LASTEXITCODE -ne 0) { throw "Startup recovery failed: $case" }
    }
} finally {
    if ((Split-Path -Parent ([IO.Path]::GetFullPath($testRoot))) -ne $PSScriptRoot) { throw 'Unexpected cleanup path.' }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
