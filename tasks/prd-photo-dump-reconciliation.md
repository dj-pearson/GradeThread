# PRD: Photo Dump Reconciliation (FlipDesk)

## Introduction

Resellers source in bulk. A single thrift or estate haul produces dozens of garments, and the
photos for all of them get shot in one burst — typically 50–150 images sitting in a camera roll
by the time the reseller is back home at a desk. Today, FlipDesk only supports a **one-item-at-a-time**
flow (`SnapCatalog`): you create a draft, then attach that item's photos. There is no way to take
a large undifferentiated photo dump and efficiently split it back into the individual items it
represents.

**Photo Dump Reconciliation** is a new batch surface at `/dashboard/flipdesk/reconcile` that closes
that gap. The reseller drops the whole haul at once. The system auto-groups the photos into
proposed per-item clusters (using capture-time gaps, with an optional visual-similarity pass), then
for each cluster the reseller either **links** it to an existing photo-less item or **creates** a new
draft and runs AI to generate the title and details. Items land at the `photographed` pipeline status,
ready to draft and list.

This is the inverse of how competitors (Vendoo, List Perfectly, Flyp) work — they start from an item
and attach photos. Matching the reseller's real "shoot first, sort later" workflow is the
differentiator.

## Goals

- Let a reseller process a 100+ photo haul into listing-ready item drafts in a single sitting.
- Reduce per-item photo-organization and data-entry time vs. the one-at-a-time `SnapCatalog` flow.
- Auto-group dumped photos into per-item clusters with a good enough first guess that manual
  correction is the exception, not the rule.
- Reuse existing infrastructure (`item_photos`, `/bulk-extract`, pipeline statuses) rather than
  building a parallel system.
- Work on both web and the native iOS capture app.
- Maintain strict multi-tenant isolation (US-268): every query scoped to `workspaceOwnerId ?? userId`.

## Critical Technical Constraint (read first)

**The existing upload pipeline strips EXIF.** `src/components/flipdesk/photo-uploader.tsx` re-encodes
every photo through a canvas (`compressImage`) before upload, which discards EXIF. The `item_photos`
table has no capture-time column. Therefore **capture-time clustering cannot run on stored photos** —
the timestamps are gone by then.

The reconcile flow must read EXIF capture time from the **original `File` objects in the browser,
before compression**, during dump ingest, and carry that timestamp through clustering and into a new
persisted column. Any story that depends on capture time must read it pre-compression. This constraint
is non-negotiable and is the reason several stories below are ordered the way they are.

## User Stories

### US-RC-001: Persist photo capture time and grouping metadata
**Description:** As a developer, I need a place to store each photo's original capture time and which
reconciliation session/cluster it came from, so clustering survives reloads and the audit trail is intact.

**Acceptance Criteria:**
- [ ] Migration adds nullable `captured_at timestamptz` to `item_photos`.
- [ ] Migration adds `reconcile_session_id uuid NULL` to `item_photos` (nullable; existing rows unaffected).
- [ ] New table `flipdesk_reconcile_sessions` (`id`, `user_id NOT NULL`, `created_at`, `photo_count int`,
      `status` enum `open|committed|abandoned`) with RLS scoping rows to `user_id = auth.uid()`.
- [ ] RLS on `flipdesk_reconcile_sessions` mirrors the `item_photos` ownership pattern (owner-only
      select/insert/update/delete).
- [ ] `src/types/database.ts` updated to reflect new columns/table.
- [ ] Typecheck passes; migration applies cleanly on a fresh DB.

### US-RC-002: Read EXIF capture time from files in the browser before compression
**Description:** As a developer, I need a browser utility that extracts the original capture timestamp
from an image `File` before it is re-encoded, so time-gap clustering has real data to work with.

**Acceptance Criteria:**
- [ ] New util `src/lib/exif.ts` exposes `readCaptureTime(file: File): Promise<Date | null>`.
- [ ] Reads `DateTimeOriginal` (falls back to `DateTimeDigitized`, then file `lastModified`) from
      JPEG and HEIC where the browser exposes it; returns `null` if unavailable.
- [ ] Does not depend on a heavy dependency where a small focused parser suffices; if a library is
      added, it must be tree-shakeable and < ~30KB gzipped.
- [ ] Unit test covers: photo with EXIF, photo without EXIF (returns fallback), corrupt file (returns null).
- [ ] Typecheck and lint pass.

### US-RC-003: Reconcile route, page scaffold, and dump drop zone
**Description:** As a reseller, I want a dedicated screen where I can drop my whole haul of photos at once,
so I can start sorting them into items.

**Acceptance Criteria:**
- [ ] Route `/dashboard/flipdesk/reconcile` added in `src/routes/index.tsx`, guarded by the existing
      protected/dashboard layout.
- [ ] "Reconcile" entry added to the FlipDesk sidebar group in `src/components/dashboard/sidebar.tsx`.
- [ ] Drop zone accepts multi-file drag-drop and a multi-file picker (`accept="image/*" multiple`);
      supports 100+ files without freezing the UI (process/thumbnail off the main render path).
- [ ] On ingest, a `flipdesk_reconcile_session` row is created and each file's capture time is read
      via `readCaptureTime` (US-RC-002) before any compression.
- [ ] Thumbnails render in an "Unassigned" tray; a running count of photos is shown.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-004: Capture-time gap clustering (primary signal)
**Description:** As a reseller, I want the dump auto-split into proposed item groups based on when photos
were taken, so most of the grouping is done for me.

**Acceptance Criteria:**
- [ ] Pure function `clusterByTimeGap(photos, gapSeconds)` in `src/lib/reconcile-cluster.ts` groups
      photos sorted by `captured_at`; a gap ≥ threshold starts a new cluster.
- [ ] Default threshold is 30s, adjustable via a slider in the UI; re-running re-clusters live.
- [ ] Photos with no capture time are collected into a separate "Needs sorting" bucket rather than
      silently merged.
- [ ] Each proposed cluster renders as a labeled group of thumbnails in the board.
- [ ] Unit tests cover gap boundaries, single-photo clusters, and the no-timestamp bucket.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-005: Visual-similarity second pass (refines clustering)
**Description:** As a reseller, I want photos of the same garment grouped even when I shot them out of
order or paused mid-item, so clustering survives messy real-world hauls.

**Acceptance Criteria:**
- [ ] Edge endpoint under `flipdesk-ai.ts` (e.g. `POST /api/flipdesk/ai/embed-photos`) returns image
      embeddings or pairwise-similarity for a batch, tenant-scoped to `workspaceOwnerId ?? userId`
      and quota-gated like other AI routes.
- [ ] Second-pass logic merges/splits time-based clusters using similarity above a tuned threshold,
      and is only invoked when the user opts in (toggle), since it adds cost/latency.
- [ ] Visual pass never overrides a manual merge/split the user already made (US-RC-006).
- [ ] Graceful degradation: if the endpoint fails, the time-gap clustering still stands and the user
      is told the visual pass was skipped.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-006: Manual merge, split, and move
**Description:** As a reseller, I want to fix grouping mistakes by hand, so I'm never blocked by a wrong
auto-guess.

**Acceptance Criteria:**
- [ ] Multi-select photos and "Move to new cluster" / "Move to cluster…" actions.
- [ ] Merge two clusters into one; split a cluster by selecting a subset.
- [ ] Drag a photo from one cluster to another (reuse dnd-kit, already used in `pipeline.tsx`).
- [ ] Manual edits are marked so the optional visual pass (US-RC-005) won't undo them.
- [ ] Cluster assignments persist on the session so a reload restores state.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-007: Link a cluster to an existing item — AI suggestion + manual search
**Description:** As a reseller, I want to attach a cluster's photos to an item I already created, so I'm
not duplicating drafts I entered earlier.

**Acceptance Criteria:**
- [ ] Per-cluster "Link to existing item" opens a picker listing photo-less items in status
      `draft`/`sourced`/`cataloged`, scoped to `workspaceOwnerId ?? userId`.
- [ ] AI suggests the most likely matching item (e.g. brand/tag read from cluster photos), shown first
      with a confidence indicator; user must confirm — suggestions are never auto-applied.
- [ ] Manual search box filters candidate items by title/brand/SKU as a fallback.
- [ ] Selecting a target marks the cluster as "will link to {item}" without committing yet.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-008: AI per-photo type classification within a cluster
**Description:** As a reseller, I want each photo in a cluster automatically tagged as front/back/tag/
detail/etc., so my items have correctly typed photos without manual sorting.

**Acceptance Criteria:**
- [ ] When a cluster is finalized, each photo is classified into a `flipdesk_photo_type`
      (`front|back|tag|detail|defect|flatlay|on_model`) via AI, tenant-scoped + quota-gated.
- [ ] User can correct any photo's type inline; corrections are respected on commit.
- [ ] Classification failures fall back to `detail` rather than blocking commit.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-009: Commit clusters — create/link items, upload photos, set status
**Description:** As a reseller, I want to push my finalized clusters into the pipeline in one action, so all
my items become real drafts at once.

**Acceptance Criteria:**
- [ ] "Create new" clusters insert an `inventory_items` draft owned by `workspaceOwnerId ?? userId`.
- [ ] "Link" clusters attach to the chosen existing item (ownership re-verified server/RLS side).
- [ ] Each cluster's photos run through the existing compress+thumbnail+upload path and insert into
      `item_photos` with their classified `photo_type`, `captured_at`, and `reconcile_session_id`.
- [ ] Items with the required photo set reach status `photographed` (reuse `advanceItemStatus`).
- [ ] On success the session is marked `committed`; partial failures are surfaced per cluster
      (reuse the batch-results pattern from `pipeline.tsx`), not as a wall of toasts.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-010: Generate title + details per cluster (AI bulk-extract)
**Description:** As a reseller, I want to click "Generate" on a committed item and get a title plus
brand/style/size/color/material/condition filled in, so I barely have to type.

**Acceptance Criteria:**
- [ ] Per-item "Generate" button calls the existing `POST /api/flipdesk/ai/bulk-extract` with the
      committed item's `item_id` (generation runs only on explicit click — no auto-run).
- [ ] Returned fields apply to the item; high-confidence fields auto-apply, lower-confidence go to a
      review state, consistent with current `/bulk-extract` behavior.
- [ ] Quota exhaustion is surfaced clearly (the endpoint already clamps + reports skipped).
- [ ] A "Generate all" convenience action runs sequentially over committed items in the session.
- [ ] Typecheck/lint pass; verify in browser using dev-browser skill.

### US-RC-011: iOS batch import into reconcile
**Description:** As a reseller using the iOS app, I want to pick a batch of photos from my library and send
them into a reconcile session, so the workflow isn't web-only.

**Acceptance Criteria:**
- [ ] iOS multi-select picker (reuse `PhotoLibraryPicker`/`PhotoStagingTray`) can target a reconcile
      session rather than a single item.
- [ ] Original `PHAsset` creation date is captured as `captured_at` before compression
      (`PhotoCompressor` strips metadata, same as web).
- [ ] Photos sync into a reconcile session that the web board can open and finish.
- [ ] Builds and runs on device/simulator; matches existing iOS sync patterns (`SyncEngine`).

### US-RC-012: Cross-tenant isolation tests for reconcile
**Description:** As a developer, I need automated proof that one workspace can never read or write another's
reconcile data, so we don't regress US-268.

**Acceptance Criteria:**
- [ ] Tests added to `services/edge-functions/src/tests/tenant-isolation_test.ts` covering the new
      embed/classify endpoints and any reconcile commit endpoint.
- [ ] Verifies a user cannot link a cluster to, or generate against, an item they don't own.
- [ ] Verifies `flipdesk_reconcile_sessions` rows are not visible across tenants.
- [ ] All tenant-isolation tests pass.

## Functional Requirements

- FR-1: The system must provide a route `/dashboard/flipdesk/reconcile` reachable from the FlipDesk sidebar.
- FR-2: The system must accept a batch of 100+ images via drag-drop or file picker in one ingest.
- FR-3: The system must read each photo's capture time from the original `File`/`PHAsset` **before**
  any re-encode/compression, since the upload pipeline strips EXIF.
- FR-4: The system must auto-cluster photos by capture-time gap (default 30s, user-adjustable).
- FR-5: The system must offer an optional visual-similarity pass that refines clusters and never
  overrides manual edits.
- FR-6: The system must let users merge, split, and move photos between clusters manually, persisted to
  the session.
- FR-7: For each cluster the system must let the user either link to an existing photo-less item
  (`draft`/`sourced`/`cataloged`) or create a new draft.
- FR-8: When linking, the system must surface an AI-suggested match (confirm-only) plus manual search.
- FR-9: The system must AI-classify each photo's `photo_type`, with inline user correction.
- FR-10: On commit, the system must create/link items, upload photos through the existing
  compress+thumbnail path into `item_photos`, and advance items to `photographed`.
- FR-11: The system must let the user run `/bulk-extract` per item (and "generate all") only on explicit
  action, respecting the existing quota gate.
- FR-12: Every read/write must be scoped to `workspaceOwnerId ?? userId`; ownership of any item targeted
  by id must be re-verified server-side (US-268).
- FR-13: A reconcile session must persist cluster state so a page reload restores progress.

## Non-Goals (Out of Scope)

- No automatic listing/publishing to eBay from the reconcile screen — items stop at `photographed`;
  drafting/listing remains the existing composer/eBay flow.
- No background-removal or photo editing inside reconcile (the photo editor dialog already exists elsewhere).
- No pricing/comping inside reconcile — comping stays its own pipeline stage.
- No video files; images only for v1.
- No "smart" auto-commit — the user always confirms clusters and triggers AI generation explicitly.
- No de-duplication of near-identical photos beyond what clustering naturally does.

## Design Considerations

- **Layout:** two-pane reconciliation board — an "Unassigned / Needs sorting" tray plus a column or grid
  of proposed clusters. Reuse dnd-kit (already in `pipeline.tsx`) for drag-between-clusters.
- **Reuse:**
  - `PhotoUploader`'s compress/thumbnail/upload pipeline (`compressImage`, `item-photos` bucket,
    storage path `{ownerFolder}/{itemId}/{type}_{ts}.{ext}`).
  - `/bulk-extract`, `/extract`, `/extract-aspects` AI routes in `flipdesk-ai.ts`.
  - Batch-results dialog pattern and optimistic-update style from `pipeline.tsx`.
  - `advanceItemStatus` / `status-writer` for the move to `photographed`.
  - `useWorkspace().workspaceOwnerId` for tenant scoping; `useSources` for carryover source data.
- **Relationship to SnapCatalog:** position reconcile as the *batch / at-home* mode and `SnapCatalog`
  as the *at-the-source, one-item* mode; both feed the same items + AI backend.
- Loading states use the project's standard spinner; toasts via `sonner`.

## Technical Considerations

- **EXIF stripping (see Critical Constraint):** capture time must be read pre-compression on web
  (`src/lib/exif.ts`) and iOS (`PHAsset.creationDate`), then persisted to `item_photos.captured_at`.
- **Performance:** generating thumbnails and reading EXIF for 100+ files must be chunked/yielded so the
  UI stays responsive; consider `requestIdleCallback`/web worker for EXIF parsing.
- **AI cost:** embeddings (US-RC-005) and bulk-extract (US-RC-010) are quota-gated; both are opt-in /
  explicit-click to control spend. Reuse the existing `checkQuota` path in `flipdesk-ai.ts`.
- **Multi-tenant:** the edge service uses the service-role client and bypasses RLS — every new endpoint
  must filter by `workspaceOwnerId ?? userId` and re-verify item ownership before mutating by id.
- **iOS sync:** reconcile sessions must round-trip between iOS and web; follow existing `SyncEngine`
  patterns and the `LocalItemPhoto` model.

## Success Metrics

- Time to convert a ~100-photo haul into `photographed` drafts drops materially vs. the one-at-a-time
  flow (target: under ~15 minutes for 20 items including AI generation).
- Auto-clustering requires manual correction on fewer than ~20% of items in typical hauls.
- ≥ 70% of created items have an AI-generated title accepted with no manual edit.
- No cross-tenant data access (tenant-isolation tests green).

## Open Questions

- Does the chosen EXIF library reliably return `DateTimeOriginal` for HEIC in Safari/Chrome, or do we
  need iOS to be the source of truth for capture time on those files?
- What capture-time gap default best matches real hauls — is 30s right, or should it adapt to the
  burst's median gap?
- For the visual pass, do we self-host an embedding model on the edge container or call an external
  vision API? (Cost vs. latency vs. privacy.)
- Should "Generate all" be a foreground sequential run or a backgrounded job with notifications for
  very large sessions?
- Do we cap reconcile session size (e.g. 200 photos) to protect browser memory and AI quota?
