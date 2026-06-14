# Request a GRACEFUL stop of the Ralph loop.
#
# Drops a STOP flag that ralph.sh checks at the top of each iteration. Ralph
# finishes the iteration it's currently on (implements the story, verifies,
# commits, flips passes -> true), then exits cleanly BEFORE starting the next
# one. The flag is consumed on exit, so the next `npm run ralph` starts fresh.
#
# Contrast with kill-ralph.ps1, which force-kills mid-iteration and can leave
# uncommitted/partial work. Use THIS when you want a clean stop and don't mind
# waiting for the current iteration to land.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\ralph\stop-ralph.ps1
$ErrorActionPreference = 'Stop'
$flag = Join-Path $PSScriptRoot 'STOP'
if (-not (Test-Path $flag)) { New-Item -ItemType File -Path $flag | Out-Null }
Write-Host "Graceful stop requested."
Write-Host "Ralph will finish the CURRENT iteration (commit included), then exit before the next."
Write-Host "Flag: $flag"
Write-Host "Cancel before it triggers:  Remove-Item '$flag'"
Write-Host "Need to stop NOW (force):    powershell -ExecutionPolicy Bypass -File scripts\ralph\kill-ralph.ps1"
