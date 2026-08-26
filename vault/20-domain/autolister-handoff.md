---
title: AutoLister phone → desktop handoff
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-autolister.ts
  - supabase/migrations/00507_autolister_handoff_sessions.sql
  - ios/GradeThread/AutoLister/AutoListerReviewModel.swift
  - src/hooks/use-autolister.ts
reviewed: 2026-08-25
tags: [flipdesk, autolister, mobile, contract]
summary: What crosses from the phone to the desktop AutoLister before any AI runs, and the rules that keep the crossing safe.
---

# AutoLister phone → desktop handoff

US-2374. The phone is where the camera is; the desktop is where a 200-photo
batch is bearable to review. This is the shelf between them.

## Where session state lives

The desktop AutoLister's working session — staged photos plus grouping — lives
in the **browser** (IndexedDB, `localStorage` fallback). That is deliberate and
unchanged: it survives a reload, not a device change. The handoff does **not**
turn it into a server-side session; it is a one-way drop-off that the desktop
loads **by appending** into whatever session is already open there.

Consequences worth knowing before changing anything here:

- Loading a handoff never replaces what is on the desktop's screen. A seller
  mid-session must not lose their photos because a phone batch arrived.
- The desktop dedupes on `storage_path`, so loading the same handoff twice adds
  nothing the second time.
- A claimed handoff is kept, not deleted. Deleting on load would make a
  mis-click destroy an upload the phone may no longer hold.

## What travels

Photos ride in the **same** `{ownerId}/_staging/{sessionId}/…` folder the web
uploader uses (`POST /api/flipdesk/autolister/staging/upload`), so both clients
share one upload path and one validation gate (US-276 sniff → strip → store).
The handoff row holds the photo list and the grouping only.

Two rules that are easy to get wrong:

1. **Ungrouped photos travel too.** The desktop grid is where the job gets
   finished, so holding back the ungrouped ones would defeat the handoff.
2. **A fabricated capture time must never travel.** iOS stamps `.now` when a
   photo carries no EXIF time and tracks that in `timelessIds`; sending it would
   make the desktop's auto-grouping read one instantaneous burst that never
   happened — the same trap US-1909 fixed on the iOS side. Only a real capture
   time is sent; a timeless photo sends `null`.

## Tenancy

`autolister_handoff_sessions` is multi-tenant, so every route filters
`.eq("user_id", ownerId)` (US-268). On top of that, **every** `storage_path`
and `thumbnail_storage_path` in the payload is checked against the caller's own
`{ownerId}/_staging/` prefix before the row is written, and again before the
delete sweep touches storage. Public URLs are re-derived server-side from the
verified paths — a client-supplied URL is never stored, or a forged one would
put another tenant's image on the seller's desktop grid.

Discarding an **open** handoff deletes its staged objects with it; that is the
only place staging orphans get cleaned up on this path.

Discarding a **claimed** one deletes the row and leaves the objects alone, and
that asymmetry is load-bearing: generation does not copy staged objects
anywhere — `item_photos.storage_path` points straight back into `_staging/` —
so once a handoff has been loaded and generated, its photos *are* the live
listing images. Sweeping them would delete published photos out from under the
seller's listings.

## Related

- [[sync-source-of-truth]] — the provenance model for data that crosses
  surfaces after an item exists. The handoff is strictly *before* that: no
  inventory row, no listing, no AI.
