#!/bin/sh
# Symbio's one-line installer for macOS and Linux:
#
#   curl -fsSL https://symbio.linkzy.dev/install | sh
#
# Installs Symbio without needing Node.js first: a private copy of Node.js (the official archive
# from nodejs.org, checked against its SHASUMS256) in ~/.symbio/node, Symbio from npm in
# ~/.symbio/app, and the `sym` command on your PATH. No sudo, nothing system-wide. Running it
# again updates or repairs the install. Symbio still updates itself from npm.
#
# Options, as environment variables (e.g. `curl -fsSL … | SYMBIO_NO_START=1 sh`):
#   SYMBIO_UNINSTALL=1       remove what this installed (your projects and Symbio's data stay)
#   SYMBIO_VERSION=0.36.0    install that version instead of the latest
#   SYMBIO_NO_START=1        don't start Symbio at the end
#   SYMBIO_NO_PATH=1         don't add `sym` to your PATH (run it from ~/.symbio/app/launcher)
#
# Everything is inside main(), called on the last line: a download cut short runs nothing.

set -eu

main() {
  SYMBIO_HOME_DIR="${SYMBIO_HOME:-$HOME/.symbio}"
  NODE_DIR="$SYMBIO_HOME_DIR/node"
  APP_DIR="$SYMBIO_HOME_DIR/app"
  BIN_DIR="$APP_DIR/launcher"
  REGISTRY="${SYMBIO_INSTALL_REGISTRY:-https://registry.npmjs.org}"
  REGISTRY="${REGISTRY%/}"
  MARK="# Symbio (added by its installer)"

  if [ "${SYMBIO_UNINSTALL:-}" = "1" ]; then
    step "Removing Symbio"
    stop_own
    rm -rf "$APP_DIR" "$NODE_DIR"
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile"; do
      if [ -f "$rc" ] && grep -qF "$MARK" "$rc"; then
        # grep finds no other line when ours was the file's only one: that's not an error here.
        { grep -vF "$MARK" "$rc" || true; } > "$rc.symbio-tmp"
        cat "$rc.symbio-tmp" > "$rc"
        rm -f "$rc.symbio-tmp"
        say "Removed sym from your PATH in $rc"
      fi
    done
    good "Symbio is removed. Your projects weren't touched."
    say "Symbio's own data (settings, history, backups) is still in $SYMBIO_HOME_DIR; delete that folder to remove it too."
    return 0
  fi

  printf '\n\033[36mSymbio installer\033[0m\n'
  say "A team of AI agents on your computer. This takes a few minutes."
  need curl
  need tar

  step "Checking the latest Symbio"
  meta="$(curl -fsSL "$REGISTRY/symbio/${SYMBIO_VERSION:-latest}")" || fail "Couldn't reach npm to find Symbio."
  version="$(printf '%s' "$meta" | grep -o '"version":"[^"]*"' | head -n 1 | cut -d '"' -f 4)"
  [ -n "$version" ] || fail "npm has no Symbio ${SYMBIO_VERSION:-latest}."
  min_node="$(printf '%s' "$meta" | grep -o '"engines":{[^}]*}' | grep -o '[0-9][0-9]*' | head -n 1)"
  min_node="${min_node:-22}"
  say "Symbio $version (needs Node.js $min_node or newer)"

  # ---- a private Node.js
  step "Node.js"
  if [ "$(node_major "$NODE_DIR/bin/node")" -ge "$min_node" ]; then
    say "Symbio's Node.js $("$NODE_DIR/bin/node" --version) is in place"
  else
    case "$(uname -s)" in
      Linux) os=linux ;;
      Darwin) os=darwin ;;
      *) fail "This installer is for macOS and Linux; on Windows, use: irm https://symbio.linkzy.dev/install.ps1 | iex" ;;
    esac
    case "$(uname -m)" in
      x86_64 | amd64) arch=x64 ;;
      arm64 | aarch64) arch=arm64 ;;
      *) fail "There's no Node.js build for this processor ($(uname -m))." ;;
    esac
    # index.tab: version, date, files, npm, v8, uv, zlib, openssl, modules, lts, security. Newest first.
    files="$( [ "$os" = darwin ] && echo "osx-$arch-tar" || echo "linux-$arch" )"
    tab="$(curl -fsSL https://nodejs.org/dist/index.tab)" || fail "Couldn't reach nodejs.org."
    v="$(printf '%s\n' "$tab" | awk -F '\t' -v min="$min_node" -v want="$files" '
      NR > 1 && $10 != "-" && !found { major = substr($1, 2) + 0; if (major >= min && index("," $3 ",", "," want ",")) { print $1; found = 1 } }')"
    [ -n "$v" ] || fail "No Node.js $min_node+ build for $os-$arch was found on nodejs.org."
    name="node-$v-$os-$arch"
    say "Downloading Node.js $v (a private copy for Symbio, about 50 MB)"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "https://nodejs.org/dist/$v/$name.tar.gz" -o "$tmp/$name.tar.gz"
    expected="$(curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')"
    [ -n "$expected" ] || fail "Node.js's checksum list has no entry for $name.tar.gz."
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$name.tar.gz" | cut -d ' ' -f 1)"
    else actual="$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d ' ' -f 1)"; fi
    [ "$actual" = "$expected" ] || fail "The Node.js download doesn't match its published checksum; nothing was installed. Try again."
    say "Checked against nodejs.org's SHA-256 checksums"
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
    # nodejs.org's Linux builds need a few system libraries that minimal systems (a fresh WSL
    # Ubuntu, slim containers) leave out: say which, rather than failing later inside npm.
    if ! err="$("$tmp/$name/bin/node" --version 2>&1)"; then
      lib="$(printf '%s' "$err" | sed -n 's/.*shared libraries: \([^:]*\):.*/\1/p')"
      case "$lib" in
        libatomic.so.1) hint="sudo apt install libatomic1 (Fedora, RHEL: sudo dnf install libatomic)" ;;
        "") hint="" ;;
        *) hint="the package that provides $lib" ;;
      esac
      fail "Node.js $v doesn't run on this system ($err).${hint:+ Install what it needs, then run the line again: $hint}"
    fi
    stop_own
    mkdir -p "$SYMBIO_HOME_DIR"
    rm -rf "$NODE_DIR"
    mv "$tmp/$name" "$NODE_DIR"
    good "Node.js $v is ready in $NODE_DIR"
  fi

  # ---- Symbio, with that Node.js's npm, in its own folder
  step "Installing Symbio $version"
  stop_own
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install -g "symbio@$version" --prefix "$APP_DIR" \
    --no-fund --no-audit --no-update-notifier --loglevel=error --registry "$REGISTRY/" || fail "npm couldn't install Symbio $version (see above)."

  # `sym` runs Symbio with the private Node.js, which stays off the PATH. (npm's own links in
  # app/bin expect a `node` on the PATH; these don't.)
  mkdir -p "$BIN_DIR"
  for cmd in sym symbio; do
    {
      echo '#!/bin/sh'
      [ -n "${SYMBIO_HOME:-}" ] && echo "export SYMBIO_HOME=\"$SYMBIO_HOME\""
      echo "exec \"$NODE_DIR/bin/node\" \"$APP_DIR/lib/node_modules/symbio/bin/symbio.js\" \"\$@\""
    } > "$BIN_DIR/$cmd"
    chmod +x "$BIN_DIR/$cmd"
  done
  if [ "${SYMBIO_NO_PATH:-}" != "1" ]; then
    # Once on the PATH even when one profile reads another (~/.bash_profile sourcing ~/.bashrc).
    line="case \":\$PATH:\" in *\":$BIN_DIR:\"*) ;; *) export PATH=\"\$PATH:$BIN_DIR\" ;; esac $MARK"
    # zsh (the Mac's shell) doesn't read ~/.profile, and a new Mac has no zsh files yet.
    zsh_too=""
    if [ "$(uname -s)" = Darwin ]; then zsh_too=yes; else case "${SHELL:-}" in */zsh) zsh_too=yes ;; esac; fi
    added=""
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile"; do
      # The shells' own files when they exist (bash reads ~/.bash_profile instead of ~/.profile
      # when there is one); ~/.profile always, and ~/.zprofile for zsh users.
      if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || { [ "$rc" = "$HOME/.zprofile" ] && [ -n "$zsh_too" ]; }; then
        if ! grep -qF "$MARK" "$rc" 2>/dev/null; then
          # A profile that can't be written (owned by root) isn't worth failing the install for.
          if { echo "$line" >> "$rc"; } 2>/dev/null; then added="yes"; else warn "Couldn't add $BIN_DIR to the PATH in $rc (not writable)"; fi
        fi
      fi
    done
    [ -n "$added" ] && say "Added $BIN_DIR to your PATH: 'sym' works in new terminals"
  fi
  good "Symbio $version is installed"

  # ---- git: lets helpers work in parallel, each in its own copy
  step "git"
  if command -v git >/dev/null 2>&1; then
    say "git is installed"
  else
    warn "git isn't installed. Symbio works without it, but helpers then share the project folder instead of working in parallel."
    if [ "$(uname -s)" = Darwin ]; then say "Install it with: xcode-select --install"
    else say "Install it with your package manager, e.g.: sudo apt install git"; fi
  fi

  printf '\n'
  good "All set."
  say "Start Symbio with 'sym' in a new terminal (or now: $BIN_DIR/sym)."
  say "On its first start, Symbio installs an agent runtime for you (OpenCode or GitHub Copilot CLI) from the Projects page."
  say "Remove it later with:  curl -fsSL https://symbio.linkzy.dev/install | SYMBIO_UNINSTALL=1 sh"
  if [ "${SYMBIO_NO_START:-}" != "1" ]; then
    step "Starting Symbio"
    "$BIN_DIR/sym"
  fi
}

say() { printf '  %s\n' "$1"; }
step() { printf '\n\033[36m> %s\033[0m\n' "$1"; }
good() { printf '  \033[32m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }
fail() { printf '\n  \033[31mSymbio couldn'"'"'t be installed: %s\033[0m\n' "$1" >&2; say "Running the line again picks up where it stopped. If it keeps failing, tell us: https://github.com/linkzy/symbio/issues"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "This needs '$1', which isn't installed."; }
node_major() {
  m=""
  [ -x "$1" ] && m="$("$1" --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')"
  echo "${m:-0}"
}
# Stops the Symbio this installer put here, if it runs.
stop_own() { if [ -x "$BIN_DIR/sym" ]; then "$BIN_DIR/sym" stop >/dev/null 2>&1 || true; fi; }

main "$@"
