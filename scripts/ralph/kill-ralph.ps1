# kill-ralph.ps1 — stop every Ralph loop (and its build children) on this host.
#
# MOVABLE: this file is path-agnostic. Drop a copy into any repo (or run it from
# anywhere) and it kills ALL Ralph loops on the machine, not just one repo's —
# it matches process COMMAND-LINE signatures, not absolute paths.
#
# SAFE: it never touches your interactive Claude Code session (that runs without
# --print and without stream-json IO), VS Code's node language servers, or
# unrelated builds. It targets the Ralph harness (run-sdk.mjs / run.mjs /
# ralph.sh), the autonomous agent it drives (the SDK's stream-json child, or
# `claude --print` on the legacy path), and the build steps Ralph spawns
# (prerender / build-lock).
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\ralph\kill-ralph.ps1

$ErrorActionPreference = 'SilentlyContinue'

# Each rule: process image name + a regex that must match its command line.
$rules = @(
  # `run-sdk` must be matched explicitly: 'ralph[\\/]run\.mjs' requires a literal
  # dot straight after "run", so it does NOT match run-sdk.mjs. Before this rule
  # existed, kill-ralph silently no-op'd against the default (SDK) runner.
  @{ Name = 'node.exe';   Rx = 'ralph[\\/]run-sdk\.mjs';    Label = 'ralph runner (run-sdk.mjs)' },
  @{ Name = 'node.exe';   Rx = 'ralph[\\/]run\.mjs';        Label = 'ralph runner (run.mjs)' },
  @{ Name = 'bash.exe';   Rx = 'ralph[\\/]ralph\.sh';                 Label = 'ralph loop (ralph.sh)' },
  @{ Name = 'node.exe';   Rx = 'ralph[\\/]ralph\.sh';                 Label = 'ralph loop (node)' },
  @{ Name = 'node.exe';   Rx = 'scripts[\\/]prerender\.mjs';Label = 'prerender (build child)' },
  @{ Name = 'node.exe';   Rx = 'build-lock\.mjs';           Label = 'build-lock' },
  @{ Name = 'claude.exe'; Rx = '--print';                   Label = 'ralph agent (claude --print)' },
  # The Agent SDK drives its child over stream-json stdio; an interactive Claude
  # Code session never uses that IO mode, so this cannot hit your own session.
  @{ Name = 'claude.exe'; Rx = '--input-format[= ]stream-json'; Label = 'ralph agent (SDK child)' },
  @{ Name = 'node.exe';   Rx = '--input-format[= ]stream-json'; Label = 'ralph agent (SDK child, node)' }
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

if ($killed -eq 0) {
  Write-Host 'kill-ralph: no Ralph processes found.'
} else {
  Write-Host ("kill-ralph: terminated {0} process(es)." -f $killed)
}
