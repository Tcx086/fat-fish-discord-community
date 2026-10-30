param([ValidateSet('Configure','Start','Check','SelfTest')][string]$Action = 'Configure')
$ErrorActionPreference = 'Stop'
# WinForms callbacks must not depend on first-use module auto-loading.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Global -ErrorAction Stop
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$appRoot = Join-Path $repoRoot 'Luna-Discord-Bot-Full-Docker\Luna'
$settingsDirectory = Join-Path $env:LOCALAPPDATA 'FatFish\desktop'
$settingsFile = Join-Path $settingsDirectory 'settings.json'
$runner = Join-Path $PSScriptRoot 'start.cjs'

function Initialize-PrivateDirectory([string]$Directory) {
    if (Test-Path -LiteralPath $Directory) {
        if ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked configuration directory refused.' }
    } else { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
    $acl = Get-Acl -LiteralPath $Directory
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    # Set-Acl also retries audit metadata on protected folders; persist only the changed DACL.
    [IO.Directory]::SetAccessControl($Directory, $acl)
}
function Protect-Secret([string]$Value) {
    $secret = ConvertTo-SecureString $Value -AsPlainText -Force
    try { return ConvertFrom-SecureString $secret } finally { $secret.Dispose() }
}
function Unprotect-Secret([string]$Ciphertext) {
    $secret = ConvertTo-SecureString $Ciphertext
    try { return [Net.NetworkCredential]::new('', $secret).Password } finally { $secret.Dispose() }
}
function Get-DeepSeekCipher($Settings) {
    if (![string]::IsNullOrWhiteSpace($Settings.deepseekCipher)) { return $Settings.deepseekCipher }
    $legacyFile = Join-Path $env:LOCALAPPDATA 'FatFish\credentials\deepseek.dpapi'
    if (Test-Path -LiteralPath $legacyFile -PathType Leaf) { return [IO.File]::ReadAllText($legacyFile).Trim() }
    return ''
}
function Assert-SavedCredentials($Settings) {
    $required = @(@{ name='Discord Bot Token'; cipher=$Settings.discordCipher })
    if ($Settings.enableDeepSeek) { $required += @{ name='DeepSeek API Key'; cipher=(Get-DeepSeekCipher $Settings) } }
    foreach ($credential in $required) {
        try {
            if ([string]::IsNullOrWhiteSpace($credential.cipher)) { throw 'Missing credential.' }
            $secret = ConvertTo-SecureString $credential.cipher
            try { if ($secret.Length -eq 0) { throw 'Empty credential.' } } finally { $secret.Dispose() }
        } catch { throw "Saved $($credential.name) is missing or unreadable. Open Configure-FatFish.cmd and save it under this Windows account." }
    }
}
function Save-Settings($Settings, [string]$Directory = $settingsDirectory) {
    Initialize-PrivateDirectory $Directory
    $destination = Join-Path $Directory 'settings.json'
    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked settings file refused.' }
    $temporary = Join-Path $Directory ([guid]::NewGuid().ToString() + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($Settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Read-Settings {
    if (Test-Path -LiteralPath $settingsFile) { return Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json }
    $profile = Get-Content -LiteralPath (Join-Path $appRoot '.env') -ErrorAction SilentlyContinue
    $guild = ''; $operators = ''
    foreach ($line in $profile) {
        if ($line -match '^CONVERSATION_GUILD_ID=(\d+)$') { $guild = $Matches[1] }
        if ($line -match '^CONVERSATION_OPERATOR_IDS=([\d,]+)$') { $operators = $Matches[1] }
    }
    return [pscustomobject]@{ botId=''; guildId=$guild; operatorIds=$operators; discordCipher=''; deepseekCipher=''; enableDeepSeek=$false }
}
function Test-Health([int]$Port) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}
function Start-LocalServices {
    if (!(Test-Health 18082)) {
        $binary = Join-Path $repoRoot 'local\latency\whisper-cuda\Release\whisper-server.exe'
        $model = Join-Path $repoRoot 'models\whisper\ggml-small-q5_1.bin'
        if (!(Test-Path -LiteralPath $binary) -or !(Test-Path -LiteralPath $model)) { throw 'Local Whisper files are missing; nothing will be downloaded.' }
        Write-Host '正在启动本地 Whisper...'
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"{0}"' -f (Join-Path $appRoot 'run-whisper-cuda.ps1'))) -WindowStyle Hidden | Out-Null
    }
    if (!(Test-Health 18882)) {
        Write-Host '正在启动本地 Feiyu（保持已有 cute 声线）...'
        $script = Join-Path $repoRoot 'Luna-Discord-Bot-Full-Docker\FeiyuTTS\run-wsl.sh'
        $linuxPath = & wsl.exe -d Ubuntu -- wslpath -a $script
        if ($LASTEXITCODE -ne 0 -or !$linuxPath) { throw 'Existing Feiyu WSL environment is unavailable.' }
        Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d','Ubuntu','--','bash', ('"{0}"' -f $linuxPath.Trim())) -WindowStyle Hidden | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (!(Test-Health 18082) -or !(Test-Health 18882)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Local voice service startup timed out. Discord has not been connected.' }
        Start-Sleep -Seconds 2
    }
}

if ($Action -eq 'SelfTest') {
    $testDirectory = Join-Path $PSScriptRoot ('credential-test-' + [guid]::NewGuid())
    try {
        $value = [pscustomobject]@{ discordCipher=(Protect-Secret 'synthetic-bot-token'); enableDeepSeek=$false }
        Save-Settings $value $testDirectory
        $text = Get-Content -LiteralPath (Join-Path $testDirectory 'settings.json') -Raw
        if ($text.Contains('synthetic-bot-token') -or (Unprotect-Secret (($text | ConvertFrom-Json).discordCipher)) -ne 'synthetic-bot-token') { throw 'Secret roundtrip failed.' }
        $acl = Get-Acl -LiteralPath $testDirectory
        if (!$acl.AreAccessRulesProtected -or $acl.Access.Count -ne 2) { throw 'Private ACL verification failed.' }
        Write-Output 'PASS: synthetic DPAPI roundtrip and private ACL; no service or Discord connection.'
    } finally {
        if ((Split-Path -Parent ([IO.Path]::GetFullPath($testDirectory))) -ne $PSScriptRoot) { throw 'Unexpected test cleanup path.' }
        if (Test-Path -LiteralPath (Join-Path $testDirectory 'settings.json')) { Remove-Item -LiteralPath (Join-Path $testDirectory 'settings.json') -Force }
        if (Test-Path -LiteralPath $testDirectory) { Remove-Item -LiteralPath $testDirectory -Force }
    }
    return
}

if ($Action -eq 'Check') {
    if (!(Test-Path -LiteralPath $settingsFile)) { Write-Output 'Configuration has not been saved. Use Configure-FatFish.cmd.'; return }
    Assert-SavedCredentials (Read-Settings)
    & node.exe $runner $settingsFile --check
    if ($LASTEXITCODE -ne 0) { throw 'Offline check failed.' }
    Write-Output 'PASS: saved required credentials are readable by this Windows account; no API calls.'
    return
}

if ($Action -eq 'Start') {
    if (!(Test-Path -LiteralPath $settingsFile)) { & $PSCommandPath -Action Configure }
    if (!(Test-Path -LiteralPath $settingsFile)) { return }
    $settings = Read-Settings
    try { Assert-SavedCredentials $settings } catch {
        Write-Warning '已保存的凭据不完整或当前 Windows 账户无法读取。请在配置窗口重新填写缺少的 Token / Key 并保存；取消不会启动服务。'
        & $PSCommandPath -Action Configure
        $settings = Read-Settings
        try { Assert-SavedCredentials $settings } catch {
            Write-Warning '所需凭据仍未保存或无法读取，本次未启动。请重新运行配置后再启动。'
            return
        }
    }
    $mutex = [Threading.Mutex]::new($false, 'Local\FatFishDesktopBot')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw 'Fat Fish is already running from this launcher.' }
        Assert-SavedCredentials $settings
        & node.exe $runner $settingsFile --check
        if ($LASTEXITCODE -ne 0) { throw 'Configuration validation failed.' }
        $env:DISCORD_TOKEN = Unprotect-Secret $settings.discordCipher
        $env:DEEPSEEK_API_KEY = ''
        if ($settings.enableDeepSeek) {
            $env:DEEPSEEK_API_KEY = Unprotect-Secret (Get-DeepSeekCipher $settings)
        }
        Start-LocalServices
        & node.exe $runner $settingsFile
        if ($LASTEXITCODE -ne 0) { throw 'Bot exited with an error. Check the configuration and Discord permissions.' }
    } finally {
        Remove-Item Env:DISCORD_TOKEN,Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
        if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose()
    }
    return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$settings = Read-Settings
$form = [Windows.Forms.Form]::new()
$form.Text = '大肥鱼 · 机器人配置 v0.3'
$form.ClientSize = [Drawing.Size]::new(650, 410)
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$intro = [Windows.Forms.Label]::new(); $intro.SetBounds(18, 14, 615, 48)
$intro.Text = "填一次并保存，以后双击 Start-FatFish.cmd 启动。`nToken 用当前 Windows 账户加密保存；保存不会连接 Discord。"
$form.Controls.Add($intro)
$boxes = @{}
$rows = @(@('botId','Bot / 应用 ID（可选，用于核对身份）'), @('guildId','服务器 ID（必填）'), @('operatorIds','操作员用户 ID（逗号分隔）'), @('discordCipher','Bot Token（必填，不是 Bot ID）'), @('deepseekCipher','DeepSeek Key（可留空沿用已保存的 Key）'))
$y=70
foreach ($row in $rows) {
    $label=[Windows.Forms.Label]::new(); $label.Text=$row[1]; $label.SetBounds(18,$y,300,24)
    $box=[Windows.Forms.TextBox]::new(); $box.SetBounds(320,$y-3,310,26)
    if ($row[0] -match 'Cipher$') { $box.UseSystemPasswordChar=$true } else { $box.Text=[string]$settings.($row[0]) }
    $boxes[$row[0]]=$box; $form.Controls.AddRange(@($label,$box)); $y+=42
}
$enable=[Windows.Forms.CheckBox]::new(); $enable.SetBounds(18,282,615,28)
$enable.Text='启用 DeepSeek 付费回复（每次启动最多 6 次，每次最多 128 输出 tokens）'; $enable.Checked=[bool]$settings.enableDeepSeek
$form.Controls.Add($enable)
$note=[Windows.Forms.Label]::new(); $note.SetBounds(18,315,615,42)
$note.Text="密钥框留空＝保留原密钥。不勾选 DeepSeek 可先测试频道管理。`n无需填写频道 ID：启动后在 Discord 使用 /join 和 /move。"
$form.Controls.Add($note)
$save=[Windows.Forms.Button]::new(); $save.Text='保存配置'; $save.SetBounds(505,363,125,32)
$save.Add_Click({
    $saveStage = '检查填写内容'
    try {
        if ($boxes.guildId.Text.Trim() -notmatch '^\d{17,20}$') { throw '请填写正确的服务器 ID。' }
        if ($boxes.botId.Text.Trim() -and $boxes.botId.Text.Trim() -notmatch '^\d{17,20}$') { throw 'Bot ID 格式不正确。' }
        $operators=@($boxes.operatorIds.Text.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($operators.Count -gt 16 -or @($operators | Where-Object { $_ -notmatch '^\d{17,20}$' }).Count) { throw '操作员 ID 格式不正确。' }
        if (!$settings.discordCipher -and !$boxes.discordCipher.Text.Trim()) { throw '需要 Bot Token；单独填写 Bot ID 不能连接。' }
        if ($enable.Checked -and !$boxes.deepseekCipher.Text.Trim() -and !(Get-DeepSeekCipher $settings)) { throw '启用 DeepSeek 需要保存 API Key。' }
        $settings.botId=$boxes.botId.Text.Trim(); $settings.guildId=$boxes.guildId.Text.Trim(); $settings.operatorIds=$operators -join ','
        $saveStage = 'Windows 账户加密'
        foreach ($key in @('discordCipher','deepseekCipher')) { if ($boxes[$key].Text.Trim()) { $settings.$key=Protect-Secret $boxes[$key].Text.Trim() } }
        $settings.enableDeepSeek=$enable.Checked
        if ($settings.enableDeepSeek) { $settings.deepseekCipher = Get-DeepSeekCipher $settings }
        $saveStage = '写入本机配置目录'
        Save-Settings $settings
        [void][Windows.Forms.MessageBox]::Show('已保存。现在可以双击 Start-FatFish.cmd 启动。','大肥鱼')
        $form.Close()
    } catch {
        if ($saveStage -eq '检查填写内容') {
            # Only our fixed validation messages are shown here; never echo field contents.
            $notice = switch -Exact ($_.Exception.Message) {
                '请填写正确的服务器 ID。' { '服务器 ID 应为 17–20 位数字。' }
                'Bot ID 格式不正确。' { 'Bot ID 应为 17–20 位数字，也可以留空。' }
                '操作员 ID 格式不正确。' { '操作员 ID 应为 17–20 位数字；多位用英文逗号分隔，也可以留空。' }
                '需要 Bot Token；单独填写 Bot ID 不能连接。' { '请填写 Bot Token；已有保存的 Token 时才可以留空。' }
                '启用 DeepSeek 需要保存 API Key。' { '尚未找到 DeepSeek Key。请填写 Key，或取消勾选 DeepSeek 后保存。' }
                default { '无法读取表单。请重新打开配置窗口。' }
            }
        } else {
            $notice = "保存失败：$saveStage。错误代码：$('{0:X8}' -f $_.Exception.HResult)。"
        }
        # Record diagnostics only: no exception message, form values, token or ciphertext.
        $diagnostic = @{ stage=$saveStage; exception=$_.Exception.GetType().FullName;
            hresult=$_.Exception.HResult; line=$_.InvocationInfo.ScriptLineNumber; at=[DateTime]::UtcNow.ToString('o') }
        try {
            $diagnosticDirectory = Join-Path $repoRoot 'local'
            if (!(Test-Path -LiteralPath $diagnosticDirectory)) { New-Item -ItemType Directory -Path $diagnosticDirectory | Out-Null }
            [IO.File]::WriteAllText((Join-Path $diagnosticDirectory 'configuration-save-error.json'), ($diagnostic | ConvertTo-Json))
        } catch { }
        [void][Windows.Forms.MessageBox]::Show($notice,'大肥鱼')
    }
})
$form.Controls.Add($save); $form.AcceptButton=$save
$form.Add_Shown({ $form.Activate(); $boxes.discordCipher.Focus() })
try { [void]$form.ShowDialog() } finally { $boxes.discordCipher.Clear(); $boxes.deepseekCipher.Clear(); $form.Dispose() }
