import { readFileSync, writeFileSync } from "node:fs";

const p = JSON.parse(readFileSync("./prd.json", "utf8"));

const stories = [
  {
    rc: "RC-001",
    title: "Reconcile: DB columns + sessions table",
    description:
      "As a developer, I need to store each photo capture time and which reconciliation session/cluster it came from so clustering survives reloads.",
    ac: [
      "Migration adds nullable captured_at timestamptz to item_photos",
      "Migration adds reconcile_session_id uuid NULL to item_photos (existing rows unaffected)",
      "New table flipdesk_reconcile_sessions (id, user_id NOT NULL, created_at, photo_count int, status enum open|committed|abandoned)",
      "RLS on flipdesk_reconcile_sessions scopes rows owner-only (select/insert/update/delete), mirroring item_photos pattern",
      "src/types/database.ts updated for new columns and table",
      "Migration applies cleanly on a fresh DB",
      "Typecheck passes",
    ],
  },
  {
    rc: "RC-002",
    title: "Reconcile: browser EXIF capture-time reader",
    description:
      "As a developer, I need a browser utility that extracts the original capture timestamp from an image File before it is re-encoded, since the upload pipeline strips EXIF.",
    ac: [
      "New util src/lib/exif.ts exposes readCaptureTime(file: File): Promise<Date | null>",
      "Reads DateTimeOriginal, falls back to DateTimeDigitized then file lastModified; returns null if unavailable",
      "Any added EXIF dependency is tree-shakeable and < ~30KB gzipped",
      "Unit test covers: photo with EXIF, photo without EXIF (fallback), corrupt file (null)",
      "Tests pass",
      "Typecheck passes",
    ],
  },
  {
    rc: "RC-003",
    title: "Reconcile: route, page scaffold, dump drop zone",
    description:
      "As a reseller, I want a dedicated screen where I can drop my whole haul of photos at once so I can start sorting them into items.",
    ac: [
      "Route /dashboard/flipdesk/reconcile added in src/routes/index.tsx under the protected dashboard layout",
      "Reconcile entry added to the FlipDesk sidebar group in src/components/dashboard/sidebar.tsx",
      "Drop zone accepts multi-file drag-drop and a multi-file picker (accept=image/* multiple); 100+ files do not freeze the UI",
      "On ingest a flipdesk_reconcile_session row is created and each file capture time is read via readCaptureTime BEFORE any compression",
      "Thumbnails render in an Unassigned tray with a running photo count",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-004",
    title: "Reconcile: capture-time gap clustering",
    description:
      "As a reseller, I want the dump auto-split into proposed item groups based on when photos were taken so most of the grouping is done for me.",
    ac: [
      "Pure function clusterByTimeGap(photos, gapSeconds) in src/lib/reconcile-cluster.ts groups photos sorted by captured_at; a gap >= threshold starts a new cluster",
      "Default threshold 30s, adjustable via a slider; re-running re-clusters live",
      "Photos with no capture time go into a separate Needs sorting bucket, not silently merged",
      "Each proposed cluster renders as a labeled group of thumbnails",
      "Unit tests cover gap boundaries, single-photo clusters, and the no-timestamp bucket",
      "Tests pass",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-005",
    title: "Reconcile: visual-similarity second pass",
    description:
      "As a reseller, I want photos of the same garment grouped even when shot out of order so clustering survives messy hauls.",
    ac: [
      "Edge endpoint POST /api/flipdesk/ai/embed-photos returns embeddings or pairwise similarity for a batch, tenant-scoped to workspaceOwnerId ?? userId and quota-gated",
      "Second-pass logic merges/splits time-based clusters using similarity above a tuned threshold, only when the user opts in via a toggle",
      "Visual pass never overrides a manual merge/split the user already made",
      "If the endpoint fails, time-gap clustering still stands and the user is told the visual pass was skipped",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-006",
    title: "Reconcile: manual merge, split, move",
    description:
      "As a reseller, I want to fix grouping mistakes by hand so I am never blocked by a wrong auto-guess.",
    ac: [
      "Multi-select photos with Move to new cluster and Move to cluster... actions",
      "Merge two clusters into one; split a cluster by selecting a subset",
      "Drag a photo from one cluster to another (reuse dnd-kit as in pipeline.tsx)",
      "Manual edits are marked so the optional visual pass will not undo them",
      "Cluster assignments persist on the session so a reload restores state",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-007",
    title: "Reconcile: link cluster to existing item",
    description:
      "As a reseller, I want to attach a cluster photos to an item I already created so I am not duplicating drafts.",
    ac: [
      "Per-cluster Link to existing item picker lists photo-less items in status draft/sourced/cataloged, scoped to workspaceOwnerId ?? userId",
      "AI suggests the most likely matching item (brand/tag from cluster photos) shown first with a confidence indicator; never auto-applied",
      "Manual search box filters candidate items by title/brand/SKU as fallback",
      "Selecting a target marks the cluster as will link to {item} without committing yet",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-008",
    title: "Reconcile: AI per-photo type classification",
    description:
      "As a reseller, I want each photo in a cluster auto-tagged as front/back/tag/detail so my items have correctly typed photos.",
    ac: [
      "When a cluster is finalized, each photo is classified into a flipdesk_photo_type (front|back|tag|detail|defect|flatlay|on_model) via AI, tenant-scoped and quota-gated",
      "User can correct any photo type inline; corrections respected on commit",
      "Classification failures fall back to detail rather than blocking commit",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-009",
    title: "Reconcile: commit clusters to pipeline",
    description:
      "As a reseller, I want to push finalized clusters into the pipeline in one action so all my items become real drafts at once.",
    ac: [
      "Create new clusters insert an inventory_items draft owned by workspaceOwnerId ?? userId",
      "Link clusters attach to the chosen existing item with ownership re-verified server/RLS side",
      "Each cluster photos run through the existing compress+thumbnail+upload path and insert into item_photos with classified photo_type, captured_at, and reconcile_session_id",
      "Items with the required photo set reach status photographed (reuse advanceItemStatus)",
      "On success the session is marked committed; partial failures surface per cluster (reuse batch-results pattern), not a wall of toasts",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-010",
    title: "Reconcile: generate title + details per cluster",
    description:
      "As a reseller, I want to click Generate on a committed item and get a title plus brand/style/size/color/material/condition filled in.",
    ac: [
      "Per-item Generate button calls POST /api/flipdesk/ai/bulk-extract with the committed item_id; runs only on explicit click",
      "Returned fields apply to the item; high-confidence auto-apply, lower-confidence go to review state, consistent with current /bulk-extract behavior",
      "Quota exhaustion is surfaced clearly",
      "A Generate all action runs sequentially over committed items in the session",
      "Typecheck passes",
      "Verify in browser using dev-browser skill",
    ],
  },
  {
    rc: "RC-011",
    title: "Reconcile: iOS batch import",
    description:
      "As a reseller using the iOS app, I want to pick a batch of photos and send them into a reconcile session so the workflow is not web-only.",
    ac: [
      "iOS multi-select picker (reuse PhotoLibraryPicker/PhotoStagingTray) can target a reconcile session rather than a single item",
      "Original PHAsset creationDate is captured as captured_at before compression (PhotoCompressor strips metadata)",
      "Photos sync into a reconcile session the web board can open and finish",
      "Builds and runs on device/simulator following existing SyncEngine patterns",
    ],
  },
  {
    rc: "RC-012",
    title: "Reconcile: cross-tenant isolation tests",
    description:
      "As a developer, I need automated proof that one workspace can never read or write another reconcile data so we do not regress US-268.",
    ac: [
      "Tests added to services/edge-functions/src/tests/tenant-isolation_test.ts covering new embed/classify and reconcile commit endpoints",
      "Verifies a user cannot link a cluster to, or generate against, an item they do not own",
      "Verifies flipdesk_reconcile_sessions rows are not visible across tenants",
      "All tenant-isolation tests pass",
      "Typecheck passes",
    ],
  },
];

let nextNum = 279;
for (const s of stories) {
  p.userStories.push({
    id: "US-" + nextNum,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.ac,
    priority: nextNum,
    passes: false,
    notes:
      "PRD ref " +
      s.rc +
      " (tasks/prd-photo-dump-reconciliation.md). Photo Dump Reconciliation feature.",
  });
  nextNum++;
}

writeFileSync("./prd.json", JSON.stringify(p, null, 2) + "\n");
console.log("Appended 12 stories. New total:", p.userStories.length);
console.log("New range: US-279 .. US-" + (nextNum - 1));
