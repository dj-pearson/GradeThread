// Mark US-184 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-184": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Marketplaces/ gains the full sync flow. The edge endpoint POST /api/flipdesk/ebay/listings/pull returns 202 immediately and runs the actual sync detached (see flipdesk-ebay.ts) — iOS follows the same pattern the web does: kick off the request, then poll marketplace_connections.last_synced_at to detect completion. EbaySyncTypes.swift carries ListingsPullStarted (202 wire shape), EbaySyncBaseline (pre-sync snapshot), EbaySyncSummary (post-sync counts + deltas), EbaySyncCompletion (.completed / .timedOut / .connectionFlagged / .failed). EbaySyncService.snapshot(userId:) reads the LocalListing + LocalSale counts and the connection's last_synced_at into a baseline. sync(userId:baseline:) posts the listings/pull request, polls every 3s up to 90s waiting for last_synced_at to advance via didAdvance (handles first-ever sync where baseline is nil, mixed-precision ISO strings, equal-timestamp = not advanced). Mid-poll detection of refresh_error on the connection routes to .connectionFlagged so the user reconnects on the Marketplaces card. On completion the service posts .inventoryPullRequested for the SyncEngine to refresh local rows, waits 1.2s for that to land, then builds an EbaySyncSummary with deltas computed against the baseline. EbaySyncStore @MainActor @Observable owns the phase machine and a cycling stage-label timer (5s rotation through 'Loading listings…' / 'Matching SKUs…' / 'Pulling orders + fees…') so the modal feels alive while the work runs detached. EbaySyncModal renders per-phase: starting → ProgressView + 'Starting sync…'; syncing → ProgressView + rotating stage label + '~30-60 seconds' subline; completed → green checkmark + summary card with Listings/Active/Sales counts and ±delta pills; timedOut → orange clock + 'Still syncing in the background — pull-to-refresh in a minute'; connectionFlagged → orange triangle + the refresh_error message + 'Reconnect on Marketplaces' button; failed → red octagon + raw error + Close. interactiveDismissDisabled while syncing so the user can't dismiss mid-flight. Sync entrypoints: MarketplacesView's connected card gains a 'Sync now' brand-navy button alongside Reconnect/Disconnect; InventoryListView's toolbar gains an arrow.triangle.2.circlepath button in the trailing toolbar that opens the same modal. Tests in EbaySyncTests cover ListingsPullStarted decode (with + without optional message), didAdvance for first-ever-sync (nil baseline) / nil current (no advance) / equal timestamps (no advance) / strictly newer / mixed-precision ISO strings, EbaySyncStore beginSync → starting/syncing(0), apply for each completion case, reset, stageLabel nil outside syncing phase, EbaySyncSummary zero defaults.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
