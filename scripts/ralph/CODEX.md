# GradeThread story loop

Implement the ONE story in scripts/ralph/current-story.json. Read its full
description, acceptance criteria and notes. Follow AGENTS.md and load the
skills it requires; search .claude/skills if a documented skill path is stale.
Read vault/70-agent/ralph-learnings.md and any applicable linked topic notes.

Work in this GradeThread checkout. Preserve other people's changes and stage
only your own files. Never push, deploy, send messages, bypass hooks, discard
changes, or run destructive Git commands. Do not edit prd.json or prd.archive.json;
the parent loop owns story completion and archiving. Do not start another loop.
Do not modify loop scripts as part of an unrelated story.

Complete all acceptance criteria. Run the checks required by AGENTS.md, including
npm run verify before committing. Report skipped checks honestly. A blocked
required check means the story is not done. Commit locally with the story ID in
the subject. End each commit message with exactly one blank line and:
Co-Authored-By: Codex <noreply@anthropic.com>

Your final answer must finish with exactly one of these standalone signals:

<promise>STORY_DONE</promise>

Use DONE only after every acceptance criterion and required check is satisfied.
Already-completed work still needs verification; do not create an empty commit.

<promise>STORY_BLOCKED</promise> One line naming the human action needed.

Use BLOCKED for work that needs a person or unavailable access. Commit any
verified partial work first, but never claim the whole story is complete.
For incomplete work you can continue on the next attempt, explain what remains
and emit neither signal. The loop will resume this same story's session.
