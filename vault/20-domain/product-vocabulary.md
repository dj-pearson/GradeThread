---
title: Product vocabulary
aliases: [naming, one-verb, add-item]
type: contract
status: current
source_of_truth: vault
code_refs:
  - src/test/one-verb-add-item.test.ts
  - src/pages/flipdesk/intake.tsx
  - ios/GradeThread/ContentView.swift
  - ios/GradeThread/Intents/GradeThreadAppIntents.swift
reviewed: 2026-08-25
tags: [ux, copy, contract, ios]
summary: The one word each product action is allowed to have, starting with "Add item", and the rule for naming a mode without inventing a second verb.
---

# Product vocabulary

A user builds a mental model out of the words the product repeats. When one
action carries four names, there is nothing to build the model out of, and
support cannot write one sentence that covers it.

This note holds the decided words. Each entry says what was chosen, what it
replaced, and where the guard lives.

## The rule

**One action, one verb, everywhere, on every platform.** Where an entry point
picks a *mode*, the mode is a **qualifier**, never a second verb. "Take photos"
next to "Add item" reads as two different actions to somebody who has used
neither; "Photos first" reads as one action done one way.

Prose is exempt. Inside a sentence, "Add an item to get started" is correct
English and is not a label. The rule is about **controls a user reads**:
buttons, headings, menu rows, `label:` / `cta:` / `title:` fields.

Spoken phrases are exempt for a second reason (see Siri, below).

## Add item

**The verb is `Add item`.** Chosen 2026-08-25 (US-2860).

It replaced four web forms and two more iOS sets:

| Was | Where |
|---|---|
| `New item` | flipdesk intake heading, overview, listings, pipeline |
| `Add an item` | pipeline empty state, inventory-tabs empty CTAs, buyer portfolio |
| `Intake an item` | the FlipDesk getting-started checklist |
| `Add item` | activation checklist, bulk-intake (already correct) |
| `Add`, `Add an item` | iOS tab, iPad toolbar, accessibility labels |

Why `Add item` and not one of the others: it is an imperative, it is the
shortest, it was already the most-used form, and "intake" is a warehouse noun
that appears nowhere else in the product's speech.

`Add item` also covers the **buyer closet** (`/buyer/portfolio`), which is a
different table and the same shape of action. A user who learns the verb once
should not have to learn it twice.

### The three modes

iOS offers a choice of how to add; the web has one intake page and offers none.

| Mode | Route | Was called (dialog) | Was called (menu) |
|---|---|---|---|
| `Photos first` | `.photoFirst` | "Photo-first (Snap & Catalog)" | "Take photos" |
| `Details first` | `.detailsFirst` | "Details-first (manual form)" | "Type details" |
| `Bulk with AI` | `.autoLister` | "Bulk add - up to 200 photos -> AI listings (AutoLister)" | "Bulk list with AI" |

Two choosers for the same three routes, six names for three things, on one
platform. Both now use the right-hand column of that first row. The explaining
the old labels crammed into parentheses moved to the dialog's `message`, which
is what a `message` is for.

### Siri phrases are deliberately not renamed

`GradeThreadAppIntents.swift` still offers "Add an item to GradeThread", "Add an
item with GradeThread" and "New item in GradeThread", and gained "Add item to
GradeThread" alongside them.

Two reasons, and the second is the load-bearing one:

1. Speech is a different register. Nobody says "add item to GradeThread" out
   loud.
2. **A phrase that is deleted stops matching the shortcuts people have already
   saved.** That list only ever grows.

The action *name* — `title` and `shortTitle`, which a user **reads** in the
Shortcuts app — does follow the verb: `Add Item`.

`src/test/one-verb-add-item.test.ts` asserts all four phrases are still present,
so a later "tidy up the retired wording" pass fails the build instead of
silently breaking saved shortcuts.

## What is NOT decided here

`New Submission` (send a garment for grading) is a **different action** from
`Add item` and keeps its own name. Whether "Submission" is the right word for a
sixth-grade reading level is US-2868's question, not this note's.

Related: [[draft-snapshot-precedence]], [[sync-source-of-truth]].
