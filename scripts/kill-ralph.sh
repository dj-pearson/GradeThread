#!/bin/bash
# kill-ralph.sh — stop every Ralph loop (and its build children) on this host.
#
# MOVABLE: path-agnostic. Drop a copy into any repo (or run from anywhere) and it
# kills ALL Ralph loops on the machine, matched by process command-line signature
# (the harness run.mjs/ralph.sh, the claude --print agent it drives, and the
# prerender/build-lock build children).
#
# Works in Git Bash on Windows (delegates to PowerShell/CIM, because these are
# Windows processes not children of bash) AND on Linux/macOS (pkill on the real
# tree). Never touches your interactive Claude session (no --print) or VS Code,
# and never kills itself.
#
# Run:  bash scripts/kill-ralph.sh
set -u

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command - <<'PS'
$ErrorActionPreference = 'SilentlyContinue'
$rules = @(
  @{ Name='node.exe';   Rx='ralph[\\/]run\.mjs';         Label='ralph runner (run.mjs)' },
  @{ Name='bash.exe';   Rx='ralph[\\/]ralph\.sh';        Label='ralph loop (ralph.sh)' },
  @{ Name='node.exe';   Rx='ralph[\\/]ralph\.sh';        Label='ralph loop (node)' },
  @{ Name='node.exe';   Rx='scripts[\\/]prerender\.mjs'; Label='prerender (build child)' },
  @{ Name='node.exe';   Rx='build-lock\.mjs';            Label='build-lock' },
  @{ Name='claude.exe'; Rx='--print';                    Label='ralph agent (claude --print)' }
)
$killed = 0
foreach ($r in $rules) {
  Get-CimInstance Win32_Process -Filter "Name='$($r.Name)'" |
    Where-Object { $_.CommandLine -match $r.Rx } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Write-Host ("  killed [{0}] pid {1}" -f $r.Label, $_.ProcessId)
        $script:killed++
      } catch {}
    }
}
if ($killed -eq 0) { Write-Host 'kill-ralph: no Ralph processes found.' }
else { Write-Host ("kill-ralph: terminated {0} process(es)." -f $killed) }
PS
    ;;
  *)
    # Linux/macOS: match the full command line; exclude this script's own pid.
    self=$$
    patterns=( 'ralph/run\.mjs' 'ralph/ralph\.sh' 'scripts/prerender\.mjs' 'build-lock\.mjs' 'claude .*--print' )
    killed=0
    for pat in "${patterns[@]}"; do
      for pid in $(pgrep -f "$pat" 2>/dev/null); do
        [ "$pid" = "$self" ] && continue
        if kill "$pid" 2>/dev/null; then
          echo "  killed (pat: $pat) pid $pid"
          killed=$((killed+1))
        fi
      done
    done
    if [ "$killed" -eq 0 ]; then echo 'kill-ralph: no Ralph processes found.'
    else echo "kill-ralph: terminated $killed process(es)."; fi
    ;;
esac
