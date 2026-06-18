# Ralph — start / stop / kill

Ralph is the autonomous loop that implements `prd.json` user stories one per
iteration (`ralph.sh`, launched via `run.mjs`). This folder holds everything you
need to run and control it. Commands below are run from the **repo root**.

## TL;DR

| I want to… | Command |
|---|---|
| **Start** (simple) | `npm run ralph -- 200` |
| **Start** (boxed: own CPU cores + below-normal priority) | `scripts\ralph\start-loop.bat 200` |
| **Stop gracefully** (finish current story, then exit) | `powershell -ExecutionPolicy Bypass -File scripts\ralph\stop-ralph.ps1` |
| **Stop NOW** (force, mid-iteration) | `powershell -ExecutionPolicy Bypass -File scripts\ralph\kill-ralph.ps1` |
| **Cancel a pending graceful stop** | `Remove-Item scripts\ralph\STOP` |

Git Bash equivalents: `bash scripts/ralph/stop-ralph.sh`, `bash scripts/ralph/kill-ralph.sh`.

## Start

- **`npm run ralph -- 200`** — run up to 200 iterations. `run.mjs` finds Git Bash
  and execs `ralph.sh`. Each iteration:
  1. **`ralph.sh` selects the story** (highest-priority `passes:false`) with `jq`
     and writes just that one object to `current-story.json` (~1.5 KB).
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
| `run.mjs` | Cross-platform launcher (`npm run ralph` → finds Git Bash → `ralph.sh`). |
| `ralph.sh` | The loop: per-iteration timeout, graceful-stop check, stray-build sweep. |
| `CLAUDE.md` | The agent prompt (static; reads `current-story.json`, implements + verifies). |
| `current-story.json` | The one story the harness selected this iteration (git-ignored, regenerated each loop). |
| `LEARNINGS.md` | Small curated gotchas playbook read every iteration (cheap persistent memory). |
| `start-loop.bat` | Boxed launcher (CPU affinity + priority + heap cap). |
| `stop-ralph.ps1` / `.sh` | Graceful stop — finish current iteration, then exit. |
| `kill-ralph.ps1` / `.sh` | Force kill — stop every Ralph process immediately. |
| `kill-stray-builds.ps1` | Sweeps lingering build helpers between iterations. |
| `progress.txt` | Append-only per-iteration progress log. |
| `STOP` | Runtime graceful-stop flag (git-ignored; created/removed by the scripts). |
