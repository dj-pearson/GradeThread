# Admin Tasks — Markdown import format

The admin task board (`/admin/tasks`) can ingest a Markdown checklist in one shot:
**Import from Markdown** → paste (or upload a `.md`) → review the preview → **Import**.
This is the fast path for turning a setup guide into trackable, checkable steps.

Parser: `src/lib/admin-tasks-import.ts` (`parseTaskMarkdown`).

---

## Format

```
# Project Title
> Optional description. One or more > lines, joined with newlines.

## Section / Phase name
- [ ] A task title !high @2026-06-01
  Indented lines (2 spaces) become the task's instructions / body.
  Keep body lines contiguous — see "Gotchas" below.
- [x] A task that is already done

## Another section
- [ ] Next task
```

| Line | Becomes |
|---|---|
| `# Title` | Project title (first `#` wins) |
| `> text` | Project description (all `>` lines joined) |
| `## Name` | Section label for the tasks that follow |
| `- [ ] text` | A task with status **To Do** |
| `- [x] text` | A task with status **Done** |
| indented line under a task | Appended to that task's body |

### Optional tokens (anywhere in a task title, stripped from the saved title)

| Token | Effect |
|---|---|
| `!high` / `!medium` / `!low` (or `!med`) | Sets priority (default `medium`) |
| `@YYYY-MM-DD` | Sets the due date |

Example: `- [ ] Download the .p8 !high @2026-06-01`

---

## Gotchas

- **Indent body lines by 2 spaces.** A body line at column 0 is dropped (the parser only captures indented continuation lines).
- **No blank lines *inside* a task body.** A blank line ends body capture for that task. Blank lines *between* tasks are fine and improve readability.
- **`#`, `>`, `- [ ]` only count at column 0.** Inside an indented body they're treated as plain text, so commands/URLs containing them are safe.
- **Prose or HTML comments outside the format are ignored**, so a leading `<!-- ... -->` note is harmless when the whole file is pasted.
- **Status on import is only To Do or Done.** In-progress / blocked are set on the board afterward.
- **Order is preserved.** Tasks land in document order; sections render as badges on the cards.

## Appending to an existing project

In the Import dialog, the target selector defaults to **Create new project** but can instead **Add to:** an existing project. Appended tasks are placed after the current ones. Use this to push more steps into a guide over time — drop them under the right `##` section and import.

---

## Copy-paste skeleton

```
# 

## Phase 1 · 
- [ ]  !high
  
- [ ] 

## Phase 2 · 
- [ ] 
```

## Examples in the repo

- `ios/RELEASE.import.md` — the full iOS release guide (`ios/RELEASE.md`) converted to this format.
