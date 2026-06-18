#!/bin/bash
# rescue-ralph.sh — recover from a STALLED Ralph iteration in one step.
#
# Force-kills the loop (delegates to kill-ralph.sh) and then STASHES whatever
# uncommitted work the dead iteration left behind, so the working tree is clean
# and the next `npm run ralph` retries the SAME story from scratch.
#
# Why this is safe to run on a stall: story selection is stateless — ralph.sh
# always re-picks the highest-priority `passes:false` story, and a killed
# iteration never flips `passes:true`. So the in-flight story is simply
# re-selected on restart; you don't lose your place.
#
# Contrast:
#   stop-ralph.sh   — GRACEFUL: waits for the current iteration to finish. Wrong
#                     tool for a hang (it won't free a stuck iteration now).
#   kill-ralph.sh   — force-kills but LEAVES partial work in the tree.
#   rescue-ralph.sh (this) — kill-ralph + stash the partial work = clean retry.
#
# Recover the stashed work later with:  git stash pop   (or `git stash drop` to
# discard once the agent has redone the story).
#
# Works in Git Bash on Windows and on Linux/macOS.
# Run:  bash scripts/ralph/rescue-ralph.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 1) Force-kill the loop + agent + build children (reuse the existing script).
bash "$SCRIPT_DIR/kill-ralph.sh"

# Give the OS a moment to tear the processes down so no straggler is still
# writing files while we stash.
sleep 1

# 2) Stash the partial work, if any.
if [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "rescue-ralph: working tree already clean — nothing to stash."
  echo "Restart with:  npm run ralph -- 50"
  exit 0
fi

# Best-effort: label the stash with the story the dead iteration was on.
STORY="unknown-story"
if [ -f "$SCRIPT_DIR/current-story.json" ]; then
  STORY=$(jq -r '.id // "unknown-story"' "$SCRIPT_DIR/current-story.json" 2>/dev/null || echo "unknown-story")
fi
STAMP=$(date '+%Y-%m-%d %H:%M')
MSG="rescue-ralph: $STORY partial work ($STAMP)"

git -C "$REPO_ROOT" stash push -u -m "$MSG" >/dev/null
echo ""
echo "rescue-ralph: stashed partial work -> stash@{0}"
echo "  message: $MSG"
echo ""
echo "Working tree is clean. Next steps:"
echo "  Restart loop:        npm run ralph -- 50      (re-selects $STORY)"
echo "  Recover the work:     git stash pop           (do this BEFORE restarting, or you'll conflict)"
echo "  Inspect first:        git stash show -p stash@{0}"
echo "  Discard for good:     git stash drop stash@{0}"
