#!/bin/bash
# Request a GRACEFUL stop of the Ralph loop (Git Bash / Linux / macOS).
#
# Drops a STOP flag that ralph.sh checks at the top of each iteration. Ralph
# finishes the iteration it's currently on (implements, verifies, commits, flips
# passes -> true), then exits cleanly BEFORE starting the next one. The flag is
# consumed on exit, so the next `npm run ralph` starts fresh.
#
# Contrast with kill-ralph.sh, which force-kills mid-iteration. Use THIS for a
# clean stop when you don't mind waiting for the current iteration to land.
#
# Run:  bash scripts/ralph/stop-ralph.sh
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
flag="$dir/STOP"
touch "$flag"
echo "Graceful stop requested."
echo "Ralph will finish the CURRENT iteration (commit included), then exit before the next."
echo "Flag: $flag"
echo "Cancel before it triggers:  rm '$flag'"
echo "Need to stop NOW (force):    bash scripts/ralph/kill-ralph.sh"
