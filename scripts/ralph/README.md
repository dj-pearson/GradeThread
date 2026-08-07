# Ralph — start / stop / kill

Ralph is the autonomous loop that implements `prd.json` user stories one per
iteration. This folder holds everything you need to run and control it. Commands
below are run from the **repo root**.

> **`npm run ralph` now runs `run-sdk.mjs` — the Claude Agent SDK runner.** The
> old shell path (`run.mjs` → `ralph.sh` → `claude --print`) is still there as
> `npm run ralph:sh`. See [Which runner?](#which-runner) — behavior is the same,
> observability and safety are not.

## TL;DR

| I want to… | Command |
|---|---|
| **Start** (simple) | `npm run ralph -- 200` |
| **Start** (boxed: own CPU cores + below-normal priority) | `scripts\ralph\start-loop.bat 200` |
| **Stop gracefully** (finish current story, then exit) | `powershell -ExecutionPolicy Bypass -File scripts\ralph\stop-ralph.ps1` |
| **Stop NOW** (force, mid-iteration) | `powershell -ExecutionPolicy Bypass -File scripts\ralph\kill-ralph.ps1` |
| **Rescue a STALLED iteration** (force-kill + stash partial work) | `powershell -ExecutionPolicy Bypass -File scripts\ralph\rescue-ralph.ps1` |
| **Cancel a pending graceful stop** | `Remove-Item scripts\ralph\STOP` |

Git Bash equivalents: `bash scripts/ralph/stop-ralph.sh`, `bash scripts/ralph/kill-ralph.sh`, `bash scripts/ralph/rescue-ralph.sh`.

### Stalled / hung iteration?

Use **`rescue-ralph`**. It force-kills the loop (via `kill-ralph`) **and** stashes
whatever uncommitted work the dead iteration left behind, leaving a clean tree.
Because story selection is stateless — `ralph.sh` always re-picks the
highest-priority `passes:false` story, and a killed iteration never flips
`passes:true` — the next `npm run ralph` simply **retries the same story**. You
don't need to bump priority or edit the story to "keep your place."

The partial work is in `git stash` (labeled with the story id + timestamp).
Recover it with `git stash pop` **before** restarting (or `git stash drop` to
discard once the agent has redone the story). Don't `pop` while a fresh iteration
is editing the same files — you'll get conflicts.

`stop-ralph` is the wrong tool for a hang: its STOP flag is only checked
*between* iterations, so it waits for the stuck one (which `ralph.sh` will itself
auto-kill at `RALPH_ITER_TIMEOUT`, default 40 min, then retry).

## Which runner?

| | `npm run ralph` (SDK, default) | `npm run ralph:sh` (legacy shell) |
|---|---|---|
| Implementation | `run-sdk.mjs` → `@anthropic-ai/claude-agent-sdk` | `run.mjs` → `ralph.sh` → `claude --print` |
| Why an iteration ended | Structured: `success` / `error_max_turns` / `error_max_budget_usd` / timeout, plus `stop_reason` | One exit code + a grep for `STORY_DONE` |
| Permissions | `canUseTool` gate — allows everything except `git push`, `rm -rf`, destructive git, and `--no-verify` | `--dangerously-skip-permissions` (all or nothing) |
| Cost | Per-story `$` + tokens printed each iteration and appended to `costs.jsonl` | Not reported |
| Retry after a timeout | Resumes the story's session (context kept) | Restarts the story cold |
| Needs `jq` / Git Bash | No — pure Node | Yes |
| Runs `amp` instead of Claude | No | Yes (`--tool amp`) |

Both share `CLAUDE.md`, `current-story.json`, `progress.txt`, the `STOP` flag, and
the stop/kill/rescue scripts. Story selection and the `passes:true` flip are
identical (the SDK runner ports the `jq` expressions to JS and unit-tests them in
`run-sdk.test.mjs` — the `dependsOn` deadlock is a regression test now).

SDK-runner-only env vars: `RALPH_MAX_TURNS`, `RALPH_MAX_BUDGET_USD` (hard per-iteration
caps, surfaced as `error_max_turns` / `error_max_budget_usd`), and `RALPH_NO_RESUME=1`
to force every retry to start cold.

## Start

- **`npm run ralph -- 200`** — run up to 200 iterations. Each iteration:
  1. **`ralph.sh` selects the story** (highest-priority *eligible* `passes:false`
     story — see `dependsOn` below) with `jq` and writes just that one object to
     `current-story.json` (~1.5 KB).
  2. The agent runs against the static `CLAUDE.md` prompt, reads
     `current-story.json` (NOT the 300 KB `prd.json`), implements + verifies
     (`tsc`, `build:locked`, `npm test`, `verify:db` for migrations), commits the
     code, and signals `<promise>STORY_DONE</promise>`.
  3. **`ralph.sh` flips `passes:true`** for that story with `jq`, appends to
     `progress.txt`, and commits — the agent never reads or rewrites `prd.json`.

  This split exists to cut token usage: selecting + flipping in the harness keeps
  ~80K tokens of `prd.json` out of every iteration, and the unchanged prompt
  prefix stays prompt-cache friendly. See `LEARNINGS.md` for the persistent
  cross-iteration gotchas playbook.

### Per-story tuning (optional fields on a `prd.json` story)

| Field | Effect |
|---|---|
| `"hard": true` | Force this story's iteration onto `$HARD_MODEL` (Opus) — a no-op now the default is Opus, but still meaningful if you lower the default. |
| `"model": "opus"\|"sonnet"\|"haiku"` | Exact model for this story (overrides `hard`). |
| `"relevantPaths": ["src/…", "…"]` | File/glob hints the agent reads first instead of sweeping the tree. |
| `"dependsOn": ["US-1276", …]` | Hard prerequisites. The story is **not eligible** for selection until every listed id is `passes:true` (or archived to `prd.archive.json`). Prevents the reverse-order deadlock where a high-priority dependent (e.g. marketing copy) is picked forever while its lower-priority prerequisites never get a turn. Only this field gates selection — the loose `[[US-xxxx]]` links in `notes` prose are NOT parsed. If *every* remaining open story is blocked (a cycle), `ralph.sh` errors out with the offenders instead of falsely emitting `COMPLETE`. |

### Stories the loop refuses to pick

A story whose title carries `[OPERATOR]`, `USER ACTION REQUIRED` or
`DEFERRED for agent loop` is **skipped**, and the skipped set is listed on the
first iteration so it does not quietly disappear.

This is not a nicety. Selection is stateless — a killed or failed iteration never
flips `passes:true`, so the next one re-picks the same story. Give the loop
something no agent can finish (apply to eBay for a restricted scope, photograph a
golden set, click through Search Console) and it does not lose one iteration, it
loses **the entire run**, retrying the same wall until the count is spent. Three
such stories sat at priorities 58–60 before this existed.

Matched on the **title only**. `notes` is append-only prose where these phrases
routinely describe *other* stories' operator steps, and matching there would gate
work that is perfectly runnable. So tag the title when you file operator work.

If every open story ends up gated (operator-gated or `dependsOn`-blocked), the
runner exits non-zero with the offenders rather than emitting `COMPLETE` — open
work remaining is never "done".

Model tiering (default **Opus**; a story can pin a cheaper `"model"` or escalate
via `"hard"`) gives every story the strong model unless told otherwise. Env
overrides: `RALPH_DEFAULT_MODEL`, `RALPH_HARD_MODEL`, and `RALPH_FORCE_MODEL`
(forces one model for every story — handy for a one-off all-Opus or all-Sonnet
sweep; e.g. `RALPH_DEFAULT_MODEL=sonnet` to drop back to a cheaper default).
`relevantPaths` can be hand-written or auto-generated — see
[`../../docs/GRAPHIFY_PILOT.md`](../../docs/GRAPHIFY_PILOT.md).
- **`scripts\ralph\start-loop.bat 200`** — same, but launches in a detached
  window pinned to logical cores 0–11 at below-normal priority with a 3 GB heap
  cap, so it can share the host with another agent loop without starving it. See
  `../../docs/AGENT_COHABITATION.md`.

Each iteration is capped by a timeout (default 2400s; override with
`RALPH_ITER_TIMEOUT=<seconds>`) so a hung build can't stall the whole loop.

## Stop gracefully  ← preferred

```
powershell -ExecutionPolicy Bypass -File scripts\ralph\stop-ralph.ps1
```

Drops a `STOP` flag that `ralph.sh` checks **at the top of each iteration**.
Because control only returns there once the current iteration has fully finished
and **committed** (`passes → true`), Ralph completes the story it's on, then exits
**before** starting the next one — never mid-work. The flag is consumed on exit.
Use this whenever you can wait for the current story to land (could be a few
minutes). Cancel a pending stop with `Remove-Item scripts\ralph\STOP`.

## Stop immediately (force)

```
powershell -ExecutionPolicy Bypass -File scripts\ralph\kill-ralph.ps1
```

Force-kills every Ralph process on the host (`run.mjs`, `ralph.sh`, the
`claude --print` agent) plus build children (`prerender`, `build-lock`), matched
by command-line signature. **Can leave the in-progress iteration's work
uncommitted** — only use it when you must stop now. It never touches your
interactive Claude session or VS Code.

## Files in this folder

| File | Purpose |
|---|---|
| `run-sdk.mjs` | **The loop (default).** Agent SDK runner: story selection, `canUseTool` gate, structured outcomes, cost accounting, session resume. |
| `run-sdk.test.mjs` | Unit tests for story selection + model tiering (incl. the `dependsOn` deadlock regression). |
| `run.mjs` | Legacy launcher (`npm run ralph:sh` → finds Git Bash → `ralph.sh`). |
| `ralph.sh` | Legacy loop: per-iteration timeout, graceful-stop check, stray-build sweep. Also the only path that can drive `amp`. |
| `sessions.json` | storyId → session id, so a timed-out story resumes instead of restarting (git-ignored). |
| `costs.jsonl` | Append-only per-story cost/token/outcome log written by the SDK runner (git-ignored). |
| `CLAUDE.md` | The agent prompt (static; reads `current-story.json`, implements + verifies). |
| `current-story.json` | The one story the harness selected this iteration (git-ignored, regenerated each loop). |
| `LEARNINGS.md` | Small curated gotchas playbook read every iteration (cheap persistent memory). |
| `start-loop.bat` | Boxed launcher (CPU affinity + priority + heap cap). |
| `stop-ralph.ps1` / `.sh` | Graceful stop — finish current iteration, then exit. |
| `kill-ralph.ps1` / `.sh` | Force kill — stop every Ralph process immediately. |
| `kill-stray-builds.ps1` | Sweeps lingering build helpers between iterations. |
| `progress.txt` | Append-only per-iteration progress log. |
| `STOP` | Runtime graceful-stop flag (git-ignored; created/removed by the scripts). |
