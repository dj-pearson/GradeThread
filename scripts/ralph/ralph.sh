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
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

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
    # Claude Code: --dangerously-skip-permissions for autonomous operation, --print for output
    timeout "${TIMEOUT_SECS}s" claude --dangerously-skip-permissions --print < "$SCRIPT_DIR/CLAUDE.md" 2>&1 | tee "$TMP_OUT"
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

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi
  
  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
