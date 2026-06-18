#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude] [max_iterations]

set -e

# Parse arguments
TOOL="amp"  # Default to amp for backwards compatibility
MAX_ITERATIONS=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp' or 'claude'."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Single source of truth: the repo-root prd.json (no separate Ralph copy).
PRD_FILE="$REPO_ROOT/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")
  
  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"
    
    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"
    
    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"

for i in $(seq 1 $MAX_ITERATIONS); do
  # Graceful stop: by the time control returns to the top of the loop, the
  # previous iteration has fully finished and committed (passes flipped to true).
  # So if a stop flag was dropped (scripts/ralph/STOP — e.g. via stop-ralph.ps1
  # / stop-ralph.sh) exit cleanly BEFORE starting the next iteration. Unlike
  # kill-ralph (a force kill mid-iteration), this never interrupts in-progress
  # work. The flag is consumed so the next `npm run ralph` starts fresh.
  if [ -f "$SCRIPT_DIR/STOP" ]; then
    rm -f "$SCRIPT_DIR/STOP"
    echo ""
    echo "Graceful stop requested — completed $((i - 1)) of $MAX_ITERATIONS iteration(s)."
    echo "Current work is committed; not starting iteration $i. (Flag consumed.)"
    exit 0
  fi

  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  # --- Story selection (done HERE, not by the LLM) ------------------------
  # The agent used to read the entire prd.json (~300 KB / ~80K tokens) every
  # iteration just to pick the next story, then rewrite the whole file to flip
  # one boolean. We do both with jq instead: select the highest-priority
  # passes:false story and write ONLY that object to current-story.json (~1.5
  # KB), which the agent reads. The piped prompt (CLAUDE.md) stays byte-
  # identical across iterations, so its prefix hits the prompt cache.
  STORY_JSON=$(jq -c '[.userStories[] | select(.passes==false)] | sort_by(.priority) | reverse | .[0] // empty' "$PRD_FILE")
  if [ -z "$STORY_JSON" ]; then
    echo ""
    echo "All stories pass — nothing left to do."
    echo "<promise>COMPLETE</promise>"
    exit 0
  fi
  STORY_ID=$(echo "$STORY_JSON" | jq -r '.id')
  STORY_TITLE=$(echo "$STORY_JSON" | jq -r '.title')
  echo "$STORY_JSON" | jq '.' > "$SCRIPT_DIR/current-story.json"
  echo "  Selected story: $STORY_ID — $STORY_TITLE"

  # --- Model tiering (#6) -------------------------------------------------
  # Run the loop on a cheaper model by default and escalate to Opus only for
  # stories the author flagged hard. A story may set its own model two ways:
  #   "model": "opus"   -> exact model/alias passed to `claude --model`
  #   "hard": true      -> escalate to $HARD_MODEL
  # Otherwise use $DEFAULT_MODEL. RALPH_FORCE_MODEL overrides everything (handy
  # for a one-off all-Opus or all-Sonnet sweep). Aliases (sonnet/opus) are used
  # rather than pinned ids so this keeps working as model versions roll forward.
  DEFAULT_MODEL="${RALPH_DEFAULT_MODEL:-sonnet}"
  HARD_MODEL="${RALPH_HARD_MODEL:-opus}"
  STORY_MODEL=$(echo "$STORY_JSON" | jq -r --arg d "$DEFAULT_MODEL" --arg h "$HARD_MODEL" \
    'if (.model // "") != "" then .model elif (.hard == true) then $h else $d end')
  if [ -n "$RALPH_FORCE_MODEL" ]; then STORY_MODEL="$RALPH_FORCE_MODEL"; fi
  echo "  Model: $STORY_MODEL"

  # --- Relevant-paths hint (#5) -------------------------------------------
  # current-story.json already carries the full story object, so an optional
  # `relevantPaths` array (path globs) rides along to the agent automatically;
  # the prompt tells it to start there instead of sweeping the tree. Just log
  # whether a hint was present this iteration.
  HINT_COUNT=$(echo "$STORY_JSON" | jq -r '(.relevantPaths // []) | length')
  if [ "$HINT_COUNT" -gt 0 ]; then
    echo "  relevantPaths hint: $HINT_COUNT path(s)"
  fi

  # Per-iteration timeout (seconds). A single iteration that exceeds this is
  # treated as hung and killed so the LOOP survives instead of stalling forever.
  # The 2026-06-12 hang (prerender.mjs never exiting -> foreground `npm run build`
  # never returns -> `claude --print` never closes) would have stalled here with
  # no cap. Override with RALPH_ITER_TIMEOUT=<seconds>. Default 2400s (40 min).
  TIMEOUT_SECS="${RALPH_ITER_TIMEOUT:-2400}"
  TMP_OUT="$(mktemp)"

  # Run the selected tool with the ralph prompt. We use a real pipeline (not
  # command substitution) so PIPESTATUS reflects `timeout`'s exit code, and tee
  # both streams live output and captures it to $TMP_OUT for the COMPLETE check.
  set +e
  if [[ "$TOOL" == "amp" ]]; then
    timeout "${TIMEOUT_SECS}s" amp --dangerously-allow-all < "$SCRIPT_DIR/prompt.md" 2>&1 | tee "$TMP_OUT"
  else
    # Claude Code: --dangerously-skip-permissions for autonomous operation, --print
    # for output, --model for per-story tiering (#6: Sonnet default, Opus for hard).
    timeout "${TIMEOUT_SECS}s" claude --model "$STORY_MODEL" --dangerously-skip-permissions --print < "$SCRIPT_DIR/CLAUDE.md" 2>&1 | tee "$TMP_OUT"
  fi
  RC=${PIPESTATUS[0]}
  set -e
  OUTPUT="$(cat "$TMP_OUT")"
  rm -f "$TMP_OUT"

  if [ "$RC" -eq 124 ]; then
    echo ""
    echo "⚠️  Iteration $i exceeded ${TIMEOUT_SECS}s and was killed (likely a hung build). Sweeping and continuing."
  fi

  # Sweep any GradeThread build helpers this iteration left behind (prerender /
  # tsc / vite), so a process pileup can never starve the next iteration. Safe:
  # only matches node procs running THIS repo's build (see kill-stray-builds.ps1).
  if command -v cygpath >/dev/null 2>&1; then
    powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$SCRIPT_DIR/kill-stray-builds.ps1")" 2>/dev/null || true
  fi

  # --- Mark story complete (done HERE, not by the LLM) --------------------
  # The agent signals a verified+committed story with <promise>STORY_DONE</promise>
  # and no longer touches prd.json. The harness flips passes:true via jq,
  # records progress, and commits — so the agent never reads/rewrites the big
  # prd.json. A timed-out (RC=124) or failed iteration leaves passes:false, so
  # the same story is simply re-selected and retried next iteration.
  if [ "$RC" -eq 0 ] && echo "$OUTPUT" | grep -q "<promise>STORY_DONE</promise>"; then
    echo "  $STORY_ID verified by agent — marking passes:true."
    TMP_PRD="$(mktemp)"
    if jq --arg id "$STORY_ID" '(.userStories[] | select(.id==$id) | .passes) |= true' "$PRD_FILE" > "$TMP_PRD"; then
      mv "$TMP_PRD" "$PRD_FILE"
    else
      rm -f "$TMP_PRD"
      echo "  ⚠️  Failed to update prd.json for $STORY_ID; leaving passes:false for retry."
    fi
    {
      echo "## $STORY_ID: $STORY_TITLE"
      echo "- Status: COMPLETE"
      echo "- Timestamp: $(date)"
      echo "---"
    } >> "$PROGRESS_FILE"
    git -C "$REPO_ROOT" add "$PRD_FILE" "$PROGRESS_FILE" >/dev/null 2>&1 || true
    git -C "$REPO_ROOT" commit -m "chore($STORY_ID): mark story complete" >/dev/null 2>&1 || true

    # All done?
    REMAINING=$(jq '[.userStories[] | select(.passes==false)] | length' "$PRD_FILE" 2>/dev/null || echo "1")
    if [ "$REMAINING" -eq 0 ]; then
      echo ""
      echo "Ralph completed all tasks!"
      echo "Completed at iteration $i of $MAX_ITERATIONS"
      echo "<promise>COMPLETE</promise>"
      exit 0
    fi
  else
    echo "  $STORY_ID not marked done this iteration (rc=$RC) — will retry."
  fi

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
