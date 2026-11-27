#!/bin/sh
# Symbio's platform smoke test, run as a plain user on a clean Linux or macOS machine (a throwaway
# WSL distro from linux-wsl.ps1, a VM, a CI runner). It installs Symbio the way a new user does,
# starts it with no screen, and checks what a fresh machine tends to break: the PATH edit, the
# private Node.js, the vault (OS credential store), the runtime downloads, update in place,
# uninstall. See docs/platform-testing.md.
#
# Every check prints one line (PASS, FAIL or INFO); the exit code is the number of FAILs.
#
#   smoke.sh          install, start, the checks, uninstall
#   smoke.sh again    later, from a new login (after a reboot): Symbio starts again and still reads
#                     the secret saved before, then uninstall. Run the first part with SMOKE_KEEP=1.
#
#   SMOKE_INSTALLER   the installer: a file (default: ../install/install.sh from this script) or
#                     an https:// address (fetched with curl, as users do)
#   SMOKE_RUNTIMES    runtimes to install through Symbio (default "opencode copilot"; "" for none)
#   SMOKE_KEEP        1: leave Symbio installed at the end (to look around)
#   SYMBIO_VERSION    passed to the installer (default: the latest release)
#
# The installed copy never asks the update endpoint (it would be counted as a user), and it uses its
# own port so it can't meet a Symbio running elsewhere on the machine.

export SYMBIO_UPDATE_URL=off
export SYMBIO_NO_OPEN=1
export SYMBIO_PORT="${SYMBIO_PORT:-4399}"
HOME_DIR="${SYMBIO_HOME:-$HOME/.symbio}"
BASE="http://127.0.0.1:$SYMBIO_PORT/api"
HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="${SMOKE_INSTALLER:-$HERE/../install/install.sh}"
RUNTIMES="${SMOKE_RUNTIMES-opencode copilot}"
NODE="$HOME_DIR/node/bin/node"
SYM="$HOME_DIR/app/launcher/sym"
LOGS=$(mktemp -d)
FAILS=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+: $2}"; FAILS=$((FAILS + 1)); }
info() { echo "INFO $1"; }
last() { tail -n "${2:-5}" "$1" 2> /dev/null | tr '\n' ' '; }

run_installer() {
  case "$INSTALLER" in
    http://* | https://*) curl -fsSL "$INSTALLER" | sh ;;
    *) sh < "$INSTALLER" ;;
  esac
}

# Reads JSON with the private Node.js (the machine may have no other): json 'expression of v'.
json() { "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let v;try{v=JSON.parse(s)}catch{v=null};console.log(String($1))})"; }
# api METHOD PATH [BODY]: sets STATUS and BODY (not in a subshell, so both survive).
api() {
  STATUS=$(curl -s -o "$LOGS/body" -w '%{http_code}' -X "$1" -H "x-symbio-token: $TOKEN" -H 'content-type: application/json' ${3:+--data "$3"} "$BASE$2")
  BODY=$(cat "$LOGS/body")
}

# Uninstalls (unless SMOKE_KEEP=1) and ends with the result line.
finish() {
  if [ "$SMOKE_KEEP" != 1 ]; then
    if SYMBIO_UNINSTALL=1 run_installer > "$LOGS/uninstall" 2>&1 && [ ! -e "$HOME_DIR/app" ] && [ ! -e "$HOME_DIR/node" ]; then
      pass "uninstall"
    else
      fail "uninstall" "$(last "$LOGS/uninstall")"
    fi
    if grep -qs "Symbio (added by its installer)" "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile"; then
      fail "uninstall cleans the profile"
    else
      pass "uninstall cleans the profile"
    fi
  fi
  rm -rf "$LOGS"
  echo "RESULT $FAILS failed"
  exit "$FAILS"
}
start() {
  "$SYM" > "$LOGS/start" 2>&1
  sleep 4
  TOKEN=$(cat "$HOME_DIR/ui-token" 2> /dev/null)
}
stop() {
  "$SYM" stop > /dev/null 2>&1
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/runtime")
  [ "$code" = 000 ] && pass "sym stop" || fail "sym stop" "still answering (HTTP $code)"
  grep -iE "error|warn" "$HOME_DIR/logs/symbio.log" 2> /dev/null | grep -v "^ *at " | tail -n 10 | while IFS= read -r line; do info "log: $line"; done
}

if [ "$1" = again ]; then
  # The vault key must outlive the login it was made in: a key kept only for the session (Linux's
  # kernel session keyring, with no Secret Service) leaves every saved secret unreadable.
  [ -x "$SYM" ] || { info "Symbio isn't installed (the first part stopped): nothing to check again"; finish; }
  start
  api GET /notifications
  if [ "$STATUS" = 200 ] && [ "$(echo "$BODY" | json 'v.secrets["webhook.url"]')" = true ]; then
    pass "vault after a restart (the secret is still readable)"
  else
    fail "vault after a restart" "HTTP $STATUS $BODY"
  fi
  stop
  finish
fi

info "system: $(uname -srm); $( (. /etc/os-release 2> /dev/null && echo "$PRETTY_NAME") || echo "macOS $(sw_vers -productVersion 2> /dev/null)")"
info "user: $(id -un); shell: ${SHELL:-?}; installer: $INSTALLER"
for tool in curl tar git node npm; do
  if command -v "$tool" > /dev/null 2>&1; then info "$tool: $(command -v "$tool")"; else info "$tool: not installed"; fi
done

# 1. Install, as `curl … | sh`.
if SYMBIO_NO_START=1 run_installer > "$LOGS/install" 2>&1; then pass "installer"; else fail "installer" "$(last "$LOGS/install")"; fi
node_version=$("$NODE" --version 2>&1) && pass "private Node.js ($node_version)" || fail "private Node.js" "$node_version"
[ -x "$SYM" ] && pass "launcher" || fail "launcher" "$SYM is missing"
# Nothing after this can work without them.
[ "$FAILS" -gt 0 ] && { info "stopped: Symbio isn't installed"; finish; }

# 2. A new terminal finds `sym` (the PATH line the installer added to the profile).
# zsh only where it's the user's shell (the Mac's): it doesn't read ~/.profile.
shells="sh bash"
if [ "$(uname -s)" = Darwin ]; then shells="$shells zsh"; else case "${SHELL:-}" in */zsh) shells="$shells zsh" ;; esac; fi
for shell in $shells; do
  command -v "$shell" > /dev/null 2>&1 || continue
  # The last line: a profile may print something first.
  found=$("$shell" -lc 'command -v sym' 2> /dev/null | tail -n 1)
  [ "$found" = "$SYM" ] && pass "sym on the PATH of a new $shell" || fail "sym on the PATH of a new $shell" "found: ${found:-nothing}"
done
version=$("$SYM" --version 2>&1) && pass "sym --version ($version)" || fail "sym --version" "$version"

# 3. Start with no screen; the API answers, and only with the UI key.
start
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/runtime")
[ "$code" = 401 ] && pass "Symbio answers, locked without the key" || fail "Symbio answers" "HTTP $code; $(last "$LOGS/start")"
api GET /runtime
[ "$STATUS" = 200 ] && pass "API with the key" || fail "API with the key" "HTTP $STATUS $BODY"
api GET /setup
[ "$STATUS" = 200 ] && info "setup: $BODY" || fail "GET /setup" "HTTP $STATUS $BODY"

# 4. The vault: saving a secret needs the OS credential store (Secret Service on Linux, the Keychain
# on macOS). A headless Linux usually has none: this is where it shows.
api PUT /notifications '{"webhook":{"url":"https://example.com/symbio-smoke"}}'
if [ "$STATUS" = 200 ] && [ "$(echo "$BODY" | json 'v.secrets["webhook.url"]')" = true ]; then pass "vault (a secret saved)"; else fail "vault (a secret saved)" "HTTP $STATUS $BODY"; fi

# 5. Runtimes downloaded by Symbio.
for kind in $RUNTIMES; do
  api POST "/runtimes/$kind/install"
  [ "$STATUS" = 202 ] || { fail "install $kind" "HTTP $STATUS $BODY"; continue; }
  waited=0
  while :; do
    api GET /runtimes
    view=$(echo "$BODY" | json "JSON.stringify(v.find(r=>r.kind==='$kind'))")
    [ "$(echo "$view" | json 'v.installing')" = true ] || break
    [ "$waited" -ge 600 ] && break
    sleep 5
    waited=$((waited + 5))
  done
  if [ "$(echo "$view" | json 'v.installed')" = true ]; then
    pass "install $kind ($(echo "$view" | json 'v.installedVersion'), ${waited}s)"
  else
    fail "install $kind" "$(echo "$view" | json 'v.installError || (v.installLog||[]).slice(-3).join(" | ")')"
  fi
done
api GET /runtimes
info "runtimes: $(echo "$BODY" | json "v.map(r=>r.kind+'='+r.state+(r.error?' ('+r.error+')':'')).join(', ')")"

stop

# 6. Running the installer again updates in place; then uninstall.
SYMBIO_NO_START=1 run_installer > "$LOGS/install2" 2>&1 && pass "installer again (in place)" || fail "installer again" "$(last "$LOGS/install2")"
finish
