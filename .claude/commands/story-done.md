---
description: Close a prd.json story — append a completion note, flip passes, lint
argument-hint: US-#### [US-#### …] [free-text summary of what shipped]
allowed-tools: Bash(node scripts/prd-story.mjs:*), Bash(npm run prd:lint:*), Bash(git log:*), Bash(git diff:*), Bash(git status:*), Read, Grep, Glob
---

Close the story/stories named in: **$ARGUMENTS**

Use `node scripts/prd-story.mjs done <id…> --note "<note>"` — one generic script,
never a new single-use `update-prd-*.mjs` file (that pattern produced ~90 dead
scripts and is being retired).

Write the note yourself from **evidence**, not from what the user typed:

1. Read the story first: `node scripts/prd-story.mjs show <id>`.
2. Check the actual work — `git log --oneline -15`, `git diff --stat`, and read
   the files that changed. If the user gave a summary, verify it matches.
3. Walk each acceptance criterion and confirm it is genuinely met. If one is
   **not**, do NOT close the story: append a `note` instead recording exactly
   what is outstanding, and say so.
4. Note format: `Done <YYYY-MM-DD>. <what shipped, by file/symbol>. <how it was
   verified>.` Name real paths and functions — the notes are the only durable
   record of why a story passed, and vague ones are worthless six months later.
   Notes are APPEND-ONLY; the script adds a ` | ` segment rather than
   overwriting, because `prd-lint` resolves DEFERRED/BLOCKED markers by segment
   order.
5. If the story's notes carry an unresolved `DEFERRED`/`BLOCKED` marker, your new
   segment must contain an uppercase closing token (`DONE`, `SHIPPED`,
   `RESOLVED`, `VERIFIED`) or `prd-lint` will flag it.
6. Closing also MOVES the story to `prd.archive.json` (the script does it; `prd-archive-integrity` fails the build while a finished story sits in `prd.json`). So expect both files in `git status`, and note that `show` will report the story as coming from the archive afterwards. Pass `--no-archive` only for a bulk close you intend to archive in one batch.
7. Finish with `npm run prd:lint` and report the result.

Do not commit unless asked.
