# Runs smoke.ps1 in Windows Sandbox: a clean, throwaway Windows (the same build as this one) where
# Symbio is installed as a new user would, under the default execution policy, with Defender on and
# no winget. The Sandbox is gone when it closes. See docs/platform-testing.md.
#
# Needs the Windows Sandbox feature (Windows 10/11 Pro or higher; "Área Restrita do Windows" in
# Portuguese), turned on in "Turn Windows features on or off", then a restart.
#
#   pwsh scripts/platform/windows-sandbox.ps1                  # this checkout's installer
#   pwsh scripts/platform/windows-sandbox.ps1 -Installer https://symbio.linkzy.dev/install.ps1
#   pwsh scripts/platform/windows-sandbox.ps1 -Keep            # leave the Sandbox open to look around
#
# The report goes to scripts/platform/results/ (ignored by git).
param(
  [string]$Installer = "",             # an https:// address; default: this checkout's scripts/install/install.ps1
  [string]$Version = "",               # SYMBIO_VERSION for the installer; default: the latest release
  [string]$Runtimes = "opencode copilot",
  [int]$TimeoutMinutes = 40,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
$repo = Split-Path (Split-Path $here)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$results = Join-Path $here "results"
$shared = Join-Path $env:LOCALAPPDATA "symbio-platform\sandbox\$stamp" # mapped into the Sandbox as C:\symbio-smoke
New-Item -ItemType Directory -Force $results, $shared | Out-Null
$report = Join-Path $results "$stamp-windows-sandbox.txt"

$wsbCli = Get-Command wsb.exe -ErrorAction SilentlyContinue
$client = Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue
if (-not $wsbCli -and -not $client) {
  throw "Windows Sandbox isn't turned on: Turn Windows features on or off → Windows Sandbox (Área Restrita do Windows), then restart."
}

Copy-Item (Join-Path $here "smoke.ps1") $shared
Copy-Item (Join-Path $repo "scripts\install\install.ps1") $shared
# What the smoke test is told, set before it runs (the logon command stays short).
$setup = @(
  "`$env:SMOKE_DIR = 'C:\symbio-smoke'"
  "`$env:SMOKE_RUNTIMES = '$Runtimes'"
  $(if ($Installer) { "`$env:SMOKE_INSTALLER = '$Installer'" })
  $(if ($Version) { "`$env:SYMBIO_VERSION = '$Version'" })
  $(if ($Keep) { "`$env:SMOKE_KEEP = '1'" })
) | Where-Object { $_ }
Set-Content (Join-Path $shared "setup.ps1") $setup

# As a user would: Windows PowerShell, the default execution policy, the script through iex.
$logon = "powershell.exe -NoExit -Command `"Get-Content -Raw C:\symbio-smoke\setup.ps1 | iex; Get-Content -Raw C:\symbio-smoke\smoke.ps1 | iex`""
$config = @"
<Configuration>
  <Networking>Enable</Networking>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$shared</HostFolder><SandboxFolder>C:\symbio-smoke</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>$([Security.SecurityElement]::Escape($logon))</Command></LogonCommand>
</Configuration>
"@

Write-Host "Starting Windows Sandbox..."
$sandboxId = $null
$process = $null
if ($wsbCli) {
  # Windows 11 24H2+: a CLI that starts, and later stops, this Sandbox by id.
  $out = (& $wsbCli.Source start --config $config) -join "`n"
  $sandboxId = [regex]::Match($out, "[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}").Value
  if (-not $sandboxId) { throw "wsb start didn't say which Sandbox it started: $out" }
  & $wsbCli.Source connect --id $sandboxId | Out-Null # its window, to watch it
} else {
  $wsbFile = Join-Path $shared "symbio-smoke.wsb"
  Set-Content $wsbFile $config
  $process = Start-Process $client.Source $wsbFile -PassThru
}

$done = Join-Path $shared "done"
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
Write-Host "Running the smoke test in the Sandbox (it takes several minutes; watch it in its window)..."
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep 10 }

$header = @(
  "Symbio platform smoke test: Windows Sandbox"
  "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm zzz')"
  "Host: $((Get-CimInstance Win32_OperatingSystem).Caption) $([Environment]::OSVersion.Version)"
  "Checkout: $(git -C $repo rev-parse --short HEAD) $(git -C $repo branch --show-current)"
  ""
)
$header | Set-Content $report
if (Test-Path (Join-Path $shared "report.txt")) { Get-Content (Join-Path $shared "report.txt") | Add-Content $report }
if (Test-Path (Join-Path $shared "installer.log")) { "", "Installer output:" | Add-Content $report; Get-Content (Join-Path $shared "installer.log") | Add-Content $report }
$fails = if (Test-Path $done) { [int](Get-Content $done) } else { "", "TIMEOUT: no result after $TimeoutMinutes minutes" | Add-Content $report; 1 }
Get-Content $report | Select-String "^(PASS|FAIL|INFO|RESULT|TIMEOUT)" | ForEach-Object { Write-Host $_.Line }

if ($Keep) {
  Write-Host "The Sandbox stays open; closing its window throws it away."
} else {
  if ($sandboxId) { & $wsbCli.Source stop --id $sandboxId | Out-Null }
  elseif ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
  Remove-Item -Recurse -Force $shared -ErrorAction SilentlyContinue
}
Write-Host "Report: $report"
exit $fails
