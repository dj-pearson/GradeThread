# Best-effort sweep of GradeThread build helpers that linger between Ralph
# iterations. Called by ralph.sh after each iteration so a process pileup can
# never starve the next build (the failure mode that hung the loop on 2026-06-12:
# scripts/prerender.mjs not exiting, plus timeout-orphaned tsc/vite children).
#
# SAFE BY CONSTRUCTION: only targets node.exe whose command line runs THIS repo's
# prerender script or a build under this repo path. It never touches other
# projects (e.g. EatPal's claude-flow) or VS Code's language servers.
$ErrorActionPreference = 'SilentlyContinue'

# Repo root = two levels up from this script (scripts/ralph/ -> repo).
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repoEsc = [regex]::Escape($repo)

$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  # Lingering prerender (the known non-exiter, fixed but belt-and-suspenders),
  # or any tsc/vite build still running out of THIS repo after the iteration ended.
  if ($cl -match 'prerender\.mjs' -or ($cl -match $repoEsc -and $cl -match 'tsc|vite|esbuild')) {
    try { Stop-Process -Id $_.ProcessId -Force; $script:killed++ } catch {}
  }
}
if ($killed -gt 0) { Write-Output "[ralph] swept $killed stray build process(es)." }
