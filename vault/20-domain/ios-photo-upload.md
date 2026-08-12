---
title: iOS photo upload — why it needed a foreground session
aliases: [AI couldn't process your photos, upload storm, item_photos missing]
type: contract
status: current
source_of_truth: code
code_refs:
  - ios/GradeThread/Upload/PhotoUploadService.swift
  - ios/GradeThread/Upload/ItemPhotoInsert.swift
reviewed: 2026-08-12
tags: [ios, photos, uploads, contract]
summary: A months-long "AI couldn't process your photos" saga that was four separate bugs, and the rules each one left behind.
---

# iOS photo upload

One user-visible symptom — **"AI couldn't process your photos"** — sat on top of
four independent defects. Each is worth keeping, because each leaves a rule that
applies beyond the bug that produced it.

## 1. A background URLSession is the wrong tool for a gated upload

Storage container logs during a single Add showed each photo's PUT fired **10+
times**, nearly all `ABORTED` within ~4ms, a few completing 200 in 1.5–5s. iOS's
**background** `URLSession` auto-retries and duplicates transfers; against a slow
backend that becomes a storm. The bytes eventually landed, but the client never
saw a clean success, so no `item_photos` row was written and the AI had nothing
to read.

> **If the next step is gated on a clean result, upload in the foreground.** The
> background session is built for opportunistic transfers whose completion nobody
> is waiting on. Here: one PUT per photo, await the real HTTP result, own the
> retries (a few deliberate re-mint + re-PUT on transient 5xx/401/403; fail fast
> on 4xx).

Two traps that follow:

- **Concurrency itself caused the aborts.** A benchmark on the same storage: one
  ~700KB PUT took 0.9–1.6s; **seven concurrent took 3.3–4.2s with two aborted**.
  The fix was `maxConcurrent = 1` (from 3 → 2 → 1), plus shrinking uploads to
  1600px/0.75 (~450KB).
- **A retained background session auto-resumes stale tasks from previous builds
  on launch** and re-storms. **Purge it at init** (`getAllTasks { cancel }`) —
  do not try to "drain" it.

## 2. Serialize the database link, not the uploads

Which photos got `item_photos` rows varied **run to run** — front and back one
time, two measurements the next. That variance is the signature of a race rather
than a constraint.

Each completed PUT fired its insert in its own detached `Task`, so a burst of
finishes hammered the shared Supabase client and some inserts were lost to
token-refresh and connection contention. The photo was marked failed and its
bytes orphaned.

The fix serializes the **link**, not the transfer: completions append to a
MainActor chain that awaits the previous one, so inserts run one at a time while
uploads stay independent; the upsert retries with backoff; the chain cancels on
sign-out. A photo also holds its concurrency slot until its link finishes, so the
"start next" call must run *after* the link or the pipeline stalls.

## 3. Lowercase every client-minted UUID that becomes a Postgres `uuid`

Swift's `UUID().uuidString` is **uppercase**. Postgres normalises a `uuid` column
to lowercase, the sync pull returns it lowercase, and a case-sensitive lookup
against the optimistic local mirror misses — so the merge inserts a **second**
local row. Photos attach to the server (lowercase) row, producing the reported
"Add created two items, one with photos and one without".

> **Fix at the mint site, not the merge.** Any client-generated id destined for a
> Postgres `uuid` column must be `.lowercased()` at creation. Existing duplicates
> self-heal on the next prune sync, because the orphaned uppercase mirror is not
> in the server's id set.

## 4. A non-terminal failure state blocks the gate

An upload left in `.failed` was not treated as terminal, so the "wait for
uploads" gate blocked for its full 180s timeout instead of failing fast. And the
signed-URL mint POST sent `application/json` with **no body**, which storage
answers with a 400 — the fix is to send `{}`.

## Two paths write the row, and the second one is invisible

An `item_photos` row leaves this file two ways: the direct upsert on the link
chain (`ItemPhotoInsert`), and the `LocalPendingMutation` payload the SyncEngine
replays when that upsert failed or the device was offline. They are separate
structs. A field added to one is not added to the other, and nothing fails when
you forget.

`photo_role` is the case that proved it. The SyncEngine replay has **read** that
field since US-2468 while nothing wrote it, so a replayed photo could only land
unroled. US-2470 had to add it to `ItemPhotoInsert` **and** to the queued payload
in the same change; fixing only the insert would have given the online shot a
role and the offline one a null. That is not a cosmetic gap — a null role reads
as "card frame", which never reaches a listing (see [[listing-photos]] for that
rule and for the type/role split itself).

> **Add a field to `ItemPhotoInsert` and to `enqueuePendingMutation`'s payload in
> the same edit.** The replay is the path nobody exercises by hand, so a field
> missing there fails only for the users who were offline — and fails silently.

Two consequences of the same change, both visible in this file:

- A slot is a `CaptureSlot` — the `(photo_type, photo_role)` pair — so the queued
  payload's `slot` is a `storageKey` like `tag|size`, not a bare enum raw value.
  Pre-US-2470 payloads hold the bare value and decode to the same thing, so the
  queue survives the upgrade.
- `enqueueAll` no longer derives `sort_order`; it numbers the caller's order as
  given. Which order that is belongs to [[listing-photos]].

## Verifying a fix here

- **Build number = the GitHub run number.** A "still broken" report was a
  pre-rebuild build. Confirm with
  `gh run list --commit <sha> --workflow "iOS Release"` before concluding a fix
  failed.
- **Diff `storage.objects` against `item_photos`** for the affected item, across
  *several* attempts. The per-run variance is what distinguishes a race from a
  deterministic constraint — a single run cannot.
- Target pattern in the storage logs: `POST sign ({} body) → PUT → 200`, one
  photo at a time, zero `ABORTED`.

**Still open, and it is infrastructure:** ~1MB writes take 1.5–5s. Worth checking
what volume backs the storage container. The app-side changes mitigate it; they
do not fix it.

## Related

- [[listing-photos]] — the order and required-set contract these photos land in
- [[image-intake]] — the web side of "what bytes are allowed in"
- [[ralph-ios-log]] — other iOS-specific gotchas
- [[INDEX]]
