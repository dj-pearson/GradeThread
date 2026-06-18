# rescue-ralph.ps1 -- recover from a STALLED Ralph iteration in one step.
#
# Force-kills the loop (delegates to kill-ralph.ps1) and then STASHES whatever
# uncommitted work the dead iteration left behind, so the working tree is clean
# and the next `npm run ralph` retries the SAME story from scratch.
#
# Why this is safe to run on a stall: story selection is stateless -- ralph.sh
# always re-picks the highest-priority `passes:false` story, and a killed
# iteration never flips `passes:true`. So the in-flight story is simply
# re-selected on restart; you don't lose your place.
#
# Contrast:
#   stop-ralph.ps1  -- GRACEFUL: waits for the current iteration to finish. Wrong
#                     tool for a hang (it won't free a stuck iteration now).
#   kill-ralph.ps1  -- force-kills but LEAVES partial work in the tree.
#   rescue-ralph.ps1 (this) -- kill-ralph + stash the partial work = clean retry.
#
# Recover the stashed work later with:  git stash pop   (or `git stash drop` to
# discard once the agent has redone the story).
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\ralph\rescue-ralph.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# 1) Force-kill the loop + agent + build children (reuse the existing script).
& (Join-Path $PSScriptRoot 'kill-ralph.ps1')

# Give the OS a moment to tear the processes down so no straggler is still
# writing files while we stash.
Start-Sleep -Seconds 1

# 2) Stash the partial work, if any.
$dirty = git -C $repoRoot status --porcelain
if ([string]::IsNullOrWhiteSpace($dirty)) {
  Write-Host "rescue-ralph: working tree already clean -- nothing to stash."
  Write-Host "Restart with:  npm run ralph -- 50"
  return
}

# Best-effort: label the stash with the story the dead iteration was on.
$story = 'unknown-story'
$storyFile = Join-Path $PSScriptRoot 'current-story.json'
if (Test-Path $storyFile) {
  try { $story = (Get-Content $storyFile -Raw | ConvertFrom-Json).id } catch {}
}
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$msg = "rescue-ralph: $story partial work ($stamp)"

git -C $repoRoot stash push -u -m $msg | Out-Null
Write-Host ""
Write-Host "rescue-ralph: stashed partial work -> stash@{0}"
Write-Host "  message: $msg"
Write-Host ""
Write-Host "Working tree is clean. Next steps:"
Write-Host "  Restart loop:        npm run ralph -- 50      (re-selects $story)"
Write-Host "  Recover the work:     git stash pop           (do this BEFORE restarting, or you'll conflict)"
Write-Host "  Inspect first:        git stash show -p stash@{0}"
Write-Host "  Discard for good:     git stash drop stash@{0}"
