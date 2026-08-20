// US-2699: the sold-sync status projection, and the one-answer rule.
//
// The projection is pure so both surfaces provably share one definition of
// "failing". The source guard at the bottom is the other half: it fails if
// either route grows its own copy of the query, which is the drift
// lib/pending-delists.ts exists to document.

import { assert, assertEquals } from "@std/assert";
import {
  projectSyncChannels,
  type SyncStateRow,
} from "../lib/sync-status.ts";
import { SYNC_PLATFORMS } from "../lib/sync-status.ts";

function state(over: Partial<SyncStateRow> = {}): SyncStateRow {
  return {
    platform: "poshmark",
    status: "ok",
    failure_reason: null,
    listings_seen: 118,
    last_ok_at: "2026-08-20T00:00:00.000Z",
    last_read_at: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

Deno.test("every extension-mechanism channel appears, even with no state row", () => {
  const channels = projectSyncChannels([], {}, {});
  assertEquals(channels.length, SYNC_PLATFORMS.length);
  for (const p of SYNC_PLATFORMS) {
    assert(channels.some((c) => c.platform === p), `channel missing: ${p}`);
  }
});

Deno.test("a channel that has never synced reads NEVER, not ok", () => {
  // The distinction that stops a seller concluding sync works when the content
  // script has never once run.
  const channels = projectSyncChannels([], {}, {});
  for (const c of channels) {
    assertEquals(c.status, "never");
    assertEquals(c.last_read_at, null);
  }
});

Deno.test("the platform list is DERIVED, so adding a delist platform adds a channel", () => {
  // Not a restated list. US-2479/US-2480 drifted exactly this way.
  const channels = projectSyncChannels([], {}, {});
  assertEquals(
    channels.map((c) => c.platform).sort(),
    [...SYNC_PLATFORMS].sort(),
  );
});

Deno.test("a failing channel carries its reason", () => {
  const channels = projectSyncChannels(
    [state({ status: "failing", failure_reason: "The closet read returned no listings." })],
    {},
    {},
  );
  const posh = channels.find((c) => c.platform === "poshmark")!;
  assertEquals(posh.status, "failing");
  assertEquals(posh.failure_reason, "The closet read returned no listings.");
});

Deno.test("a healthy channel never carries a stale failure reason", () => {
  // A reason left beside an ok status reads as a live problem that is already
  // solved, and the seller goes looking for something that is not there.
  const channels = projectSyncChannels(
    [state({ status: "ok", failure_reason: "an old failure" })],
    {},
    {},
  );
  assertEquals(channels.find((c) => c.platform === "poshmark")!.failure_reason, null);
});

Deno.test("an unrecognised status reads as never-synced, not as healthy", () => {
  const channels = projectSyncChannels([state({ status: "weird-new-value" })], {}, {});
  assertEquals(channels.find((c) => c.platform === "poshmark")!.status, "never");
});

Deno.test("open reviews and live listings are counted per channel", () => {
  const channels = projectSyncChannels(
    [state()],
    { poshmark: 3, mercari: 1 },
    { poshmark: 118, mercari: 40 },
  );
  const posh = channels.find((c) => c.platform === "poshmark")!;
  const merc = channels.find((c) => c.platform === "mercari")!;
  assertEquals(posh.open_reviews, 3);
  assertEquals(posh.live_listings, 118);
  assertEquals(merc.open_reviews, 1);
  assertEquals(merc.live_listings, 40);
  const grailed = channels.find((c) => c.platform === "grailed")!;
  assertEquals(grailed.open_reviews, 0);
  assertEquals(grailed.live_listings, 0);
});

Deno.test("a not-signed-in channel is distinct from a failing one", () => {
  // Different problems with different fixes: one is "log in", the other is
  // "our selectors broke". Collapsing them sends the seller after the wrong one.
  const channels = projectSyncChannels(
    [state({ status: "not_signed_in", failure_reason: "login wall" })],
    {},
    {},
  );
  const posh = channels.find((c) => c.platform === "poshmark")!;
  assertEquals(posh.status, "not_signed_in");
  assertEquals(posh.failure_reason, "login wall");
});

// ── one answer, two doors ──────────────────────────────────────────────────

Deno.test("both surfaces read the shared lib rather than their own query", async () => {
  const saas = await Deno.readTextFile(
    new URL("../routes/flipdesk-sync.ts", import.meta.url),
  );
  const extension = await Deno.readTextFile(
    new URL("../routes/public-grading.ts", import.meta.url),
  );

  for (const [name, src] of [["flipdesk-sync.ts", saas], ["public-grading.ts", extension]]) {
    assert(
      src.includes("loadSyncStatus"),
      `${name} does not call loadSyncStatus — a second door must not become a second answer`,
    );

    // READS are what must be shared, not writes. The observations handler in
    // flipdesk-sync.ts legitimately UPSERTS the state row on every read; the
    // first version of this guard banned the table name outright and fired on
    // that, which is a guard that fires on correct code and therefore a guard
    // someone deletes. So: no `.select(` against the state table outside the lib.
    const marker = 'from("marketplace_sync_state")';
    let at = src.indexOf(marker);
    while (at !== -1) {
      const window = src.slice(at, at + 240);
      assert(
        !window.includes(".select("),
        `${name} SELECTs from marketplace_sync_state directly. The read lives in ` +
          `lib/sync-status.ts once, for the reason recorded in lib/pending-delists.ts.`,
      );
      at = src.indexOf(marker, at + marker.length);
    }
  }
});

Deno.test("the one-answer guard can actually fail (self-check)", () => {
  // The passivity guard in the extension shipped unmatchable for an hour, so
  // every source-scan rule here proves it can fire before it is trusted.
  const offending = 'supabaseAdmin.from("marketplace_sync_state").select("platform")';
  const marker = 'from("marketplace_sync_state")';
  const at = offending.indexOf(marker);
  assert(at !== -1);
  assert(
    offending.slice(at, at + 240).includes(".select("),
    "the read-detection window no longer spots a direct select",
  );

  // And a legitimate write is NOT caught.
  const legitimate = 'supabaseAdmin.from("marketplace_sync_state").upsert({ user_id: id })';
  const w = legitimate.indexOf(marker);
  assert(
    !legitimate.slice(w, w + 240).includes(".select("),
    "the guard fires on an upsert, which is the false positive it was rewritten to avoid",
  );
});
