---
title: Copy style guide
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [content, copy, brand]
summary: Voice, tone and the claims copy is not allowed to make.
---
# Copy Style Guide (US-453)

A short, enforceable guide for UI microcopy in GradeThread. The goal: copy that
reads as consistent, human, and brand-aligned. When in doubt, prefer the plainer,
shorter, more concrete phrasing.

## Voice

- **Human, not system.** Write like a knowledgeable colleague, not an error log.
  "We couldn't reach eBay — try again in a moment." not "Request failed (502)."
- **Concrete over generic.** Name the thing the user is acting on ("Delete source",
  not "Delete"; "Re-trigger grading", not "Re-trigger").
- **No jargon or internal terms** in user-facing copy (e.g. don't surface "RLS",
  "offer id", "service-role" unless the audience is admins who need it).

## Capitalization — sentence case

Use **sentence case** everywhere: titles, headings, buttons, labels, menu items,
toasts, table headers. Capitalize only the first word and proper nouns
(GradeThread, eBay, Stripe, FlipDesk, names of plans like Starter/Pro).

- ✅ "Change user plan", "Mark as failed", "Delete prompt version"
- ❌ "Change User Plan", "Mark As Failed", "Delete Prompt Version"

Proper nouns keep their casing: "Connect to eBay", "Manage Stripe billing".

## Buttons & action labels — action-first, describe the action

Buttons name the action the user is about to take. The label should make sense
read on its own, out of context.

- ✅ "Delete source", "Remove member", "Publish post", "Send back"
- ❌ "OK", "Confirm", "Confirm Change", "Submit", "Yes"

Lead with the **verb**, then the **object** when one exists: `Verb object`
("Delete rule", "Change role", "End listing"). Bare verbs ("Delete", "Remove")
are acceptable only when the surrounding context makes the object unmistakable,
but prefer naming it.

## Confirm / cancel dialogs

Prefer the shared promise-based `useConfirm()` (`src/components/ui/confirm-dialog.tsx`)
over a hand-rolled `<AlertDialog>` or native `window.confirm`.

- **Title** — a question or a short statement in sentence case: "Delete this
  source?", "Change user role".
- **Description** — one or two plain sentences. State the consequence and whether
  it can be undone ("This can't be undone.").
- **Confirm button** — describes the action, never a bare "OK"/"Confirm":
  `confirmLabel: "Delete source"`. Mark destructive actions with `destructive: true`
  so the button uses the destructive variant.
- **Cancel button** — "Cancel" is fine; it's the universally understood escape and
  needs no object.

```ts
if (
  !(await confirm({
    title: "Delete this source?",
    description: "Linked items are kept but unlinked. This can't be undone.",
    confirmLabel: "Delete source",
    destructive: true,
  }))
)
  return;
```

## Tooltips

- Add a tooltip only when it tells the user something the visible UI does **not**.
  A `title` that merely repeats the link/button's own visible label is redundant —
  remove it (it adds noise for sighted and screen-reader users alike).
- Icon-only controls still need an accessible name — use `aria-label`, not a
  decorative `title` (see the jsx-a11y guard from US-446).
- Don't repeat a global hint (e.g. "press ⌘K") on every item; surface it once in a
  central place.

## Toasts (sonner)

- Success: past-tense, specific — "Source deleted.", "Plan changed to Pro."
- Error: say what failed and what to do — "Couldn't delete source. Try again."
- One sentence, sentence case, end with a period.

## Quick checklist before shipping copy

- [ ] Sentence case (not Title Case, not ALL CAPS)?
- [ ] Button names the action ("Delete source"), not "OK"/"Confirm"?
- [ ] Destructive confirms describe the action and use the destructive variant?
- [ ] No tooltip that just repeats visible text?
- [ ] No internal/system jargon leaking to non-admin users?

## Related

- [[content-publishing]] — where this copy ends up
- [[seo-geo-strategy]] — the standard-setting voice this supports
- [[INDEX]]
