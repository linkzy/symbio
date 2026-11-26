# Symbio's one-line installer for Windows:
#
#   irm https://symbio.linkzy.dev/install.ps1 | iex
#
# Installs Symbio without needing Node.js first: a private copy of Node.js (the official archive
# from nodejs.org, checked against its SHASUMS256) in ~/.symbio/node, Symbio from npm in
# ~/.symbio/app, the `sym` command, Start-menu and desktop shortcuts and, unless told not to, git.
# Nothing system-wide but git; no admin rights (git's installer may ask). Running it again updates
# or repairs the install. Symbio still updates itself from npm, as with `npm install -g symbio`.
#
# Options, as environment variables set before the line:
#   $env:SYMBIO_UNINSTALL = "1"    remove what this installed (your projects and Symbio's data stay)
#   $env:SYMBIO_VERSION = "0.36.0" install that version instead of the latest
#   $env:SYMBIO_NO_GIT = "1"       don't install git
#   $env:SYMBIO_NO_SHORTCUT = "1"  no Start-menu or desktop shortcut
#   $env:SYMBIO_NO_START = "1"     don't start Symbio at the end
#   $env:SYMBIO_NO_PATH = "1"      don't add `sym` to your PATH (run it from ~/.symbio/app/launcher)
#
# Written for Windows PowerShell 5.1 (what a new Windows has) as well as PowerShell 7. It runs
# inside `iex`, in the user's own session: it never calls `exit` (that would close their window)
# and puts back what it changes in the session. $global:SymbioInstallOk says how it went.

& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue" # Windows PowerShell's progress bar makes downloads many times slower
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $global:SymbioInstallOk = $false

  $SymbioHome = if ($env:SYMBIO_HOME) { $env:SYMBIO_HOME } else { Join-Path $env:USERPROFILE ".symbio" }
  $NodeDir = Join-Path $SymbioHome "node"
  $AppDir = Join-Path $SymbioHome "app"
  $BinDir = Join-Path $AppDir "launcher"
  $Registry = if ($env:SYMBIO_INSTALL_REGISTRY) { $env:SYMBIO_INSTALL_REGISTRY.TrimEnd("/") } else { "https://registry.npmjs.org" }

  function Say($text) { Write-Host "  $text" }
  function Step($text) { Write-Host ""; Write-Host "> $text" -ForegroundColor Cyan }
  function Good($text) { Write-Host "  $text" -ForegroundColor Green }
  function Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }

  function Get-NodeMajor($exe) {
    try { $v = & $exe --version 2>$null; if ($v -match "^v(\d+)\.") { return [int]$Matches[1] } } catch {}
    return 0
  }

  # The user's PATH (not the session's), as a list, read and written as it's stored: entries like
  # %USERPROFILE%\... stay unexpanded ([Environment]::SetEnvironmentVariable would expand them all).
  function Get-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
    $p = if ($key) { $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { "" }
    if ($key) { $key.Close() }
    if ($p) { @($p.Split(";") | Where-Object { $_ }) } else { @() }
  }
  function Set-UserPath($dirs) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    $key.SetValue("Path", (@($dirs) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $key.Close()
    # Tell open programs (Explorer, so new terminals) that the environment changed.
    [Environment]::SetEnvironmentVariable("SYMBIO_INSTALL_PING", "1", "User")
    [Environment]::SetEnvironmentVariable("SYMBIO_INSTALL_PING", $null, "User")
  }
  # The session's PATH as a new terminal would have it (after installing git, for example).
  function Update-SessionPath {
    $env:Path = (@([Environment]::GetEnvironmentVariable("Path", "Machine"), [Environment]::GetEnvironmentVariable("Path", "User")) | Where-Object { $_ }) -join ";"
  }

  function Get-ShortcutPaths {
    @((Join-Path ([Environment]::GetFolderPath("Programs")) "Symbio.lnk"), (Join-Path ([Environment]::GetFolderPath("Desktop")) "Symbio.lnk"))
  }

  # Runs a .cmd quietly through cmd.exe: Windows PowerShell turns a native program's stderr into
  # errors that stop the script when it's redirected.
  function Invoke-Quiet($exe, $arguments) { cmd.exe /c "`"$exe`" $arguments >nul 2>&1" }

  # Stops the Symbio this installer put here, if it runs (Windows keeps running files locked).
  function Stop-OwnSymbio {
    $sym = Join-Path $BinDir "sym.cmd"
    if (Test-Path $sym) { Invoke-Quiet $sym "stop" }
  }

  # ---- uninstall
  if ($env:SYMBIO_UNINSTALL -eq "1") {
    try {
      Step "Removing Symbio"
      Stop-OwnSymbio
      foreach ($dir in @($AppDir, $NodeDir)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Say "Removed $dir" } }
      $paths = @(Get-UserPath)
      $kept = @($paths | Where-Object { $_.TrimEnd("\") -ne $BinDir })
      if ($kept.Count -ne $paths.Count) { Set-UserPath $kept; Say "Removed $BinDir from your PATH" }
      foreach ($lnk in Get-ShortcutPaths) { if (Test-Path $lnk) { Remove-Item -Force $lnk } }
      Good "Symbio is removed. Your projects weren't touched."
      Say "Symbio's own data (settings, history, backups) is still in $SymbioHome; delete that folder to remove it too."
      $global:SymbioInstallOk = $true
    } catch {
      Write-Host "  Symbio couldn't be removed: $($_.Exception.Message)" -ForegroundColor Red
      Say "Close Symbio (sym stop) and run the line again."
    }
    return
  }

  try {
    Write-Host ""
    Write-Host "Symbio installer" -ForegroundColor Cyan
    Say "A team of AI agents on your computer. This takes a few minutes."

    # ---- which Symbio, and the Node.js it needs
    Step "Checking the latest Symbio"
    $spec = if ($env:SYMBIO_VERSION) { $env:SYMBIO_VERSION } else { "latest" }
    $meta = Invoke-RestMethod "$Registry/symbio/$spec"
    $version = $meta.version
    $minNode = 22
    if ($meta.engines -and ($meta.engines.node -match "(\d+)")) { $minNode = [int]$Matches[1] }
    Say "Symbio $version (needs Node.js $minNode or newer)"

    # A copy installed earlier with npm (npm install -g symbio) is updated where it is, not doubled.
    $existing = Get-Command sym.cmd -ErrorAction SilentlyContinue | Where-Object { -not $_.Source.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing -and $systemNode -and ((Get-NodeMajor $systemNode.Source) -ge $minNode)) {
      Step "Updating the Symbio installed with npm"
      Say "Found $($existing.Source)"
      Invoke-Quiet $existing.Source "stop"
      & npm.cmd install -g "symbio@$version" --no-fund --no-audit --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm couldn't install Symbio $version (see above)." }
      $sym = $existing.Source
    } else {
      # ---- a private Node.js
      Step "Node.js"
      $node = Join-Path $NodeDir "node.exe"
      if ((Get-NodeMajor $node) -ge $minNode) {
        Say "Symbio's Node.js $(& $node --version) is in place"
      } else {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
        $releases = Invoke-RestMethod "https://nodejs.org/dist/index.json"
        $pick = $releases | Where-Object { $_.lts -and ([int]($_.version.TrimStart("v").Split(".")[0]) -ge $minNode) -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
        if (-not $pick) { throw "No Node.js $minNode+ build for Windows $arch was found on nodejs.org." }
        $v = $pick.version
        $name = "node-$v-win-$arch"
        Say "Downloading Node.js $v (a private copy for Symbio, about 30 MB)"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("symbio-node-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        try {
          $zip = Join-Path $tmp "$name.zip"
          Invoke-WebRequest "https://nodejs.org/dist/$v/$name.zip" -OutFile $zip -UseBasicParsing
          $sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt" -UseBasicParsing).RawContentStream.ToArray())
          $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
          if (-not $line) { throw "Node.js's checksum list has no entry for $name.zip." }
          $expected = ($line.Trim() -split "\s+")[0]
          $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
          if ($actual -ne $expected.ToUpper()) { throw "The Node.js download doesn't match its published checksum; nothing was installed. Try again." }
          Say "Checked against nodejs.org's SHA-256 checksums"
          Expand-Archive $zip -DestinationPath $tmp -Force
          Stop-OwnSymbio
          if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
          New-Item -ItemType Directory -Path $SymbioHome -Force | Out-Null
          Move-Item (Join-Path $tmp $name) $NodeDir
        } finally {
          Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }
        Good "Node.js $v is ready in $NodeDir"
      }

      # ---- Symbio, with that Node.js's npm, in its own folder
      Step "Installing Symbio $version"
      Stop-OwnSymbio
      $savedPath = $env:Path
      try {
        $env:Path = "$NodeDir;$env:Path" # npm and the packages' install steps use this Node.js
        & (Join-Path $NodeDir "npm.cmd") install -g "symbio@$version" --prefix $AppDir --no-fund --no-audit --loglevel=error --registry "$Registry/"
        if ($LASTEXITCODE -ne 0) { throw "npm couldn't install Symbio $version (see above)." }
      } finally {
        $env:Path = $savedPath
      }

      # `sym` runs Symbio with the private Node.js, which stays off the PATH.
      New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
      $setHome = if ($env:SYMBIO_HOME) { "set `"SYMBIO_HOME=$env:SYMBIO_HOME`"`r`n" } else { "" }
      $cmd = "@echo off`r`n$setHome`"%~dp0..\..\node\node.exe`" `"%~dp0..\node_modules\symbio\bin\symbio.js`" %*`r`n"
      foreach ($n in @("sym.cmd", "symbio.cmd")) { [IO.File]::WriteAllText((Join-Path $BinDir $n), $cmd) }
      $paths = @(Get-UserPath)
      if ($env:SYMBIO_NO_PATH -ne "1" -and -not ($paths | Where-Object { $_.TrimEnd("\") -eq $BinDir })) {
        Set-UserPath ($paths + $BinDir)
        Say "Added $BinDir to your PATH: 'sym' works in new terminals"
      }
      if (-not (($env:Path -split ";") -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }
      $sym = Join-Path $BinDir "sym.cmd"

      if ($env:SYMBIO_NO_SHORTCUT -ne "1") {
        $icon = Join-Path $AppDir "node_modules\symbio\assets\symbio.ico"
        $shell = New-Object -ComObject WScript.Shell
        foreach ($lnk in Get-ShortcutPaths) {
          $s = $shell.CreateShortcut($lnk)
          $s.TargetPath = $sym
          $s.WorkingDirectory = $env:USERPROFILE
          $s.WindowStyle = 7 # minimized: `sym` opens Symbio in the browser and returns
          $s.Description = "Symbio: a team of AI agents on your computer"
          if (Test-Path $icon) { $s.IconLocation = $icon }
          $s.Save()
        }
        Say "Shortcuts: Symbio in the Start menu and on the desktop"
      }
    }
    Good "Symbio $version is installed"

    # ---- git: lets helpers work in parallel, each in its own copy
    Step "git"
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
      Say "git is installed"
    } elseif ($env:SYMBIO_NO_GIT -eq "1") {
      Warn "Skipped (SYMBIO_NO_GIT). Without git, helpers share the project folder instead of working in parallel."
    } else {
      Say "Installing git, so helpers can work in parallel in their own copies (Windows may ask for permission)"
      $done = $false
      if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        & winget.exe install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host
        Update-SessionPath
        $done = [bool](Get-Command git.exe -ErrorAction SilentlyContinue)
      }
      if (-not $done) {
        # Without winget: Git for Windows' own installer, from its latest release, silently.
        $rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "symbio-installer" }
        $want = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64\.exe$" } else { "64-bit\.exe$" }
        $asset = $rel.assets | Where-Object { $_.name -match "^Git-.*-$want" } | Select-Object -First 1
        if ($asset) {
          $exe = Join-Path ([IO.Path]::GetTempPath()) $asset.name
          Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing
          Start-Process $exe -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/SUPPRESSMSGBOXES" -Wait
          Remove-Item $exe -Force -ErrorAction SilentlyContinue
          Update-SessionPath
          $done = [bool](Get-Command git.exe -ErrorAction SilentlyContinue)
        }
      }
      if ($done) { Good "git is installed" }
      else { Warn "git couldn't be installed. Symbio works without it (helpers share the project folder); get it from https://git-scm.com/downloads later." }
      if ((Test-Path $BinDir) -and -not (($env:Path -split ";") -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }
    }

    # ---- done
    Write-Host ""
    Good "All set."
    Say "Start Symbio with 'sym' in a terminal, or from the Symbio shortcut."
    Say "On its first start, Symbio installs an agent runtime for you (OpenCode or GitHub Copilot CLI) from the Projects page."
    Say "Remove it later with:  `$env:SYMBIO_UNINSTALL='1'; irm https://symbio.linkzy.dev/install.ps1 | iex"
    $global:SymbioInstallOk = $true
    if ($env:SYMBIO_NO_START -ne "1") {
      Step "Starting Symbio"
      & $sym
    }
  } catch {
    Write-Host ""
    Write-Host "  Symbio couldn't be installed: $($_.Exception.Message)" -ForegroundColor Red
    Say "Running the line again picks up where it stopped. If it keeps failing, tell us: https://github.com/linkzy/symbio/issues"
  }
}
