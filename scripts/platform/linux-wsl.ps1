# Runs smoke.sh on a throwaway headless Linux in WSL 2: a fresh distro, a plain user, no Windows
# programs on its PATH, then removes the distro. No admin rights needed (WSL must be installed).
# See docs/platform-testing.md.
#
#   pwsh scripts/platform/linux-wsl.ps1                         # Ubuntu 24.04, this checkout's installer
#   pwsh scripts/platform/linux-wsl.ps1 -Distro Debian -Keep    # keep the distro to look around
#   pwsh scripts/platform/linux-wsl.ps1 -Installer https://symbio.linkzy.dev/install
#   npm pack --pack-destination $env:TEMP; pwsh scripts/platform/linux-wsl.ps1 -Package $env:TEMP\symbio-<version>.tgz
#   pwsh scripts/platform/linux-wsl.ps1 -Prepare "apt-get update && apt-get install -y libatomic1"
#
# The report goes to scripts/platform/results/ (ignored by git).
param(
  [string]$Distro = "Ubuntu-24.04",    # any name from `wsl --list --online`
  [string]$Installer = "",             # an https:// address; default: this checkout's scripts/install/install.sh
  [string]$Version = "",               # SYMBIO_VERSION for the installer; default: the latest release
  [string]$Runtimes = "opencode copilot",
  [string]$Package = "",               # a .tgz from `npm pack` to test instead of the published Symbio
  [string]$Prepare = "",               # run as root first, e.g. "apt-get update && apt-get install -y libatomic1"
  [switch]$Keep                        # leave the distro (and Symbio in it) for a look; remove it with wsl --unregister
)
$ErrorActionPreference = "Stop"
$env:WSL_UTF8 = "1" # wsl.exe writes UTF-16 otherwise

$here = $PSScriptRoot
$repo = Split-Path (Split-Path $here)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$name = "symbio-test-$stamp"
$location = Join-Path $env:LOCALAPPDATA "symbio-platform\wsl\$name"
$results = Join-Path $here "results"
New-Item -ItemType Directory -Force $results, $location | Out-Null
$report = Join-Path $results "$stamp-linux-$($Distro.ToLower()).txt"

function Wsl([string]$user, [string]$script) {
  # The script goes through stdin, so no quoting crosses the Windows/Linux line (PowerShell ends
  # the lines it pipes with CRLF: tr takes the CRs out).
  $script | wsl.exe -d $name -u $user -e sh -c "tr -d '\r' | sh"
  if ($LASTEXITCODE -ne 0) { throw "wsl ($user) failed with $LASTEXITCODE" }
}
function ToWsl([string]$path) {
  $full = (Resolve-Path $path).Path
  "/mnt/" + $full.Substring(0, 1).ToLower() + $full.Substring(2).Replace("\", "/")
}

Write-Host "Creating $name ($Distro)..."
wsl.exe --install $Distro --name $name --location $location --no-launch | Out-Host
if ($LASTEXITCODE -ne 0) { throw "wsl --install failed" }
$smokeExit = -1
try {
  # A clean machine: no Windows programs on the PATH (node, git, sym from Windows would hide what's
  # missing), and a plain user like a person's. /mnt/c stays, to read the scripts.
  Wsl root @"
printf '[interop]\nenabled=false\nappendWindowsPath=false\n[boot]\nsystemd=true\n' > /etc/wsl.conf
id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
"@
  wsl.exe --terminate $name | Out-Null

  # Copied in (not to /tmp: a restart empties it), so the tester reads them from its own disk as a downloaded file would be.
  $smoke = ToWsl (Join-Path $here "smoke.sh")
  $installerPath = if ($Installer) { $Installer } else { "/opt/symbio-smoke/install.sh" }
  Wsl root @"
mkdir -p /opt/symbio-smoke
cp '$smoke' /opt/symbio-smoke/smoke.sh
cp '$(ToWsl (Join-Path $repo "scripts\install\install.sh"))' /opt/symbio-smoke/install.sh
chmod 755 /opt/symbio-smoke/smoke.sh; chmod 644 /opt/symbio-smoke/install.sh
"@
  if ($Package) { Wsl root "cp '$(ToWsl $Package)' /opt/symbio-smoke/symbio.tgz && chmod 644 /opt/symbio-smoke/symbio.tgz" }
  if ($Prepare) {
    Write-Host "Preparing: $Prepare"
    Wsl root $Prepare
  }
  $envs = "SMOKE_INSTALLER='$installerPath' SMOKE_RUNTIMES='$Runtimes'"
  if ($Version) { $envs += " SYMBIO_VERSION='$Version'" }
  if ($Package) { $envs += " SMOKE_PACKAGE=/opt/symbio-smoke/symbio.tgz" }

  Write-Host "Running the smoke test as a plain user..."
  $header = @(
    "Symbio platform smoke test: headless Linux in WSL 2"
    "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm zzz')"
    "Distro: $Distro ($name)"
    "Package: $(if ($Package) { $Package } else { 'the published one' })"
    "Prepared with: $(if ($Prepare) { $Prepare } else { 'nothing (as it comes)' })"
    "Checkout: $(git -C $repo rev-parse --short HEAD) $(git -C $repo branch --show-current)"
    ""
  )
  $header | Set-Content $report
  # A login shell (su -), as a new terminal would be. Symbio stays installed for the second part.
  wsl.exe -d $name -u root -e su - tester -c "$envs SMOKE_KEEP=1 /opt/symbio-smoke/smoke.sh" 2>&1 | Tee-Object -FilePath $report -Append | Out-Host
  $smokeExit = $LASTEXITCODE
  # Then a reboot and a new login: what was saved must still be readable.
  Write-Host "Restarting the distro, then starting Symbio again..."
  wsl.exe --terminate $name | Out-Null
  "", "After a restart (a new login):" | Add-Content $report
  $keepAgain = if ($Keep) { " SMOKE_KEEP=1" } else { "" }
  wsl.exe -d $name -u root -e su - tester -c "$envs$keepAgain /opt/symbio-smoke/smoke.sh again" 2>&1 | Tee-Object -FilePath $report -Append | Out-Host
  $smokeExit += $LASTEXITCODE
} finally {
  if ($Keep) {
    Write-Host "Kept: wsl -d $name -u tester   (remove: wsl --unregister $name)"
  } else {
    wsl.exe --unregister $name | Out-Null
    Remove-Item -Recurse -Force $location -ErrorAction SilentlyContinue
  }
}
Write-Host "Report: $report"
exit $smokeExit
