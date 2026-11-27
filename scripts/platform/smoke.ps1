# Symbio's platform smoke test for Windows, run as the user on a clean Windows (the Windows Sandbox
# from windows-sandbox.ps1, a VM). It installs Symbio the way a new user does (the installer through
# `iex`, under the default execution policy), starts it, and checks what a fresh machine tends to
# break: the PATH, the private Node.js, shortcuts, git, the vault (Credential Manager), the runtime
# downloads, Defender, update in place, uninstall. See docs/platform-testing.md.
#
# Windows PowerShell 5.1 compatible, and run through `iex` (so no param block and no exit):
#   Get-Content -Raw smoke.ps1 | iex
#
#   $env:SMOKE_INSTALLER   the installer: a file (default: install.ps1 next to this script) or an
#                          https:// address (fetched with irm, as users do)
#   $env:SMOKE_RUNTIMES    runtimes to install through Symbio (default "opencode copilot"; "" for none)
#   $env:SMOKE_DIR         the folder with this script and the installer; the report, the installer's
#                          log and a "done" file go there too (default: C:\symbio-smoke)
#   $env:SMOKE_KEEP        "1": leave Symbio installed at the end
#
# On a machine you use (a dry run of this script), keep away from your Symbio: set SYMBIO_HOME to a
# temporary folder and SYMBIO_NO_PATH, SYMBIO_NO_SHORTCUT and SYMBIO_NO_GIT to "1" (those checks are
# then skipped). The vault key always goes to its own credential entry, never Symbio's.
#
# The installed copy never asks the update endpoint (it would be counted as a user), and it uses its
# own port so it can't meet a Symbio running elsewhere.

# Through iex there's no $PSScriptRoot: the folder the Sandbox maps, or SMOKE_DIR.
$smokeDir = if ($env:SMOKE_DIR) { $env:SMOKE_DIR } elseif ($PSScriptRoot) { $PSScriptRoot } else { "C:\symbio-smoke" }
$env:SYMBIO_UPDATE_URL = "off"
$env:SYMBIO_NO_OPEN = "1"
if (-not $env:SYMBIO_PORT) { $env:SYMBIO_PORT = "4399" }
if (-not $env:SYMBIO_KEYRING_SERVICE) { $env:SYMBIO_KEYRING_SERVICE = "symbio-smoke" }
$smokeHome = if ($env:SYMBIO_HOME) { $env:SYMBIO_HOME } else { Join-Path $env:USERPROFILE ".symbio" }
$smokeBase = "http://127.0.0.1:$($env:SYMBIO_PORT)/api"
$smokeInstaller = if ($env:SMOKE_INSTALLER) { $env:SMOKE_INSTALLER } else { Join-Path $smokeDir "install.ps1" }
$smokeRuntimes = if ($null -ne $env:SMOKE_RUNTIMES) { $env:SMOKE_RUNTIMES } else { "opencode copilot" }
$smokeReport = Join-Path $smokeDir "report.txt"
$smokeSym = Join-Path $smokeHome "app\launcher\sym.cmd"
$script:smokeFails = 0
Set-Content -Path $smokeReport -Value @() -Encoding UTF8

function Out-Smoke([string]$line) { Write-Host $line; Add-Content -Path $smokeReport -Value $line -Encoding UTF8 }
function Pass([string]$what) { Out-Smoke "PASS $what" }
function Fail([string]$what, [string]$detail = "") { $script:smokeFails++; Out-Smoke ("FAIL $what" + $(if ($detail) { ": $detail" } else { "" })) }
function Info([string]$what) { Out-Smoke "INFO $what" }
function Invoke-Installer {
  $global:SymbioInstallOk = $false
  $text = if ($smokeInstaller -match '^https?://') { Invoke-RestMethod $smokeInstaller } else { Get-Content -Raw $smokeInstaller }
  $text | Invoke-Expression *>&1 | Out-String | Add-Content -Path (Join-Path $smokeDir "installer.log") -Encoding UTF8
  $global:SymbioInstallOk
}
function Invoke-Api([string]$method, [string]$path, $body = $null) {
  $req = @{ Method = $method; Uri = "$smokeBase$path"; UseBasicParsing = $true; Headers = @{ "x-symbio-token" = $script:smokeToken }; ContentType = "application/json" }
  if ($null -ne $body) { $req.Body = ($body | ConvertTo-Json -Depth 5 -Compress) }
  try {
    $r = Invoke-WebRequest @req
    @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    @{ Status = $code; Body = $_.ErrorDetails.Message }
  }
}
function Start-Symbio { & $smokeSym *> $null; Start-Sleep 5; $script:smokeToken = (Get-Content -Raw (Join-Path $smokeHome "ui-token") -ErrorAction SilentlyContinue).Trim() }
function Stop-Symbio {
  & $smokeSym stop *> $null
  Start-Sleep 2
  if ((Invoke-Api GET "/runtime").Status -eq 0) { Pass "sym stop" } else { Fail "sym stop" "still answering" }
}

$os = Get-CimInstance Win32_OperatingSystem
Info "system: $($os.Caption) $($os.Version) ($env:PROCESSOR_ARCHITECTURE); PowerShell $($PSVersionTable.PSVersion)"
Info "user: $env:USERNAME; execution policy: $(Get-ExecutionPolicy); installer: $smokeInstaller"
foreach ($tool in "git", "node", "npm", "winget") {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  Info ("${tool}: " + $(if ($found) { $found.Source } else { "not installed" }))
}

# 1. Install, as `irm … | iex`.
$env:SYMBIO_NO_START = "1"
if (Invoke-Installer) { Pass "installer" } else { Fail "installer" "see installer.log" }
$nodeExe = Join-Path $smokeHome "node\node.exe"
if (Test-Path $nodeExe) { Pass "private Node.js ($(& $nodeExe --version))" } else { Fail "private Node.js" "$nodeExe is missing" }
if (Test-Path $smokeSym) { Pass "launcher" } else { Fail "launcher" "$smokeSym is missing" }
if ($env:SYMBIO_NO_PATH -ne "1") {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -contains (Split-Path $smokeSym)) { Pass "sym on the user PATH (new terminals)" } else { Fail "sym on the user PATH" $userPath }
  Info "user PATH registry type: $((Get-Item "HKCU:\Environment").GetValueKind("Path"))"
}
if ($env:SYMBIO_NO_SHORTCUT -ne "1") {
  foreach ($lnk in (Join-Path ([Environment]::GetFolderPath("Programs")) "Symbio.lnk"), (Join-Path ([Environment]::GetFolderPath("Desktop")) "Symbio.lnk")) {
    if (Test-Path $lnk) { Pass "shortcut $(Split-Path -Leaf (Split-Path $lnk))\Symbio.lnk" } else { Fail "shortcut" "$lnk is missing" }
  }
}
if ($env:SYMBIO_NO_GIT -ne "1") {
  # Installed just now: this session's PATH doesn't have it yet.
  $gitExe = @((Get-Command git -ErrorAction SilentlyContinue).Source, "$env:ProgramFiles\Git\cmd\git.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($gitExe) { Pass "git ($(& $gitExe --version))" } else { Fail "git" "not installed by the installer" }
}

if ($script:smokeFails -eq 0 -or (Test-Path $smokeSym)) {
  $version = & $smokeSym --version 2>&1
  if ($LASTEXITCODE -eq 0) { Pass "sym --version ($version)" } else { Fail "sym --version" "$version" }

  # 2. Start; the API answers, and only with the key.
  Start-Symbio
  $script:smokeToken = ""
  $locked = Invoke-Api GET "/runtime"
  $script:smokeToken = (Get-Content -Raw (Join-Path $smokeHome "ui-token") -ErrorAction SilentlyContinue).Trim()
  if ($locked.Status -eq 401) { Pass "Symbio answers, locked without the key" } else { Fail "Symbio answers" "HTTP $($locked.Status)" }
  $r = Invoke-Api GET "/runtime"
  if ($r.Status -eq 200) { Pass "API with the key" } else { Fail "API with the key" "HTTP $($r.Status) $($r.Body)" }
  $r = Invoke-Api GET "/setup"
  if ($r.Status -eq 200) { Info "setup: $($r.Body)" } else { Fail "GET /setup" "HTTP $($r.Status) $($r.Body)" }

  # 3. The vault (Windows Credential Manager).
  $r = Invoke-Api PUT "/notifications" @{ webhook = @{ url = "https://example.com/symbio-smoke" } }
  if ($r.Status -eq 200 -and ($r.Body | ConvertFrom-Json).secrets."webhook.url") { Pass "vault (a secret saved)" } else { Fail "vault (a secret saved)" "HTTP $($r.Status) $($r.Body)" }

  # 4. Runtimes downloaded by Symbio.
  foreach ($kind in ($smokeRuntimes -split " " | Where-Object { $_ })) {
    $r = Invoke-Api POST "/runtimes/$kind/install"
    if ($r.Status -ne 202) { Fail "install $kind" "HTTP $($r.Status) $($r.Body)"; continue }
    $waited = 0
    do {
      Start-Sleep 5; $waited += 5
      $view = ((Invoke-Api GET "/runtimes").Body | ConvertFrom-Json) | Where-Object { $_.kind -eq $kind }
    } while ($view.installing -and $waited -lt 600)
    if ($view.installed) { Pass "install $kind ($($view.installedVersion), ${waited}s)" }
    else { Fail "install $kind" $(if ($view.installError) { $view.installError } else { ($view.installLog | Select-Object -Last 3) -join " | " }) }
  }
  $views = (Invoke-Api GET "/runtimes").Body | ConvertFrom-Json
  Info ("runtimes: " + (($views | ForEach-Object { "$($_.kind)=$($_.state)" + $(if ($_.error) { " ($($_.error))" } else { "" }) }) -join ", "))
  Stop-Symbio

  # 5. Started again: the secret is still readable.
  Start-Symbio
  $r = Invoke-Api GET "/notifications"
  if ($r.Status -eq 200 -and ($r.Body | ConvertFrom-Json).secrets."webhook.url") { Pass "vault after a restart" } else { Fail "vault after a restart" "HTTP $($r.Status) $($r.Body)" }
  Stop-Symbio
  Get-Content (Join-Path $smokeHome "logs\symbio.log") -ErrorAction SilentlyContinue | Where-Object { $_ -match "error|warn" -and $_ -notmatch "^\s+at " } | Select-Object -Last 10 | ForEach-Object { Info "log: $_" }

  # 6. Defender: did it flag anything (the installer, Node.js, the runtimes)?
  try {
    $threats = @(Get-MpThreatDetection -ErrorAction Stop)
    if ($threats.Count -eq 0) { Pass "Defender flagged nothing" } else { Fail "Defender" (($threats | ForEach-Object { ($_.Resources -join ", ") }) -join "; ") }
  } catch { Info "Defender: couldn't ask ($($_.Exception.Message))" }

  # 7. Running the installer again updates in place; then uninstall.
  if (Invoke-Installer) { Pass "installer again (in place)" } else { Fail "installer again" "see installer.log" }
}
if ($env:SMOKE_KEEP -ne "1") {
  $env:SYMBIO_UNINSTALL = "1"
  $ok = Invoke-Installer
  Remove-Item Env:\SYMBIO_UNINSTALL
  if ($ok -and -not (Test-Path (Join-Path $smokeHome "app")) -and -not (Test-Path (Join-Path $smokeHome "node"))) { Pass "uninstall" } else { Fail "uninstall" "see installer.log" }
  if ($env:SYMBIO_NO_PATH -ne "1") {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -contains (Split-Path $smokeSym)) { Fail "uninstall cleans the PATH" } else { Pass "uninstall cleans the PATH" }
  }
}
# The vault key the test made (its own entry, see above).
if ($env:SMOKE_KEEP -ne "1") { cmdkey.exe "/delete:vault-master-key.$($env:SYMBIO_KEYRING_SERVICE)" *> $null }
Out-Smoke "RESULT $($script:smokeFails) failed"
Set-Content -Path (Join-Path $smokeDir "done") -Value $script:smokeFails
