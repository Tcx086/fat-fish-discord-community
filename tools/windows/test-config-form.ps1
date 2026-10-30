# Runs the real form and Save callback with synthetic values; no Discord or real credentials.
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'FatFish.ps1'))
$testRoot = Join-Path $PSScriptRoot ('form-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    foreach ($case in @('save','no-autoload','legacy-key','bad-guild','bad-operator','missing-token','missing-key')) {
        $caseRoot = Join-Path $testRoot $case
        New-Item -ItemType Directory -Path $caseRoot | Out-Null
        $prefix = $caseRoot.Replace("'", "''")
        $script = $source.Replace("`$settings = Read-Settings", "`$settings = [pscustomobject]@{ botId=''; guildId='100000000000000104'; operatorIds='100000000000000105'; discordCipher=''; deepseekCipher=''; enableDeepSeek=`$false }")
        $script = $script.Replace('[Windows.Forms.MessageBox]', '[FatFishFormTestMessages]')
        if ($case -eq 'no-autoload') {
            $bootstrap = @'
$PSModuleAutoLoadingPreference = 'None'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
Remove-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
'@
            $script = $script.Replace("`$ErrorActionPreference = 'Stop'", $bootstrap + "`n`$ErrorActionPreference = 'Stop'")
        }
        $setup = @"
Add-Type -TypeDefinition 'public static class FatFishFormTestMessages { public static string Last; public static int Show(string message, string title) { Last = message; return 0; } }'
`$repoRoot = '$prefix'
`$settingsDirectory = Join-Path `$repoRoot 'private'
`$env:LOCALAPPDATA = `$repoRoot
`$boxes.discordCipher.Text = 'synthetic-must-not-leak'
if ('$case' -eq 'bad-guild') { `$boxes.guildId.Text = 'invalid' }
if ('$case' -eq 'bad-operator') { `$boxes.operatorIds.Text = 'invalid' }
if ('$case' -eq 'missing-token') { `$boxes.discordCipher.Clear() }
if ('$case' -in @('legacy-key','missing-key')) { `$enable.Checked = `$true }
if ('$case' -eq 'legacy-key') {
    `$legacyDirectory = Join-Path `$env:LOCALAPPDATA 'FatFish\credentials'
    New-Item -ItemType Directory -Path `$legacyDirectory -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path `$legacyDirectory 'deepseek.dpapi'), (Protect-Secret 'synthetic-deepseek-key'))
}
`$form.Add_Shown({ `$save.PerformClick(); `$form.Close() })
"@
        $script = $script.Replace('try { [void]$form.ShowDialog() }', $setup + "`ntry { [void]`$form.ShowDialog() }")
        $script += @"
`$file = Join-Path `$settingsDirectory 'settings.json'
if ('$case' -in @('save','no-autoload','legacy-key')) {
    if (!(Test-Path -LiteralPath `$file)) { throw 'Actual Save button did not save.' }
    `$json = [IO.File]::ReadAllText(`$file)
    if (`$json.Contains('synthetic-must-not-leak')) { throw 'Plaintext persisted.' }
    if ((Unprotect-Secret ((`$json | ConvertFrom-Json).discordCipher)) -ne 'synthetic-must-not-leak') { throw 'Token roundtrip failed.' }
    `$saved = `$json | ConvertFrom-Json
    if ('$case' -eq 'legacy-key') {
        Remove-Item -LiteralPath (Join-Path `$env:LOCALAPPDATA 'FatFish\credentials\deepseek.dpapi') -Force
        if ((Unprotect-Secret `$saved.deepseekCipher) -ne 'synthetic-deepseek-key') { throw 'Legacy key was not retained in settings.' }
    }
    Assert-SavedCredentials `$saved
    `$saved.enableDeepSeek = `$true; `$saved.deepseekCipher = ''
    `$refused = `$false
    try { Assert-SavedCredentials `$saved } catch { `$refused = `$true }
    if (!`$refused) { throw 'Offline credential check accepted missing key.' }
} else {
    if (Test-Path -LiteralPath `$file) { throw 'Invalid form was saved.' }
    `$log = [IO.File]::ReadAllText((Join-Path `$repoRoot 'local\configuration-save-error.json'))
    if (`$log.Contains('synthetic-must-not-leak') -or `$log.Contains('100000000000000104')) { throw 'Form data leaked into diagnostic.' }
    `$expected = @{ 'bad-guild'='服务器 ID'; 'bad-operator'='操作员 ID'; 'missing-token'='Bot Token'; 'missing-key'='DeepSeek Key' }['$case']
    if (![FatFishFormTestMessages]::Last.Contains(`$expected)) { throw 'Specific field error missing.' }
}
Write-Output 'PASS actual Save callback: $case'
"@
        $file = Join-Path $caseRoot 'run.ps1'
        [IO.File]::WriteAllText($file, $script, [Text.UTF8Encoding]::new($true))
        & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File $file
        if ($LASTEXITCODE -ne 0) { throw "Form regression failed: $case" }
    }
} finally {
    if ((Split-Path -Parent ([IO.Path]::GetFullPath($testRoot))) -ne $PSScriptRoot) { throw 'Unexpected cleanup path' }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
