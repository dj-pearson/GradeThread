# Cross-listing: List Everywhere + Sale-Triggered Delist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button queues a listing to every extension marketplace with a gap between posts, every channel shows its state and marketplace link, and recording a sale ends every other listing.

**Architecture:** Nothing new is invented. The Listing Kit calls the existing `POST /cross-push`, which already creates sibling rows and enqueues `list` jobs for extension channels. A server-side skip guard stops re-listing a live or already-queued channel. The extension paces `list` jobs with a one-shot alarm. Record Sale moves from client-side Supabase writes to an edge route that calls the existing `autoEndCrossListings` sibling planner. A pure `deriveChannelState` feeds the kit tabs, the item page card and the composer.

**Tech Stack:** React 19 + TypeScript (vitest), Deno/Hono edge (`deno test`), MV3 extension in plain JS (node `.test.cjs` harness via `node scripts/test-extensions.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-11-crosslist-list-everywhere-and-sold-delist-design.md`

## Global Constraints

- No migration. Every column used exists (`extension_work_queue`, `listings.listing_url`, `listings.delist_requested_at`, `sales`).
- Every edge query on a multi-tenant table is scoped `.eq("user_id", ownerId)` or via an owner-verified parent (US-268). New route gets a `tenant-isolation_test.ts` case.
- The queued sentence is `QUEUED_NOTICE`, verbatim, from `src/hooks/use-extension-queue.ts`. Never say "listed" or "ended" for a queued job.
- NEVER use `.or(...)` on a supabase-js UPDATE/DELETE (US-1552). `.or()` on SELECT is fine.
- Stage files by name (`git add <path>`), never `git add -A`.
- Plain ASCII in code and commit subjects. No em dashes anywhere.
- No `border-left` accent rails, no gradient text, no bounce easing in UI (`npm run ui:check` is zero-baseline).
- Icons from `lucide-react` only; toasts via `sonner`.
- Commit trailer, exactly once: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_01WNa9on22dso6jNRLyd1JNf`.
- Test commands: web `npx vitest run <file>`; edge `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/<file>`; extension `node scripts/test-extensions.mjs` (runs every `extension-unified/test/*.test.cjs`).

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/channel-state.ts` (new) | Pure: one listing row + queue items -> channel state |
| `src/lib/__tests__/channel-state.test.ts` (new) | The state table and precedence |
| `src/lib/sale-math.ts` (new) | Pure `computeNetProfit`, shared by dialog and pinned to the edge copy |
| `src/lib/__tests__/sale-math.test.ts` (new) | Formula + source-equality pin against the edge |
| `services/edge-functions/src/lib/cross-push.ts` | Add `planCrossPushSkip` + the guard before enqueue; `CrossPushOutcome.skipped` |
| `services/edge-functions/src/tests/cross-push-skip_test.ts` (new) | The skip rule |
| `services/edge-functions/src/routes/flipdesk-listings.ts:193-220,339-357` | Carry `skipped` into `PlatformPushResult` |
| `services/edge-functions/src/routes/flipdesk-automations.ts:1040-1058` | Treat a skip as a no-op success |
| `services/edge-functions/src/lib/cross-listings.ts` | Export `queueExtensionDelist`; `siblingSelector` anchor fix |
| `services/edge-functions/src/tests/cross-listings-anchor_test.ts` (new) | `siblingSelector` |
| `services/edge-functions/src/lib/listing-lifecycle.ts:488-525` | Enqueue on manual End |
| `services/edge-functions/src/lib/record-sale.ts` (new) | `computeNetProfit`, `planSoldListingUpdate`, `recordSale` |
| `services/edge-functions/src/tests/record-sale_test.ts` (new) | Pure halves |
| `services/edge-functions/src/routes/flipdesk-sales.ts` (new) | `POST /api/flipdesk/sales/record` |
| `services/edge-functions/src/main.ts:1441` | Mount the route |
| `services/edge-functions/src/tests/tenant-isolation_test.ts` | One case: user B cannot record a sale on user A's item |
| `src/components/flipdesk/record-sale-dialog.tsx` | "Sold on" select; call the route; toast the summary |
| `extension-unified/lister/job-store.js` | `pacingHold`, `nextListDrainAt`, `PACING` constants |
| `extension-unified/test/lister-pacing.test.cjs` (new) | Pacing rules |
| `extension-unified/background.js` | Pacing alarm, `"paced"` drain code, options read |
| `extension-unified/options.html`, `options.js` | "Gap between cross-posts" select |
| `extension-unified/queue/worker-state.js`, `worker.js` | Status line during a hold |
| `src/hooks/use-cross-listing.ts` | `skipped` on the response type |
| `src/components/flipdesk/listing-kit.tsx` | Checklist + List everywhere; per-tab marker; status row; relabel |
| `src/components/flipdesk/cross-listings-card.tsx` (new) | Item page card for non-eBay rows |
| `src/components/flipdesk/pending-delist-banner.tsx` | Optional `itemId` filter |
| `src/pages/flipdesk/item.tsx:281`, `src/pages/flipdesk/composer.tsx:3914` | Render points |

---

### Task 1: `deriveChannelState` (pure, web)

**Files:**
- Create: `src/lib/channel-state.ts`
- Test: `src/lib/__tests__/channel-state.test.ts`

**Interfaces:**
- Consumes: `ItemListingRow` from `src/hooks/use-item-listings.ts`, `ExtensionQueueItem` from `src/hooks/use-extension-queue.ts`.
- Produces: `export type ChannelState = "live" | "queued" | "delist_queued" | "prefilled" | "failed" | "ended" | "sold" | "none"`; `export interface ChannelStatus { state: ChannelState; row: ItemListingRow | null; queueItem: ExtensionQueueItem | null; url: string | null; since: string | null }`; `export function deriveChannelState(rows, queueItems, platform): ChannelStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/channel-state.test.ts
import { describe, expect, it } from "vitest";
import { deriveChannelState } from "@/lib/channel-state";
import type { ItemListingRow } from "@/hooks/use-item-listings";
import type { ExtensionQueueItem } from "@/hooks/use-extension-queue";

function row(over: Partial<ItemListingRow>): ItemListingRow {
  return {
    id: "l1", platform: "poshmark", listing_status: "draft", listing_url: null,
    listing_title: null, listing_description: null, listing_price: null, quantity: 1,
    platform_offer_id: null, platform_listing_id: null, batch_id: null,
    synced_to_ebay_at: null, platform_fields: null, publish_error: null,
    publish_failed_at: null, updated_at: "2026-09-10T00:00:00Z", ...over,
  };
}
function q(over: Partial<ExtensionQueueItem>): ExtensionQueueItem {
  return {
    id: "q1", kind: "list", platform: "poshmark", inventory_item_id: "i1",
    listing_id: "l1", payload: {}, status: "queued", attempts: 0, source: "web",
    claimed_at: null, completed_at: null, result: null,
    expires_at: "2026-09-18T00:00:00Z", created_at: "2026-09-11T00:00:00Z", ...over,
  };
}

describe("deriveChannelState", () => {
  it("is none with no row and no queue item", () => {
    expect(deriveChannelState([], [], "poshmark").state).toBe("none");
  });
  it("is live for an active row, carrying the url", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: "https://poshmark.com/listing/x" })], [], "poshmark");
    expect(s.state).toBe("live");
    expect(s.url).toBe("https://poshmark.com/listing/x");
  });
  it("is queued while a list job is queued or claimed", () => {
    expect(deriveChannelState([row({})], [q({ status: "queued" })], "poshmark").state).toBe("queued");
    expect(deriveChannelState([row({})], [q({ status: "claimed" })], "poshmark").state).toBe("queued");
  });
  it("is delist_queued when a delist job is pending, and it beats live", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: "https://poshmark.com/listing/x" })],
      [q({ kind: "delist", status: "queued" })], "poshmark");
    expect(s.state).toBe("delist_queued");
  });
  it("is delist_queued when the row is ended with a delist stamp and no queue item", () => {
    const s = deriveChannelState(
      [row({ listing_status: "ended", platform_fields: { delist_requested_at: "2026-09-11T00:00:00Z" } })],
      [], "poshmark");
    expect(s.state).toBe("delist_queued");
  });
  it("is prefilled for a draft row with no pending job", () => {
    expect(deriveChannelState([row({ listing_status: "draft" })], [], "poshmark").state).toBe("prefilled");
  });
  it("is failed when the latest queue item failed or expired, and that beats a draft row", () => {
    const s = deriveChannelState([row({ listing_status: "draft" })],
      [q({ status: "failed", result: { error: "login wall" } })], "poshmark");
    expect(s.state).toBe("failed");
    expect(s.queueItem?.result?.error).toBe("login wall");
    expect(deriveChannelState([row({})], [q({ status: "expired" })], "poshmark").state).toBe("failed");
  });
  it("an active row beats a stale done queue item", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: "https://poshmark.com/listing/x" })],
      [q({ status: "done" })], "poshmark");
    expect(s.state).toBe("live");
  });
  it("uses the newest queue item for the platform", () => {
    const s = deriveChannelState([row({})], [
      q({ id: "old", status: "failed", created_at: "2026-09-01T00:00:00Z" }),
      q({ id: "new", status: "queued", created_at: "2026-09-11T00:00:00Z" }),
    ], "poshmark");
    expect(s.state).toBe("queued");
    expect(s.queueItem?.id).toBe("new");
  });
  it("is ended / sold from the row status", () => {
    expect(deriveChannelState([row({ listing_status: "ended" })], [], "poshmark").state).toBe("ended");
    expect(deriveChannelState([row({ listing_status: "sold" })], [], "poshmark").state).toBe("sold");
  });
  it("ignores other platforms", () => {
    expect(deriveChannelState([row({ platform: "mercari", listing_status: "active" })],
      [q({ platform: "mercari" })], "poshmark").state).toBe("none");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/__tests__/channel-state.test.ts`
Expected: FAIL, cannot resolve `@/lib/channel-state`.

- [ ] **Step 3: Implement**

```ts
// src/lib/channel-state.ts
import type { ItemListingRow } from "@/hooks/use-item-listings";
import type { ExtensionQueueItem } from "@/hooks/use-extension-queue";
import { safeHref } from "@/lib/safe-url";

// One answer to "what is this item doing on this marketplace" for the kit
// tab, the item page card and the composer. Two inputs the pages already
// read: the item's listing rows and the seller's extension queue. Pure, so
// the precedence below is tested rather than guessed at three render sites.
export type ChannelState =
  | "live" | "queued" | "delist_queued" | "prefilled"
  | "failed" | "ended" | "sold" | "none";

export interface ChannelStatus {
  state: ChannelState;
  row: ItemListingRow | null;
  queueItem: ExtensionQueueItem | null;
  /** The marketplace page, only when the row has a usable https URL. */
  url: string | null;
  /** ISO time the state started, when known (row.updated_at / queue created_at). */
  since: string | null;
}

const PENDING = new Set(["queued", "claimed"]);
const FAILED = new Set(["failed", "expired"]);

function newest<T extends { created_at: string }>(items: T[]): T | null {
  return items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function deriveChannelState(
  rows: readonly ItemListingRow[],
  queueItems: readonly ExtensionQueueItem[],
  platform: string,
): ChannelStatus {
  const row = rows.find((r) => r.platform === platform) ?? null;
  const mine = queueItems.filter((it) => it.platform === platform);
  const delist = newest(mine.filter((it) => it.kind === "delist" && PENDING.has(it.status)));
  const list = newest(mine.filter((it) => it.kind === "list"));
  const url = safeHref(row?.listing_url);
  const base = { row, queueItem: null as ExtensionQueueItem | null, url, since: row?.updated_at ?? null };

  // Precedence, most urgent first. A delist in flight means the garment is
  // gone and the listing may still be live, which beats every other reading.
  if (delist) return { ...base, state: "delist_queued", queueItem: delist, since: delist.created_at };
  const stamped = Boolean((row?.platform_fields as { delist_requested_at?: unknown } | null)?.delist_requested_at);
  if (row?.listing_status === "ended" && stamped) return { ...base, state: "delist_queued" };
  if (list && PENDING.has(list.status)) return { ...base, state: "queued", queueItem: list, since: list.created_at };
  if (row?.listing_status === "active") return { ...base, state: "live" };
  if (list && FAILED.has(list.status)) return { ...base, state: "failed", queueItem: list, since: list.completed_at ?? list.created_at };
  if (row?.listing_status === "sold") return { ...base, state: "sold" };
  if (row?.listing_status === "ended") return { ...base, state: "ended" };
  if (row?.listing_status === "draft") return { ...base, state: "prefilled" };
  return { ...base, state: "none" };
}
```

Note: `listings.delist_requested_at` is a real column but `ItemListingRow` does not select it. Task 8 adds `delist_requested_at` to `COLUMNS` and the interface in `src/hooks/use-item-listings.ts`; until then the `platform_fields` read above is the fallback. In Task 8, change the `stamped` line to `Boolean(row?.delist_requested_at)` and update the test to set `delist_requested_at` on the row instead of `platform_fields`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/channel-state.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channel-state.ts src/lib/__tests__/channel-state.test.ts
git commit -m "feat(flipdesk): one derivation of a channel's state for the kit and the item page (US-3367)"
```

---

### Task 2: Cross-push refuses to re-list a live or already-queued channel (edge)

**Files:**
- Modify: `services/edge-functions/src/lib/cross-push.ts:74-96` (outcome type), `:174-187` (select), `:323-349` (guard)
- Modify: `services/edge-functions/src/routes/flipdesk-listings.ts:120-137,193-220,339-357`
- Modify: `services/edge-functions/src/routes/flipdesk-automations.ts:1040-1058`
- Modify: `src/hooks/use-cross-listing.ts:9-24`
- Test: `services/edge-functions/src/tests/cross-push-skip_test.ts`

**Interfaces:**
- Produces: `export type CrossPushSkip = "already_live" | "already_queued"`; `export function planCrossPushSkip(existing: { listing_status: string | null; listing_url: string | null } | null, pendingListJob: boolean): CrossPushSkip | null`; `CrossPushOutcome.skipped?: CrossPushSkip`; `PlatformPushResult.skipped?: CrossPushSkip`; `CrossPushPlatformResult.skipped?: "already_live" | "already_queued"` (web).

- [ ] **Step 1: Write the failing test**

```ts
// services/edge-functions/src/tests/cross-push-skip_test.ts
import { assertEquals } from "@std/assert";
import { planCrossPushSkip } from "../lib/cross-push.ts";

Deno.test("a live sibling with a URL is skipped as already_live", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "active", listing_url: "https://poshmark.com/listing/x" }, false),
    "already_live",
  );
});

Deno.test("a pending list job is skipped as already_queued", () => {
  assertEquals(planCrossPushSkip({ listing_status: "draft", listing_url: null }, true), "already_queued");
});

Deno.test("a draft without a URL is NOT skipped", () => {
  assertEquals(planCrossPushSkip({ listing_status: "draft", listing_url: null }, false), null);
});

Deno.test("an active row with no URL is NOT skipped: nothing verified it went live", () => {
  assertEquals(planCrossPushSkip({ listing_status: "active", listing_url: null }, false), null);
});

Deno.test("an ended row is NOT skipped: a relist is allowed", () => {
  assertEquals(planCrossPushSkip({ listing_status: "ended", listing_url: "https://poshmark.com/listing/x" }, false), null);
});

Deno.test("no row at all is not skipped", () => {
  assertEquals(planCrossPushSkip(null, false), null);
});

Deno.test("already_live wins over already_queued", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "active", listing_url: "https://poshmark.com/listing/x" }, true),
    "already_live",
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/cross-push-skip_test.ts`
Expected: FAIL, `planCrossPushSkip` is not exported.

- [ ] **Step 3: Implement in `cross-push.ts`**

Add after the `CrossPushOutcome` interface (line 96):

```ts
/** Why an extension channel was NOT queued this push. */
export type CrossPushSkip = "already_live" | "already_queued";

/**
 * Should this push leave the channel alone?
 *
 * Re-queueing a channel whose listing is already live opens the create form
 * again in the seller's browser and mints a DUPLICATE listing; re-queueing one
 * with a job already waiting runs the fill twice. Both were possible before,
 * because the enqueue below was unconditional. Pure so the rule is tested;
 * the caller supplies the two facts.
 *
 * An `active` row with NO url is not skipped: nothing ever verified it went
 * live, and the writeback only promotes a row on a captured URL or the
 * seller's own say-so, so a URL-less active row is a claim, not a listing.
 */
export function planCrossPushSkip(
  existing: { listing_status: string | null; listing_url: string | null } | null,
  pendingListJob: boolean,
): CrossPushSkip | null {
  if (existing?.listing_status === "active" && existing.listing_url) return "already_live";
  if (pendingListJob) return "already_queued";
  return null;
}
```

Add `skipped?: CrossPushSkip;` to `CrossPushOutcome` (after `queued?: boolean;`).

Widen the sibling select at line 176 from `"id, platform_fields"` to `"id, platform_fields, listing_status, listing_url"` and the `existingRow` type to include `listing_status: string | null; listing_url: string | null`.

Replace the block starting `if (EXTENSION_DELIST_PLATFORMS.has(platform)) {` (line 323) with:

```ts
  if (EXTENSION_DELIST_PLATFORMS.has(platform)) {
    // US-3367: do not queue what is already live or already waiting.
    const { data: pending } = await supabaseAdmin
      .from("extension_work_queue")
      .select("id")
      .eq("user_id", ownerId) // US-268
      .eq("listing_id", rowId)
      .eq("kind", "list")
      .in("status", ["queued", "claimed"])
      .limit(1)
      .maybeSingle();
    const skipped = planCrossPushSkip(
      existingRow ? { listing_status: existingRow.listing_status, listing_url: existingRow.listing_url } : null,
      Boolean(pending),
    );
    if (skipped) {
      return {
        result: { ok: true, listingUrl: existingRow?.listing_url ?? undefined },
        listingRowId: rowId,
        price: mapped.listing_price,
        queued: skipped === "already_queued",
        skipped,
      };
    }
    const enqueued = await enqueueExtensionWork(ownerId, {
      kind: "list",
      platform,
      inventory_item_id: draft.inventory_item_id,
      listing_id: rowId,
      payload: {},
      source: "cross_push",
    });
    // ... existing body unchanged from here
```

Check `AdapterResult` accepts `listingUrl` on the ok branch (it does: `toPushResult` reads `res.listingUrl`). If the type is narrower, use `{ ok: true }` and pass the URL through `listing_url` in the route from `existingRow` instead.

- [ ] **Step 4: Carry `skipped` through the route and the automation**

`flipdesk-listings.ts`: add `skipped?: "already_live" | "already_queued";` to `PlatformPushResult` (after `queued?`), add a fifth parameter `skipped?: "already_live" | "already_queued"` to `toPushResult` and include it in the ok branch (`skipped,`). At the call site (line 344) destructure `skipped` and pass it: `toPushResult(result, listingRowId, price, queued, skipped)`. The `markItemListed` gate stays `r?.ok && !r.queued`; add `&& !r.skipped` so an `already_live` skip does not re-advance (harmless, but keep the gate honest).

`flipdesk-automations.ts:1040`: destructure `{ result, skipped }` and, right after the `if (!result.ok)` block, add:

```ts
    if (skipped) {
      // US-3367: already live or already waiting on the desktop. Not a failure
      // and not a publish; the rule converged, which is what an hourly rule
      // should do.
      return false;
    }
```

`src/hooks/use-cross-listing.ts`: add `skipped?: "already_live" | "already_queued";` to `CrossPushPlatformResult`.

- [ ] **Step 5: Run the tests and the type checks**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/cross-push-skip_test.ts && deno check src/main.ts && deno lint src/lib/cross-push.ts`
Expected: 7 passed, check clean, lint clean.
Run: `npx tsc -b`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add services/edge-functions/src/lib/cross-push.ts services/edge-functions/src/tests/cross-push-skip_test.ts services/edge-functions/src/routes/flipdesk-listings.ts services/edge-functions/src/routes/flipdesk-automations.ts src/hooks/use-cross-listing.ts
git commit -m "fix(cross-push): never queue a channel that is already live or already waiting (US-3367)"
```

---

### Task 3: Manual End on an extension channel queues the job; the sibling planner includes the anchor (edge)

**Files:**
- Modify: `services/edge-functions/src/lib/cross-listings.ts:111-123` (select), `:361` (export)
- Modify: `services/edge-functions/src/lib/listing-lifecycle.ts:26-36` (imports), `:488-525`
- Test: `services/edge-functions/src/tests/cross-listings-anchor_test.ts`

**Interfaces:**
- Produces: `export function siblingSelector(draftId: string): string` in `cross-listings.ts` (the `.or()` filter string); `export async function queueExtensionDelist(ownerId: string, row: SiblingRow): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// services/edge-functions/src/tests/cross-listings-anchor_test.ts
import { assertEquals, assertMatch } from "@std/assert";
import { siblingSelector } from "../lib/cross-listings.ts";

// US-3367 B2. The extension writeback points a Poshmark row's draft_id at the
// eBay draft, but the eBay draft's own draft_id is null unless a cross-push
// ever ran ensureCrossListingGroup. A filter on draft_id alone therefore
// misses the anchor, and a Poshmark sale left eBay live.
Deno.test("the sibling filter matches members AND the anchor", () => {
  const f = siblingSelector("11111111-2222-3333-4444-555555555555");
  assertEquals(f, "draft_id.eq.11111111-2222-3333-4444-555555555555,id.eq.11111111-2222-3333-4444-555555555555");
});

Deno.test("the filter is a PostgREST or-list with exactly two clauses", () => {
  const f = siblingSelector("abc");
  assertMatch(f, /^draft_id\.eq\.[^,]+,id\.eq\.[^,]+$/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/cross-listings-anchor_test.ts`
Expected: FAIL, `siblingSelector` not exported.

- [ ] **Step 3: Implement the anchor fix**

In `cross-listings.ts`, add above `autoEndCrossListings`:

```ts
/**
 * US-3367: the group is "rows whose draft_id is X" PLUS the anchor row X
 * itself. The writeback sets draft_id on the extension row but never on the
 * eBay draft it points at, so without the second clause a Poshmark sale
 * finds no eBay sibling. `.or()` on a SELECT is fine (US-1552 is about
 * mutations).
 */
export function siblingSelector(draftId: string): string {
  return `draft_id.eq.${draftId},id.eq.${draftId}`;
}
```

Replace `.eq("draft_id", draftId)` in the sibling query (line 120) with `.or(siblingSelector(draftId))`. The `.neq("id", soldListingId)` stays, so a sold anchor never ends itself.

Change `async function queueExtensionDelist(` (line 361) to `export async function queueExtensionDelist(`.

- [ ] **Step 4: Enqueue on manual End**

In `listing-lifecycle.ts`, add the import `import { queueExtensionDelist } from "./cross-listings.ts";` and `import { deliverExtensionWake } from "./notify.ts";`. Confirm no cycle: `cross-listings.ts` does not import `listing-lifecycle.ts` (verified: only `mcp-draft-tools.ts` and `mcp-lifecycle-tools.ts` do).

Inside the `if (method === "extension")` block, after the successful stamp and before `await endLocally(...)`:

```ts
    // US-3367: the stamp is the manual path (the banner). Also hand it to the
    // extension's background drain, exactly as a sale-triggered end does, so
    // "End listing" runs the next time a browser with the extension opens
    // instead of waiting for a click on the Listings page.
    await queueExtensionDelist(ownerId, {
      id: row.id,
      platform: row.platform ?? "",
      platform_offer_id: row.platform_offer_id ?? null,
      platform_listing_id: row.platform_listing_id ?? null,
      listing_status: row.listing_status ?? "",
      listing_url: row.listing_url ?? null,
      inventory_item_id: row.inventory_item_id,
      inventory_items: { user_id: ownerId, sku: null },
    });
    void deliverExtensionWake(ownerId);
```

Check `loadOwnedListing`'s returned row carries `platform_offer_id`, `platform_listing_id`, `listing_url`, `listing_status`, `inventory_item_id` (read its select near `listing-lifecycle.ts:100-140`); add any missing column to that select. `queueExtensionDelist` already dedupes and already refuses a row that is not `active` with a URL, and it never throws, so the End keeps its existing answer.

- [ ] **Step 5: Run tests and checks**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/cross-listings-anchor_test.ts src/tests/cross-listing-sale_test.ts src/tests/automation-end-listing_test.ts && deno check src/main.ts && deno lint src/lib/cross-listings.ts src/lib/listing-lifecycle.ts`
Expected: all pass, check and lint clean.

- [ ] **Step 6: Commit**

```bash
git add services/edge-functions/src/lib/cross-listings.ts services/edge-functions/src/lib/listing-lifecycle.ts services/edge-functions/src/tests/cross-listings-anchor_test.ts
git commit -m "fix(delist): manual End queues the extension job, and the sibling planner sees the group anchor (US-3367)"
```

---

### Task 4: Record a sale on the server and end every sibling (edge)

**Files:**
- Create: `services/edge-functions/src/lib/record-sale.ts`
- Create: `services/edge-functions/src/routes/flipdesk-sales.ts`
- Modify: `services/edge-functions/src/main.ts` (import near line 47; mount after line 1441)
- Modify: `services/edge-functions/src/tests/tenant-isolation_test.ts` (append one case)
- Test: `services/edge-functions/src/tests/record-sale_test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RecordSaleInput {
    inventory_item_id: string; listing_id: string | null;
    sale_price: number; shipping_collected: number; platform_fees: number;
    payment_processing_fees: number; shipping_cost: number; tax: number;
    other_costs: number; buyer_username: string | null; sale_date: string | null;
  }
  export function computeNetProfit(i: Omit<RecordSaleInput, "inventory_item_id" | "listing_id" | "buyer_username" | "sale_date">, purchasePrice: number): number
  export function planSoldListingUpdate(quantity: number | null): { quantity: number } | { listing_status: "sold"; is_active: false; quantity: 0 }
  export function parseRecordSaleBody(body: unknown): { ok: true; input: RecordSaleInput } | { ok: false; error: string }
  export interface RecordSaleResult { ok: true; sale_id: string; ended: number; queued: string[]; unresolved: string[]; nothing_live: number }
  export async function recordSale(ownerId: string, input: RecordSaleInput): Promise<{ status: number; body: RecordSaleResult | { error: string } }>
  ```
- Route: `POST /api/flipdesk/sales/record` -> `recordSale` body/status.

- [ ] **Step 1: Write the failing tests for the pure halves**

```ts
// services/edge-functions/src/tests/record-sale_test.ts
import { assertEquals } from "@std/assert";
import {
  computeNetProfit,
  parseRecordSaleBody,
  planSoldListingUpdate,
} from "../lib/record-sale.ts";

const fees = {
  sale_price: 40, shipping_collected: 5, platform_fees: 4, payment_processing_fees: 1.5,
  shipping_cost: 6, tax: 0, other_costs: 0.5,
};

Deno.test("net profit is price + shipping collected minus every cost and the cost basis", () => {
  assertEquals(computeNetProfit(fees, 10), 40 + 5 - 4 - 1.5 - 6 - 0 - 0.5 - 10);
});

Deno.test("a multi-unit listing decrements; the last unit marks it sold", () => {
  assertEquals(planSoldListingUpdate(3), { quantity: 2 });
  assertEquals(planSoldListingUpdate(1), { listing_status: "sold", is_active: false, quantity: 0 });
  assertEquals(planSoldListingUpdate(null), { listing_status: "sold", is_active: false, quantity: 0 });
  assertEquals(planSoldListingUpdate(0), { listing_status: "sold", is_active: false, quantity: 0 });
});

Deno.test("the body parser rejects a non-positive price and negative costs", () => {
  const bad1 = parseRecordSaleBody({ inventory_item_id: "11111111-1111-1111-1111-111111111111", sale_price: 0 });
  assertEquals(bad1.ok, false);
  const bad2 = parseRecordSaleBody({ inventory_item_id: "11111111-1111-1111-1111-111111111111", sale_price: 10, shipping_cost: -1 });
  assertEquals(bad2.ok, false);
});

Deno.test("the body parser fills omitted costs with 0 and keeps a null listing id", () => {
  const r = parseRecordSaleBody({ inventory_item_id: "11111111-1111-1111-1111-111111111111", sale_price: 12.5 });
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.input.listing_id, null);
  assertEquals(r.input.platform_fees, 0);
  assertEquals(r.input.sale_date, null);
});

Deno.test("the body parser rejects a malformed listing id rather than passing it to the DB", () => {
  const r = parseRecordSaleBody({ inventory_item_id: "11111111-1111-1111-1111-111111111111", sale_price: 1, listing_id: "../x" });
  assertEquals(r.ok, false);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/record-sale_test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/record-sale.ts`**

```ts
// services/edge-functions/src/lib/record-sale.ts
//
// US-3367: the Record Sale dialog used to write `sales`, `inventory_items` and
// `listings` straight from the browser and best-effort end the eBay listing.
// It never told autoEndCrossListings, so a sale recorded as "on Poshmark" left
// Mercari, Grailed and Vinted live. Now the browser sends the facts and this
// module does every write, then hands off to the sibling planner every API
// order path already uses.
//
// TENANCY (US-268): the item and, when given, the listing are owner-checked
// before anything is written.

import { supabaseAdmin } from "./supabase.ts";
import { attemptUpstreamDelist, autoEndCrossListings, type SiblingRow } from "./cross-listings.ts";
import { delistMethodFor } from "./cross-listing-sale.ts";

export interface RecordSaleInput {
  inventory_item_id: string;
  listing_id: string | null;
  sale_price: number;
  shipping_collected: number;
  platform_fees: number;
  payment_processing_fees: number;
  shipping_cost: number;
  tax: number;
  other_costs: number;
  buyer_username: string | null;
  /** YYYY-MM-DD from the dialog, or null for today. */
  sale_date: string | null;
}

export interface RecordSaleResult {
  ok: true;
  sale_id: string;
  ended: number;
  queued: string[];
  unresolved: string[];
  nothing_live: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST_KEYS = [
  "shipping_collected", "platform_fees", "payment_processing_fees",
  "shipping_cost", "tax", "other_costs",
] as const;

/**
 * The same formula the dialog previews. src/lib/sale-math.ts holds the
 * client copy and a test pins the two to the same answer.
 */
export function computeNetProfit(
  i: Pick<RecordSaleInput, "sale_price" | typeof COST_KEYS[number]>,
  purchasePrice: number,
): number {
  return i.sale_price + i.shipping_collected - i.platform_fees -
    i.payment_processing_fees - i.shipping_cost - i.tax - i.other_costs - purchasePrice;
}

/** A multi-quantity listing only ends when the last unit sells (US-1424 AC3). */
export function planSoldListingUpdate(
  quantity: number | null,
): { quantity: number } | { listing_status: "sold"; is_active: false; quantity: 0 } {
  const remaining = Math.max(0, (quantity ?? 1) - 1);
  return remaining > 0
    ? { quantity: remaining }
    : { listing_status: "sold", is_active: false, quantity: 0 };
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRecordSaleBody(
  body: unknown,
): { ok: true; input: RecordSaleInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const itemId = typeof b.inventory_item_id === "string" && UUID.test(b.inventory_item_id)
    ? b.inventory_item_id : "";
  if (!itemId) return { ok: false, error: "inventory_item_id is required." };
  let listingId: string | null = null;
  if (b.listing_id != null && b.listing_id !== "") {
    if (typeof b.listing_id !== "string" || !UUID.test(b.listing_id)) {
      return { ok: false, error: "listing_id must be a listing id." };
    }
    listingId = b.listing_id;
  }
  const price = num(b.sale_price);
  if (price === null || price <= 0) return { ok: false, error: "Enter a sale price greater than 0." };
  const costs: Record<string, number> = {};
  for (const k of COST_KEYS) {
    const v = num(b[k]);
    if (v === null || v < 0) return { ok: false, error: "Fees and costs can't be negative." };
    costs[k] = v;
  }
  const saleDate = typeof b.sale_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.sale_date)
    ? b.sale_date : null;
  return {
    ok: true,
    input: {
      inventory_item_id: itemId,
      listing_id: listingId,
      sale_price: price,
      shipping_collected: costs.shipping_collected,
      platform_fees: costs.platform_fees,
      payment_processing_fees: costs.payment_processing_fees,
      shipping_cost: costs.shipping_cost,
      tax: costs.tax,
      other_costs: costs.other_costs,
      buyer_username: typeof b.buyer_username === "string" && b.buyer_username.trim()
        ? b.buyer_username.trim().slice(0, 120) : null,
      sale_date: saleDate,
    },
  };
}

interface OwnedListing {
  id: string;
  platform: string;
  listing_status: string;
  quantity: number | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  listing_url: string | null;
  inventory_item_id: string | null;
}

export async function recordSale(
  ownerId: string,
  input: RecordSaleInput,
): Promise<{ status: number; body: RecordSaleResult | { error: string } }> {
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, status, purchase_price, sku")
    .eq("id", input.inventory_item_id)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  const item = itemRow as { id: string; status: string; purchase_price: number | null; sku: string | null } | null;
  if (!item) return { status: 404, body: { error: "Item not found." } };

  let sold: OwnedListing | null = null;
  if (input.listing_id) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("id, platform, listing_status, quantity, platform_offer_id, platform_listing_id, listing_url, inventory_item_id")
      .eq("id", input.listing_id)
      .eq("inventory_item_id", item.id)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    sold = data as OwnedListing | null;
    if (!sold) return { status: 404, body: { error: "Listing not found." } };
  }

  const saleDate = input.sale_date ?? new Date().toISOString().slice(0, 10);
  const { data: sale, error: saleErr } = await supabaseAdmin
    .from("sales")
    .insert({
      inventory_item_id: item.id,
      listing_id: sold?.id ?? null,
      sale_price: input.sale_price,
      shipping_collected: input.shipping_collected,
      platform_fees: input.platform_fees,
      payment_processing_fees: input.payment_processing_fees,
      shipping_cost: input.shipping_cost,
      tax: input.tax,
      other_costs: input.other_costs,
      net_profit: computeNetProfit(input, item.purchase_price ?? 0),
      buyer_username: input.buyer_username,
      sale_date: saleDate,
      sold_at: saleDate,
      status: "completed",
    })
    .select("id")
    .single();
  if (saleErr || !sale) {
    return { status: 500, body: { error: "Could not record the sale." } };
  }

  // The item advances to sold. Same write the client's advanceItemStatus made;
  // it is monotonic there and a sale is the terminal status here.
  await supabaseAdmin
    .from("inventory_items")
    .update({ status: "sold" })
    .eq("id", item.id)
    .eq("user_id", ownerId); // US-268

  let ended = 0;
  const unresolved = new Set<string>();
  const delistFrom: string[] = [];

  if (sold) {
    const patch = planSoldListingUpdate(sold.quantity);
    await supabaseAdmin.from("listings").update(patch).eq("id", sold.id).eq("user_id", ownerId);
    if ("listing_status" in patch) {
      // The sold row itself, on an API channel: usually already ended by the
      // marketplace, and the classifier treats "already gone" as success.
      const method = delistMethodFor(sold.platform);
      if (method !== "extension" && method !== "unsupported") {
        const out = await attemptUpstreamDelist(ownerId, toSibling(sold, ownerId, item.sku));
        if (out.kind === "ended") ended++;
        else if (out.kind === "unresolved") unresolved.add(sold.platform);
      }
      delistFrom.push(sold.id);
    }
  } else {
    // Sold in person or somewhere FlipDesk has no row for: pull every live
    // listing on the item, each through the same planner.
    const { data: live } = await supabaseAdmin
      .from("listings")
      .select("id")
      .eq("inventory_item_id", item.id)
      .eq("user_id", ownerId) // US-268
      .eq("listing_status", "active");
    for (const r of (live ?? []) as { id: string }[]) delistFrom.push(r.id);
    if (delistFrom.length > 0) {
      // Mark the first live row sold so the planner has a sold anchor; the
      // rest are its siblings.
      await supabaseAdmin.from("listings")
        .update({ listing_status: "sold", is_active: false, quantity: 0 })
        .eq("id", delistFrom[0]).eq("user_id", ownerId);
    }
  }

  const queued = new Set<string>();
  let nothingLive = 0;
  for (const id of delistFrom) {
    const s = await autoEndCrossListings(ownerId, id);
    ended += s.ended;
    nothingLive += s.nothingLive;
    if (s.queued > 0 || s.unresolved > 0) {
      // Names, not counts: the dialog says WHICH marketplaces the browser is
      // about to handle and which need the seller.
      const { data: rows } = await supabaseAdmin
        .from("listings")
        .select("platform, delist_requested_at, platform_fields")
        .eq("inventory_item_id", item.id)
        .eq("user_id", ownerId) // US-268
        .neq("id", id);
      for (const r of (rows ?? []) as { platform: string; delist_requested_at: string | null; platform_fields: Record<string, unknown> | null }[]) {
        if (r.platform_fields?.delist_unresolved) unresolved.add(r.platform);
        else if (r.delist_requested_at) queued.add(r.platform);
      }
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      sale_id: (sale as { id: string }).id,
      ended,
      queued: [...queued].sort(),
      unresolved: [...unresolved].sort(),
      nothing_live: nothingLive,
    },
  };
}

function toSibling(l: OwnedListing, ownerId: string, sku: string | null): SiblingRow {
  return {
    id: l.id,
    platform: l.platform,
    platform_offer_id: l.platform_offer_id,
    platform_listing_id: l.platform_listing_id,
    listing_status: l.listing_status,
    listing_url: l.listing_url,
    inventory_item_id: l.inventory_item_id,
    inventory_items: { user_id: ownerId, sku },
  };
}
```

Check `listings` has a `user_id` column usable in `.eq("user_id", ownerId)` (cross-push.ts uses it at line 182 citing migration 00146: yes). Check `sales.status` accepts `"completed"` (flipdesk-sync.ts inserts it: yes). `inventory_items.purchase_price` exists (`ItemFullRow.purchase_price` and the dialog reads it).

- [ ] **Step 4: The route and the mount**

```ts
// services/edge-functions/src/routes/flipdesk-sales.ts
import { Hono } from "hono";
import { parseRecordSaleBody, recordSale } from "../lib/record-sale.ts";

type Env = { Variables: { userId: string; workspaceOwnerId?: string } };

export const flipdeskSalesRoutes = new Hono<Env>();

// US-3367: POST /api/flipdesk/sales/record. The browser sends the facts of a
// sale; the server writes them and ends every other listing of the garment.
flipdeskSalesRoutes.post("/record", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = parseRecordSaleBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const out = await recordSale(ownerId, parsed.input);
  return c.json(out.body, out.status as 200);
});
```

Copy the `Env` type shape from `flipdesk-extension-queue.ts`'s header if it differs (it must match what the auth middleware sets). In `main.ts`, import next to line 47: `import { flipdeskSalesRoutes } from "./routes/flipdesk-sales.ts";` and mount after line 1441: `app.route("/api/flipdesk/sales", flipdeskSalesRoutes);`. Check the surrounding lines for the auth middleware pattern: if `/api/flipdesk/listings` is protected by an `app.use("/api/flipdesk/*", requireAuth...)` wildcard the new prefix is covered; if each prefix is listed individually, add `/api/flipdesk/sales/*` to the same list and to the rate limiter at line 1157 (`rateLimiter(30, 60_000, "flipdesk-sales")`).

- [ ] **Step 5: Tenant-isolation case**

Append to `services/edge-functions/src/tests/tenant-isolation_test.ts`:

```ts
Deno.test({
  // US-3367: the sale route takes ids from the body and writes sales,
  // inventory_items and listings with the service-role client.
  name: "user B cannot record a sale on user A's item",
  ignore: !CONFIGURED,
  fn: async () => {
    const res = await fetch(`${BASE}/api/flipdesk/sales/record`, {
      method: "POST",
      headers: authHeaders(B_JWT!),
      body: JSON.stringify({
        inventory_item_id: Deno.env.get("TEST_USER_A_ITEM_ID") ?? "11111111-1111-1111-1111-111111111111",
        listing_id: Deno.env.get("TEST_USER_A_LISTING_ID") ?? null,
        sale_price: 1,
      }),
    });
    await res.body?.cancel();
    assertDenied(res.status, "POST /api/flipdesk/sales/record");
  },
});
```

- [ ] **Step 6: Run tests and checks**

Run: `cd services/edge-functions && deno test --allow-env --allow-read --allow-net src/tests/record-sale_test.ts && deno check src/main.ts && deno lint src/lib/record-sale.ts src/routes/flipdesk-sales.ts && env -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u EDGE_ENV deno test --allow-env --allow-read --allow-net src/tests/tenant-isolation_test.ts 2>&1 | tail -3`
Expected: 5 passed; check and lint clean; tenant suite reports ignored (no fixture) with no failures.

- [ ] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/record-sale.ts services/edge-functions/src/routes/flipdesk-sales.ts services/edge-functions/src/main.ts services/edge-functions/src/tests/record-sale_test.ts services/edge-functions/src/tests/tenant-isolation_test.ts
git commit -m "feat(sales): record a sale on the server and end every sibling listing (US-3367)"
```

---

### Task 5: Record Sale dialog asks where it sold and reports what is being ended (web)

**Files:**
- Create: `src/lib/sale-math.ts`
- Test: `src/lib/__tests__/sale-math.test.ts`
- Modify: `src/components/flipdesk/record-sale-dialog.tsx`

**Interfaces:**
- Consumes: `POST /api/flipdesk/sales/record` (Task 4), `useItemListings` (`src/hooks/use-item-listings.ts`), `MARKETPLACE_LABELS` (`src/lib/constants.ts`), `requestDrainNow` (`src/lib/lister-extension.ts`), `QUEUED_NOTICE`.
- Produces: `export function computeNetProfit(i: SaleMoney, purchasePrice: number): number` where `SaleMoney = { sale_price; shipping_collected; platform_fees; payment_processing_fees; shipping_cost; tax; other_costs }` (all numbers).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/sale-math.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeNetProfit } from "@/lib/sale-math";

describe("computeNetProfit", () => {
  it("is price plus shipping collected minus every cost and the cost basis", () => {
    expect(computeNetProfit({
      sale_price: 40, shipping_collected: 5, platform_fees: 4, payment_processing_fees: 1.5,
      shipping_cost: 6, tax: 0, other_costs: 0.5,
    }, 10)).toBeCloseTo(23);
  });

  it("is the same formula the edge uses (record-sale.ts)", () => {
    const web = readFileSync("src/lib/sale-math.ts", "utf8");
    const edge = readFileSync("services/edge-functions/src/lib/record-sale.ts", "utf8");
    const formula = /return i\.sale_price \+ i\.shipping_collected - i\.platform_fees -\s*i\.payment_processing_fees - i\.shipping_cost - i\.tax - i\.other_costs - purchasePrice;/;
    expect(web).toMatch(formula);
    expect(edge).toMatch(formula);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/__tests__/sale-math.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `sale-math.ts`**

```ts
// src/lib/sale-math.ts
// The net-profit preview in the Record Sale dialog. The edge writes the real
// number (services/edge-functions/src/lib/record-sale.ts) with the same
// expression; sale-math.test.ts pins the two by source so they cannot drift.
export interface SaleMoney {
  sale_price: number;
  shipping_collected: number;
  platform_fees: number;
  payment_processing_fees: number;
  shipping_cost: number;
  tax: number;
  other_costs: number;
}

export function computeNetProfit(i: SaleMoney, purchasePrice: number): number {
  return i.sale_price + i.shipping_collected - i.platform_fees -
    i.payment_processing_fees - i.shipping_cost - i.tax - i.other_costs - purchasePrice;
}
```

Run: `npx vitest run src/lib/__tests__/sale-math.test.ts` -> 2 passed.

- [ ] **Step 4: Rewrite the dialog**

In `record-sale-dialog.tsx`:

Replace the imports `supabase`, `advanceItemStatus`, `useEbayConnection`, `useEbayEndListing`, `SaleInsert` with:

```ts
import { edgeFetch } from "@/lib/edge-fetch";
import { computeNetProfit } from "@/lib/sale-math";
import { useItemListings } from "@/hooks/use-item-listings";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { requestDrainNow } from "@/lib/lister-extension";
import { QUEUED_NOTICE } from "@/hooks/use-extension-queue";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
```

Keep `ItemFullRow`. Add state `const [soldOn, setSoldOn] = useState<string>("");` and the read `const { data: listingRows = [] } = useItemListings(item?.id);`. In the `useEffect` that seeds the form, also seed `soldOn`:

```ts
      const active = listingRows.filter((r) => r.listing_status === "active");
      const ebay = listingRows.find((r) => r.platform === "ebay");
      setSoldOn(active.length === 1 ? active[0].id : ebay?.id ?? "");
```

(add `listingRows` to the effect's dependency list). Replace the `net` memo body with `computeNetProfit({ sale_price: n(form.sale_price), ... }, item.purchase_price ?? 0)`.

Replace the whole `try { ... } catch` inside `save()` with:

```ts
    try {
      const res = await edgeFetch("/api/flipdesk/sales/record", {
        method: "POST",
        json: {
          inventory_item_id: item.id,
          listing_id: soldOn || null,
          sale_price: n(form.sale_price),
          shipping_collected: n(form.shipping_collected),
          platform_fees: n(form.platform_fees),
          payment_processing_fees: n(form.payment_processing_fees),
          shipping_cost: n(form.shipping_cost),
          tax: n(form.tax),
          other_costs: n(form.other_costs),
          buyer_username: form.buyer_username.trim() || null,
          sale_date: form.sale_date || null,
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string; queued?: string[]; unresolved?: string[];
      };
      if (!res.ok) throw new Error(json.error ?? "Failed.");

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sale_for_item", item.id] });
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", item.id] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });

      const label = (p: string) => MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
      const queued = (json.queued ?? []).map(label);
      const unresolved = (json.unresolved ?? []).map(label);
      toast.success(`Sale recorded for "${item.item_title}".`);
      if (queued.length > 0) {
        // Deliberately not "ended": the listing is live until the browser runs it.
        toast.info(`Ending it on ${queued.join(", ")} from your browser. ${QUEUED_NOTICE}`, { duration: 12_000 });
        void requestDrainNow();
      }
      if (unresolved.length > 0) {
        toastWarning(null, `${unresolved.join(", ")} needs you: end it there so it cannot sell twice.`, { duration: 12_000 });
      }
      onClose();
    } catch (err) {
      toastError(err, "Failed.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
```

Check `toastWarning`'s first parameter type in `src/lib/toast-error.ts`; if it requires an `unknown` error, pass `undefined`. Add the select to the grid, first cell, spanning two columns:

```tsx
          <div className="col-span-2 space-y-1">
            <Label className="text-xs" htmlFor="sold-on">Sold on</Label>
            <Select value={soldOn || "none"} onValueChange={(v) => setSoldOn(v === "none" ? "" : v)}>
              <SelectTrigger id="sold-on"><SelectValue placeholder="Where did it sell?" /></SelectTrigger>
              <SelectContent>
                {listingRows.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {MARKETPLACE_LABELS[r.platform as ListingPlatform] ?? r.platform}
                    {r.listing_status === "active" ? "" : ` (${r.listing_status ?? "draft"})`}
                  </SelectItem>
                ))}
                <SelectItem value="none">Somewhere else / in person</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Every other listing of this item is ended for you. Marketplaces
              without an API are ended from your own browser.
            </p>
          </div>
```

Update the `DialogDescription` to: `Log the sale of "{item.item_title}". The item moves to Sold and its other listings are ended.`

- [ ] **Step 5: Type-check, lint, existing guards**

Run: `npx tsc -b && npx eslint src/components/flipdesk/record-sale-dialog.tsx src/lib/sale-math.ts && npx vitest run src/lib/__tests__/composer-locks.test.ts src/lib/__tests__/sale-math.test.ts`
Expected: exit 0 everywhere; `composer-locks.test.ts` still finds `<RecordSaleDialog`.
Run: `npm run ui:check` -> 0 blocking.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sale-math.ts src/lib/__tests__/sale-math.test.ts src/components/flipdesk/record-sale-dialog.tsx
git commit -m "feat(sales): Record Sale asks where it sold and reports which listings are being ended (US-3367)"
```

---

### Task 6: Pace list jobs in the extension

**Files:**
- Modify: `extension-unified/lister/job-store.js` (add after `drainClaimLimit`, ~line 405; export in the `self.GT_LISTER_JOBS = {...}` block at the bottom)
- Modify: `extension-unified/background.js:1918-1919` (constants), `:2011-2034` (reportJob), `:2539-2566` (drainQueue), `:3162-3210` (alarm handler)
- Modify: `extension-unified/options.html:82-98`, `extension-unified/options.js:58-90`
- Modify: `extension-unified/queue/worker-state.js:200-212`, `extension-unified/worker.js:97-99`
- Test: `extension-unified/test/lister-pacing.test.cjs`

**Interfaces:**
- Produces (on `self.GT_LISTER_JOBS`): `PACING = { DEFAULT_GAP_MS: 30000, JITTER_MS: 15000, MIN_GAP_MS: 0, MAX_GAP_MS: 120000, OPTIONS_MS: [15000, 30000, 60000, 120000] }`; `pacingGapFor(optionMs)`; `nextListDrainAt(settledAt, gapMs, jitterMs, rng)`; `pacingHold(state, now)` returning `{ held: boolean, until: number|null }` where `state = { nextListDrainAt: number|null }`.
- `background.js`: storage key `gtPacingGapMs` (seller option), `gtNextListDrainAt` (scheduled time), alarm `gt-lister-paced-drain`. `drainQueue()` gains the return code `"paced"`. `GT_WORKER_STATE` response gains `pacedUntil: number | null`.

- [ ] **Step 1: Write the failing test**

```js
// extension-unified/test/lister-pacing.test.cjs
// US-3367: a gap between cross-posts. Delists are never paced.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadJobs() {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "lister", "job-store.js"), "utf8");
  const selfObj = {};
  new Function("self", src)(selfObj);
  return selfObj.GT_LISTER_JOBS;
}
const J = loadJobs();

assert.deepStrictEqual(J.PACING.OPTIONS_MS, [15000, 30000, 60000, 120000], "the four options the page offers");
assert.strictEqual(J.PACING.DEFAULT_GAP_MS, 30000);

// pacingGapFor: an unknown or absent option is the default; a listed one is itself.
assert.strictEqual(J.pacingGapFor(undefined), 30000);
assert.strictEqual(J.pacingGapFor("banana"), 30000);
assert.strictEqual(J.pacingGapFor(60000), 60000);
assert.strictEqual(J.pacingGapFor(999), 30000, "not one of the options: default");

// nextListDrainAt: settled + gap +/- jitter, never earlier than settled + gap - jitter, never below settled.
const T = 1_000_000;
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 0.5), T + 30000, "rng 0.5 is no jitter");
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 0), T + 15000, "rng 0 is minus jitter");
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 1), T + 45000, "rng 1 is plus jitter");
assert.strictEqual(J.nextListDrainAt(T, 5000, 15000, () => 0), T, "never before the settle time");
assert.strictEqual(J.nextListDrainAt(null, 30000, 15000, () => 0.5), null, "no settle time: no hold");

// pacingHold: held only while now < nextListDrainAt.
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: T + 100 }, T), { held: true, until: T + 100 });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: T + 100 }, T + 100), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: null }, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({}, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold(null, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: "soon" }, T), { held: false, until: null }, "garbage is not a hold");

// pacesAfter: only a list job schedules a gap.
assert.strictEqual(J.pacesAfter({ kind: "list" }), true);
assert.strictEqual(J.pacesAfter({ kind: "delist" }), false);
assert.strictEqual(J.pacesAfter({ kind: "revise" }), false);
assert.strictEqual(J.pacesAfter({ kind: "relist" }), false);
assert.strictEqual(J.pacesAfter(null), false);

console.log("lister-pacing: ok");
```

- [ ] **Step 2: Run to see it fail**

Run: `node extension-unified/test/lister-pacing.test.cjs`
Expected: throws, `J.PACING` undefined.

- [ ] **Step 3: Implement in `job-store.js`**

Add after `drainClaimLimit`:

```js
  // ── US-3367: a gap between cross-posts ─────────────────────────────────────
  //
  // A queue of six listings used to run back to back: one settles, the next
  // opens. Marketplaces read that as a machine. A LIST job therefore schedules
  // the next drain a little later, with jitter so the gaps are not identical.
  // A DELIST is never paced: the garment is sold and the listing is live, and
  // every second of gap is a second a buyer can pay for it twice.
  var PACING = {
    DEFAULT_GAP_MS: 30000,
    JITTER_MS: 15000,
    MIN_GAP_MS: 0,
    MAX_GAP_MS: 120000,
    OPTIONS_MS: [15000, 30000, 60000, 120000],
  };

  /** The seller's option, or the default when it is not one of the offered values. */
  function pacingGapFor(optionMs) {
    return PACING.OPTIONS_MS.indexOf(optionMs) >= 0 ? optionMs : PACING.DEFAULT_GAP_MS;
  }

  /** Only a list job earns a gap. */
  function pacesAfter(job) {
    return Boolean(job && job.kind === "list");
  }

  /**
   * When the next drain may run after a list job settled at `settledAt`.
   * `rng` returns [0, 1); 0.5 is no jitter. Never earlier than the settle
   * time, so a tiny gap with a big jitter cannot schedule into the past.
   */
  function nextListDrainAt(settledAt, gapMs, jitterMs, rng) {
    var t = (typeof settledAt === "number" && Number.isFinite(settledAt)) ? settledAt : null;
    if (t === null) return null;
    var gap = (typeof gapMs === "number" && Number.isFinite(gapMs)) ? gapMs : PACING.DEFAULT_GAP_MS;
    var jitter = (typeof jitterMs === "number" && Number.isFinite(jitterMs)) ? jitterMs : 0;
    var r = (typeof rng === "function") ? rng() : Math.random();
    var offset = gap + (r * 2 - 1) * jitter;
    return t + Math.max(0, Math.round(offset));
  }

  /** Is the drain inside a pacing gap right now? */
  function pacingHold(state, now) {
    var until = state && typeof state.nextListDrainAt === "number" && Number.isFinite(state.nextListDrainAt)
      ? state.nextListDrainAt
      : null;
    if (until === null || typeof now !== "number" || now >= until) return { held: false, until: null };
    return { held: true, until: until };
  }
```

Add to the exported object at the bottom of the file: `PACING: PACING, pacingGapFor: pacingGapFor, pacesAfter: pacesAfter, nextListDrainAt: nextListDrainAt, pacingHold: pacingHold,`.

Run: `node extension-unified/test/lister-pacing.test.cjs` -> `lister-pacing: ok`.

- [ ] **Step 4: Wire `background.js`**

Constants next to `SWEEP_ALARM` (line 1919):

```js
// US-3367: the gap between cross-posts. The scheduled time lives in
// storage.local because the worker is evicted between alarms.
const PACED_DRAIN_ALARM = "gt-lister-paced-drain";
const PACING_GAP_KEY = "gtPacingGapMs";
const NEXT_LIST_DRAIN_KEY = "gtNextListDrainAt";

async function readPacingGapMs() {
  const out = await ext.storage.local.get(PACING_GAP_KEY);
  return self.GT_LISTER_JOBS.pacingGapFor(out && out[PACING_GAP_KEY]);
}

async function readNextListDrainAt() {
  const out = await ext.storage.local.get(NEXT_LIST_DRAIN_KEY);
  const v = out && out[NEXT_LIST_DRAIN_KEY];
  return typeof v === "number" ? v : null;
}

/** Schedule the drain that follows a list job, and remember when. */
async function scheduleListDrain(settledAt) {
  const J = self.GT_LISTER_JOBS;
  const at = J.nextListDrainAt(settledAt, await readPacingGapMs(), J.PACING.JITTER_MS);
  if (at === null) return;
  await ext.storage.local.set({ [NEXT_LIST_DRAIN_KEY]: at });
  try { await ext.alarms.create(PACED_DRAIN_ALARM, { when: at }); } catch (_e) { /* the 5-minute sweep still runs it */ }
}
```

In `reportJob` (line 2030-2033) replace `void drainQueue();` with:

```js
    // US-3367: a list job earns a gap before the next one; everything else
    // looks for the next job immediately, as before.
    if (self.GT_LISTER_JOBS.pacesAfter(job)) {
      await scheduleListDrain(Date.now());
    } else {
      void drainQueue();
    }
```

In `drainQueue`, after `if (await workerPaused()) return "paused";` (line 2563) add:

```js
    // US-3367: inside a pacing gap. Checked BEFORE /claim, so a row is never
    // stamped claimed by a browser that is about to sit on it.
    const hold = self.GT_LISTER_JOBS.pacingHold(
      { nextListDrainAt: await readNextListDrainAt() }, Date.now(),
    );
    if (hold.held) return "paced";
```

In the alarm handler (before `if (name.indexOf(JOB_ALARM_PREFIX) !== 0) return;` at line 3202):

```js
    if (name === PACED_DRAIN_ALARM) {
      void drainQueue();
      return;
    }
```

In the `GT_WORKER_STATE` response (line 4189) add `pacedUntil: await readNextListDrainAt(),`. Check whether `drainQueue`'s return codes are enumerated in a test (`grep -n '"paused"' extension-unified/test/*.cjs`); add `"paced"` wherever the set is pinned.

- [ ] **Step 5: Options page**

`options.html`, inside the Cross-listing section after the worker button:

```html
        <label class="opt-toggle">
          <span>
            Gap between cross-posts
            <small>
              How long the worker waits after one listing before it starts the
              next. A gap makes the run look like a person, which it is.
              Ending a sold listing never waits.
            </small>
          </span>
          <select id="pacingGap" class="opt-select">
            <option value="15000">15 seconds</option>
            <option value="30000">30 seconds</option>
            <option value="60000">1 minute</option>
            <option value="120000">2 minutes</option>
          </select>
        </label>
```

Check `options.css` has an `.opt-select` rule; if not, add `.opt-select { font: inherit; padding: 4px 8px; }` there. `options.js`, after the worker block:

```js
  // US-3367: the pacing gap. storage.local, like every other option here.
  const { gtPacingGapMs } = await ext.storage.local.get("gtPacingGapMs");
  const gap = document.getElementById("pacingGap");
  if (gap) {
    gap.value = String([15000, 30000, 60000, 120000].includes(gtPacingGapMs) ? gtPacingGapMs : 30000);
    gap.addEventListener("change", async () => {
      const v = Number(gap.value);
      if (v === 30000) await ext.storage.local.remove("gtPacingGapMs");
      else await ext.storage.local.set({ gtPacingGapMs: v });
    });
  }
```

- [ ] **Step 6: Worker status line**

`worker-state.js` `statusLine`: after the pause branch add

```js
    if (typeof state.pacedUntil === "number" && num(now) !== null && now < state.pacedUntil) {
      return "Next cross-post in " + Math.ceil((state.pacedUntil - now) / 1000) + "s. Ending a sold listing never waits.";
    }
```

`worker.js`: wherever the page merges the `GT_WORKER_STATE` response into `state` (search `unsentResults`), also copy `pacedUntil`. Check `extension-unified/test/worker-tab.test.cjs` for a `statusLine` case and add one: `assert.strictEqual(W.statusLine({ running: true, lastDrainAt: T, pacedUntil: T + 10000 }, T + 2000), "Next cross-post in 8s. Ending a sold listing never waits.");`.

- [ ] **Step 7: Run every extension guard**

Run: `node scripts/test-extensions.mjs && npx eslint extension-unified/background.js extension-unified/options.js extension-unified/lister/job-store.js extension-unified/queue/worker-state.js extension-unified/worker.js`
Expected: all files pass (the count grows by one); eslint 0 errors (one pre-existing warning in `lister-empty-payload.test.cjs` is known).
Also run `node scripts/verify-lister-selectors.mjs` to confirm nothing touched selectors.

- [ ] **Step 8: Commit**

```bash
git add extension-unified/lister/job-store.js extension-unified/background.js extension-unified/options.html extension-unified/options.js extension-unified/options.css extension-unified/queue/worker-state.js extension-unified/worker.js extension-unified/test/lister-pacing.test.cjs extension-unified/test/worker-tab.test.cjs
git commit -m "feat(extension): a jittered gap between cross-posts; delists never wait (US-3367)"
```

---

### Task 7: Listing Kit: channel checklist, List everywhere, per-channel status row

**Files:**
- Modify: `src/hooks/use-item-listings.ts:21-57` (add `delist_requested_at`)
- Modify: `src/lib/channel-state.ts` (read the column; see Task 1 note)
- Modify: `src/components/flipdesk/listing-kit.tsx` (`PlatformPanel` props and header row; `ListingKit` header and tabs)
- Test: `src/test/listing-kit-list-everywhere.test.ts` (source guard, same style as `src/test/cross-post-setup.test.ts`)

**Interfaces:**
- Consumes: `deriveChannelState`, `useItemListings`, `useExtensionQueue`, `useCancelExtensionWork`, `useEnqueueExtensionWork`, `useCrossPush`, `useEndListing`, `useMarkDelistDone`, `requestDrainNow`, `MARKETPLACE_EXTENSION_FLOW`, `isListerPlatform`, `QUEUED_NOTICE`.
- Produces: `export function planListEverywhere(platforms, statuses): { checked: string[]; disabled: Record<string, string> }` in `src/lib/channel-state.ts` (pure; the checklist's defaults).

- [ ] **Step 1: Add `delist_requested_at` to the item listings read**

In `use-item-listings.ts` add `delist_requested_at: string | null;` to `ItemListingRow` and `"delist_requested_at",` to `COLUMNS`. In `channel-state.ts` replace the `stamped` line with `const stamped = Boolean(row?.delist_requested_at);` and in `channel-state.test.ts` change that case to `row({ listing_status: "ended", delist_requested_at: "2026-09-11T00:00:00Z" })` and add `delist_requested_at: null` to the `row()` factory. Run `npx vitest run src/lib/__tests__/channel-state.test.ts` -> 11 passed.

- [ ] **Step 2: Write the failing test for `planListEverywhere`**

Append to `channel-state.test.ts`:

```ts
import { planListEverywhere } from "@/lib/channel-state";

describe("planListEverywhere", () => {
  const st = (state: ChannelState) => ({ state, row: null, queueItem: null, url: null, since: null });
  it("pre-checks channels with nothing going on and disables live or queued ones with a reason", () => {
    const plan = planListEverywhere(["poshmark", "mercari", "grailed", "vinted"], {
      poshmark: st("live"), mercari: st("queued"), grailed: st("none"), vinted: st("failed"),
    });
    expect(plan.checked).toEqual(["grailed", "vinted"]);
    expect(plan.disabled).toEqual({ poshmark: "live", mercari: "queued" });
  });
  it("a delist in flight is disabled too", () => {
    const plan = planListEverywhere(["poshmark"], { poshmark: st("delist_queued") });
    expect(plan.checked).toEqual([]);
    expect(plan.disabled.poshmark).toBe("ending");
  });
  it("prefilled and ended are offered but unchecked", () => {
    const plan = planListEverywhere(["poshmark", "mercari"], { poshmark: st("prefilled"), mercari: st("ended") });
    expect(plan.checked).toEqual([]);
    expect(plan.disabled).toEqual({});
  });
});
```

(import `type ChannelState` at the top of the test.) Run: fails, `planListEverywhere` not exported.

- [ ] **Step 3: Implement `planListEverywhere`**

Append to `channel-state.ts`:

```ts
/** The checklist's defaults. Disabled entries carry the word the label shows. */
export function planListEverywhere(
  platforms: readonly string[],
  statuses: Record<string, ChannelStatus | undefined>,
): { checked: string[]; disabled: Record<string, string> } {
  const checked: string[] = [];
  const disabled: Record<string, string> = {};
  for (const p of platforms) {
    const s = statuses[p]?.state ?? "none";
    if (s === "live") disabled[p] = "live";
    else if (s === "queued") disabled[p] = "queued";
    else if (s === "delist_queued") disabled[p] = "ending";
    else if (s === "none" || s === "failed") checked.push(p);
    // prefilled and ended: offered, unchecked. A prefill the seller abandoned
    // may want a second go; an ended listing may want a relist. Both are a
    // decision, not a default.
  }
  return { checked, disabled };
}
```

Run the test file -> 14 passed.

- [ ] **Step 4: The kit header (in `ListingKit`)**

Add imports to `listing-kit.tsx`: `useItemListings` from `@/hooks/use-item-listings`, `useExtensionQueue, useCancelExtensionWork` from `@/hooks/use-extension-queue`, `useCrossPush` from `@/hooks/use-cross-listing`, `useEndListing` from `@/hooks/use-listing-lifecycle`, `useMarkDelistDone` from `@/hooks/use-pending-delists`, `requestDrainNow` from `@/lib/lister-extension`, `deriveChannelState, planListEverywhere, type ChannelStatus` from `@/lib/channel-state`, `MARKETPLACE_LABELS` from `@/lib/constants`, `Checkbox` from `@/components/ui/checkbox`, `Clock, Send, XCircle` from `lucide-react`, `timeAgo` if one exists in `src/lib` (grep `export function timeAgo`; otherwise render the ISO date with `toLocaleString()`).

Inside `ListingKit`, after `kitPlatforms`:

```tsx
  const { data: listingRows = [] } = useItemListings(itemId);
  const { data: queue } = useExtensionQueue();
  const queueForItem = useMemo(
    () => [...(queue?.pending ?? []), ...(queue?.needsAttention ?? [])]
      .filter((it) => it.inventory_item_id === itemId),
    [queue, itemId],
  );
  const statuses = useMemo(() => {
    const out: Record<string, ChannelStatus> = {};
    for (const p of kitPlatforms) out[p] = deriveChannelState(listingRows, queueForItem, p);
    return out;
  }, [kitPlatforms, listingRows, queueForItem]);

  // US-3367: the channels the one button can queue. Depop has no form-filler
  // (API pending) and a `verifying` flow would only report "list manually".
  const queueable = useMemo(
    () => kitPlatforms.filter((p) => isListerPlatform(p) && MARKETPLACE_EXTENSION_FLOW[p] !== "verifying"),
    [kitPlatforms],
  );
  const plan = useMemo(() => planListEverywhere(queueable, statuses), [queueable, statuses]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setChecked(new Set(plan.checked)); }, [plan.checked, touched]);
  const crossPush = useCrossPush();

  const listEverywhere = async () => {
    if (!draft?.id) { toast.error("Save the eBay draft first."); return; }
    const platforms = queueable.filter((p) => checked.has(p) && !plan.disabled[p]);
    if (platforms.length === 0) { toast.error("Pick at least one marketplace."); return; }
    try {
      const res = await crossPush.mutateAsync({ listingId: draft.id, platforms: platforms as CrossListingPlatform[] });
      const queued: string[] = []; const live: string[] = []; const waiting: string[] = []; const blocked: string[] = [];
      for (const p of platforms) {
        const r = res.results[p as CrossListingPlatform];
        const label = MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
        if (!r) continue;
        if (r.skipped === "already_live") live.push(label);
        else if (r.skipped === "already_queued") waiting.push(label);
        else if (r.ok && r.queued) queued.push(label);
        else if (!r.ok) blocked.push(`${label}: ${r.blockers?.[0] ?? r.error ?? "blocked"}`);
      }
      if (queued.length > 0) {
        toast.success(`Queued for your desktop: ${queued.join(", ")}. ${QUEUED_NOTICE}`, { duration: 10_000 });
        void requestDrainNow();
      }
      if (live.length > 0) toast.info(`Already live: ${live.join(", ")}.`);
      if (waiting.length > 0) toast.info(`Already waiting for your desktop: ${waiting.join(", ")}.`);
      for (const b of blocked) toast.error(b, { duration: 12_000 });
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
    } catch (err) {
      toastError(err, "Could not queue the cross-posts.");
    }
  };
```

Import `type CrossListingPlatform` and `type ListingPlatform` (from `@/lib/constants` and `@/types/database`). In the JSX, between `</CardHeader>` and the `<Tabs>`, inside `CardContent`:

```tsx
        {queueable.length > 0 && (
          <div className="mb-4 space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-sm font-medium">List on:</span>
              {queueable.map((p) => {
                const reason = plan.disabled[p];
                const id = `list-on-${p}`;
                return (
                  <label key={p} htmlFor={id} className={cn("flex items-center gap-1.5 text-sm", reason && "text-muted-foreground")}>
                    <Checkbox
                      id={id}
                      checked={!reason && checked.has(p)}
                      disabled={Boolean(reason) || crossPush.isPending}
                      onCheckedChange={(v) => {
                        setTouched(true);
                        setChecked((prev) => { const n = new Set(prev); if (v) n.add(p); else n.delete(p); return n; });
                      }}
                    />
                    {MARKETPLACE_LABELS[p as ListingPlatform] ?? p}
                    {reason ? ` (${reason})` : ""}
                  </label>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" disabled={crossPush.isPending} onClick={() => void listEverywhere()}>
                {crossPush.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
                List everywhere
              </Button>
              <p className="text-xs text-muted-foreground">
                Runs one at a time in your own browser, about 30 seconds apart. {QUEUED_NOTICE}
              </p>
            </div>
          </div>
        )}
```

Tab triggers: pass `statuses[p]?.state` and render a marker after the label:

```tsx
                  {statuses[p]?.state === "live" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-label="live" />}
                  {(statuses[p]?.state === "queued" || statuses[p]?.state === "delist_queued") && <Clock className="h-3 w-3 text-muted-foreground" aria-label="queued" />}
                  {statuses[p]?.state === "failed" && <XCircle className="h-3 w-3 text-brand-red" aria-label="needs you" />}
```

(keep the existing red validation dot).

- [ ] **Step 5: The status row (in `PlatformPanel`)**

Add a prop `status: ChannelStatus` to `PlatformPanel` and pass `statuses[p]` from the map. Add hooks at the top of `PlatformPanel`: `const endListing = useEndListing(); const cancelJob = useCancelExtensionWork(); const markDone = useMarkDelistDone(); const enqueue = useEnqueueExtensionWork();`. Render this block as the FIRST child of the returned `<div className="space-y-3">`, above the issues list:

```tsx
      {status.state !== "none" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span>
            {status.state === "live" && <>Live on {spec.label}{status.since ? ` since ${new Date(status.since).toLocaleDateString()}` : ""}.</>}
            {status.state === "queued" && <>Queued for your desktop{status.since ? `, ${new Date(status.since).toLocaleString()}` : ""}. Nothing is live yet.</>}
            {status.state === "delist_queued" && <>Ending on {spec.label} from your browser. It is live until then.</>}
            {status.state === "prefilled" && <>The {spec.label} form was filled but never confirmed live.</>}
            {status.state === "failed" && <>{status.queueItem?.result?.error ?? `The last ${spec.label} run did not finish.`}</>}
            {status.state === "ended" && <>Ended on {spec.label}.</>}
            {status.state === "sold" && <>Sold on {spec.label}.</>}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {status.url && (
              <Button type="button" variant="outline" size="sm" className="h-7" asChild>
                <a href={status.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />View on {spec.label}
                </a>
              </Button>
            )}
            {status.state === "live" && status.row && (
              <Button type="button" variant="outline" size="sm" className="h-7" disabled={endListing.isPending}
                onClick={() => endListing.mutate({ listingId: status.row!.id }, {
                  onSuccess: (r) => toast[r.queued ? "info" : "success"](r.queued ? `Ending on ${spec.label} from your browser. ${QUEUED_NOTICE}` : `Ended on ${spec.label}.`),
                  onError: (e) => toastError(e, "Could not end the listing."),
                })}>
                End listing
              </Button>
            )}
            {status.state === "queued" && status.queueItem?.status === "queued" && (
              <Button type="button" variant="ghost" size="sm" className="h-7" disabled={cancelJob.isPending}
                onClick={() => cancelJob.mutate(status.queueItem!.id, { onError: (e) => toastError(e) })}>
                Cancel
              </Button>
            )}
            {status.state === "delist_queued" && status.row && (
              <Button type="button" variant="ghost" size="sm" className="h-7" disabled={markDone.isPending}
                onClick={() => markDone.mutate(status.row!.id, { onError: (e) => toastError(e) })}>
                Mark ended
              </Button>
            )}
            {status.state === "failed" && isListerPlatform(platform) && (
              <Button type="button" variant="outline" size="sm" className="h-7" disabled={enqueue.isPending}
                onClick={() => enqueue.mutate({ kind: "list", platform, inventoryItemId: itemId, listingId: status.row?.id ?? null, payload: {} }, {
                  onSuccess: () => toast.success(`Queued again. ${QUEUED_NOTICE}`),
                  onError: (e) => toastError(e),
                })}>
                Retry
              </Button>
            )}
            {status.state === "prefilled" && showSend && (
              <Button type="button" variant="secondary" size="sm" className="h-7" disabled={confirming} onClick={confirmPublished}>
                I published it
              </Button>
            )}
          </span>
        </div>
      )}
```

Check the `ListingEndResponse` type in `use-listing-lifecycle.ts` carries `queued?: boolean`; if it does not, add it. Relabel the per-tab send button text from `Send to extension` to `Fill {spec.label} now` and its title to `` `Fill ${spec.label}'s listing form in a new tab, right now` ``. Then grep the repo for the old label: `grep -rn "Send to extension" src/ --include=*.test.* --include=*.tsx` and update any test that pins the string (`src/test/cross-post-setup.test.ts` likely).

- [ ] **Step 6: Source guard**

```ts
// src/test/listing-kit-list-everywhere.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");

describe("Listing Kit: List everywhere (US-3367)", () => {
  it("queues through cross-push, never through N direct sends", () => {
    expect(src).toContain("useCrossPush()");
    expect(src).toContain("List everywhere");
    expect(src.match(/sendToLister\(/g)?.length ?? 0).toBe(1);
  });
  it("says the queued sentence and nudges the drain after queueing", () => {
    expect(src).toContain("${QUEUED_NOTICE}");
    expect(src).toContain("requestDrainNow()");
  });
  it("reads the channel state from one derivation", () => {
    expect(src).toContain("deriveChannelState(");
    expect(src).toContain("planListEverywhere(");
  });
  it("links to the marketplace for any platform, not only eBay", () => {
    expect(src).toContain("View on {spec.label}");
  });
});
```

- [ ] **Step 7: Check everything**

Run: `npx tsc -b && npx eslint src/components/flipdesk/listing-kit.tsx src/lib/channel-state.ts src/hooks/use-item-listings.ts && npx vitest run src/test/listing-kit-list-everywhere.test.ts src/lib/__tests__/channel-state.test.ts src/test/cross-post-setup.test.ts src/test/lister-transport-selection.test.ts && npm run ui:check`
Expected: all green, ui:check 0 blocking.
Run: `npm run dev`, open a cross-listed item's composer, confirm the checklist renders, disabled entries show the reason, and the tab markers appear. Take no screenshots into the repo.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/use-item-listings.ts src/lib/channel-state.ts src/lib/__tests__/channel-state.test.ts src/components/flipdesk/listing-kit.tsx src/test/listing-kit-list-everywhere.test.ts src/test/cross-post-setup.test.ts
git commit -m "feat(kit): List everywhere through the paced queue, with a status row and marketplace link per channel (US-3367)"
```

---

### Task 8: Item page card and the banner where the seller looks

**Files:**
- Create: `src/components/flipdesk/cross-listings-card.tsx`
- Modify: `src/components/flipdesk/pending-delist-banner.tsx:28-34`
- Modify: `src/pages/flipdesk/item.tsx:281-285`, `src/pages/flipdesk/composer.tsx:3910-3914`
- Test: `src/test/cross-listings-card.test.ts` (source guard)

**Interfaces:**
- Consumes: `deriveChannelState`, `useItemListings`, `useExtensionQueue`, `useEndListing`, `useMarkDelistDone`, `MARKETPLACE_LABELS`, `safeHref`.
- Produces: `export function CrossListingsCard({ itemId }: { itemId: string })`; `PendingDelistBanner({ itemId?: string })`.

- [ ] **Step 1: Banner filter**

In `pending-delist-banner.tsx` change the signature to `export function PendingDelistBanner({ itemId }: { itemId?: string } = {})` and after `const { data: pending = [] } = usePendingDelists();` add `const rows = itemId ? pending.filter((p) => p.item_id === itemId) : pending;` and use `rows` everywhere `pending` was used below (the `length === 0` return, the count, the map).

- [ ] **Step 2: The card**

```tsx
// src/components/flipdesk/cross-listings-card.tsx
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { useItemListings } from "@/hooks/use-item-listings";
import { useExtensionQueue, QUEUED_NOTICE } from "@/hooks/use-extension-queue";
import { useEndListing } from "@/hooks/use-listing-lifecycle";
import { useMarkDelistDone } from "@/hooks/use-pending-delists";
import { deriveChannelState } from "@/lib/channel-state";

// US-3367: every non-eBay listing of this item, with its state, its
// marketplace page and the one verb that applies. The eBay cards above it
// are eBay-only by design; this is where Poshmark, Mercari, Grailed and
// Vinted get a link and an End button on the item page.
const WORDS: Record<string, string> = {
  live: "Live",
  queued: "Queued for your desktop",
  delist_queued: "Ending from your browser",
  prefilled: "Form filled, not confirmed live",
  failed: "Needs you",
  ended: "Ended",
  sold: "Sold here",
};

export function CrossListingsCard({ itemId }: { itemId: string }) {
  const { data: rows = [] } = useItemListings(itemId);
  const { data: queue } = useExtensionQueue();
  const endListing = useEndListing();
  const markDone = useMarkDelistDone();

  const platforms = [...new Set(rows.filter((r) => r.platform !== "ebay").map((r) => r.platform))];
  if (platforms.length === 0) return null;
  const items = [...(queue?.pending ?? []), ...(queue?.needsAttention ?? [])]
    .filter((it) => it.inventory_item_id === itemId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Other marketplaces</CardTitle>
        <CardDescription>Where else this item is listed, and what each one is doing.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {platforms.map((p) => {
            const s = deriveChannelState(rows, items, p);
            const label = MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
            return (
              <li key={p} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground"> {WORDS[s.state] ?? ""}</span>
                  {s.state === "failed" && s.queueItem?.result?.error && (
                    <span className="block text-xs text-muted-foreground">{s.queueItem.result.error}</span>
                  )}
                </span>
                <span className="flex items-center gap-1.5">
                  {s.url && (
                    <Button variant="outline" size="sm" className="h-7" asChild>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />View on {label}
                      </a>
                    </Button>
                  )}
                  {s.state === "live" && s.row && (
                    <Button variant="outline" size="sm" className="h-7" disabled={endListing.isPending}
                      onClick={() => endListing.mutate({ listingId: s.row!.id }, {
                        onSuccess: (r) => toast[r.queued ? "info" : "success"](r.queued ? `Ending on ${label} from your browser. ${QUEUED_NOTICE}` : `Ended on ${label}.`),
                        onError: (e) => toastError(e, "Could not end the listing."),
                      })}>
                      {endListing.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "End listing"}
                    </Button>
                  )}
                  {s.state === "delist_queued" && s.row && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={markDone.isPending}
                      onClick={() => markDone.mutate(s.row!.id, { onError: (e) => toastError(e) })}>
                      Mark ended
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Render points**

`item.tsx`, after `<GradethreadListingCard ... />` (line 281):

```tsx
          {/* US-3367: the sold-elsewhere delists for THIS item, then every
              non-eBay listing with its link and its End button. */}
          <PendingDelistBanner itemId={item.id} />
          <CrossListingsCard itemId={item.id} />
```

with imports `import { PendingDelistBanner } from "@/components/flipdesk/pending-delist-banner";` and `import { CrossListingsCard } from "@/components/flipdesk/cross-listings-card";`.

`composer.tsx`, directly above `<ListingKit` (line 3914): `<PendingDelistBanner itemId={item.id} />` with the import. Check the composer already imports nothing named `PendingDelistBanner` (grep) to avoid a duplicate.

- [ ] **Step 4: Source guard**

```ts
// src/test/cross-listings-card.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CrossListingsCard (US-3367)", () => {
  const card = readFileSync("src/components/flipdesk/cross-listings-card.tsx", "utf8");
  it("renders nothing for an item with only eBay rows", () => {
    expect(card).toContain('r.platform !== "ebay"');
    expect(card).toContain("if (platforms.length === 0) return null;");
  });
  it("is mounted on the item page and the banner is item-scoped on both pages", () => {
    const item = readFileSync("src/pages/flipdesk/item.tsx", "utf8");
    const composer = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");
    expect(item).toContain("<CrossListingsCard itemId={item.id} />");
    expect(item).toContain("<PendingDelistBanner itemId={item.id} />");
    expect(composer).toContain("<PendingDelistBanner itemId={item.id} />");
  });
});
```

- [ ] **Step 5: Check**

Run: `npx tsc -b && npx eslint src/components/flipdesk/cross-listings-card.tsx src/components/flipdesk/pending-delist-banner.tsx src/pages/flipdesk/item.tsx && npx vitest run src/test/cross-listings-card.test.ts src/lib/__tests__/composer-locks.test.ts && npm run ui:check`
Expected: green; ui:check 0 blocking (the card uses border-only elevation, no side rail).

- [ ] **Step 6: Commit**

```bash
git add src/components/flipdesk/cross-listings-card.tsx src/components/flipdesk/pending-delist-banner.tsx src/pages/flipdesk/item.tsx src/pages/flipdesk/composer.tsx src/test/cross-listings-card.test.ts
git commit -m "feat(item): every marketplace listing with its link and End button, and the delist banner where the seller looks (US-3367)"
```

---

### Task 9: Full verify, story note, vault note

**Files:**
- Modify: `prd.json` (via `scripts/prd-story.mjs note`)
- Modify: `vault/30-platform/closing-a-coverage-gap.md` (one paragraph under "Queueing from a phone") and `vault/30-platform/cross-listing.md` Related list. Load the `vault` skill before editing.

- [ ] **Step 1: Run the full local verify**

Run: `npm run verify`
Expected: every lane prints a check mark. If the `db` or `security` lane is skipped for Docker, say so in the note; nothing here touches migrations or the edge Dockerfile.

- [ ] **Step 2: Write the vault note**

Invoke the `vault` skill. In `closing-a-coverage-gap.md`, after the three queue rules, add a fourth bullet:

```
- **A list job earns a gap; a delist never does** (US-3367). The drain
  schedules the next pass 30 s (plus or minus 15 s) after a `list` job settles,
  through a one-shot alarm, and returns `paced` without touching `/claim`
  while inside the gap. Delist, revise and relist re-drain immediately. The
  seller picks the gap on the options page. Cross-push refuses to queue a
  channel that is already live (row `active` with a URL) or already waiting,
  so pressing "List everywhere" twice cannot mint a duplicate listing.
```

Run `npm run vault:index && npm run vault:lint`.

- [ ] **Step 3: Story note**

Write the note to a file first (backticks in a shell argument get executed):

```bash
cat > /tmp/us3367-note.txt <<'EOF'
2026-09-11 BUILT, code ACs done. What shipped: planCrossPushSkip guard in lib/cross-push.ts (already_live / already_queued, carried through the route and the automation); siblingSelector anchor fix and exported queueExtensionDelist in lib/cross-listings.ts; endOwnedListing now enqueues the delist job; lib/record-sale.ts + POST /api/flipdesk/sales/record with a tenant-isolation case; the Record Sale dialog asks Sold on and reports queued vs needs-you; extension pacing (job-store.js pacingHold/nextListDrainAt, one-shot alarm, options page, worker status line); src/lib/channel-state.ts feeding the kit tabs, the kit status rows, and the new CrossListingsCard on the item page; PendingDelistBanner item-scoped on composer and item page. VERIFIED: npm run verify green (list the lane summary here). STILL OPEN: the OPERATOR AC only.
EOF
node scripts/prd-story.mjs note US-3367 --note "$(cat /tmp/us3367-note.txt)"
```

Fill in the actual lane summary from Step 1 before running it.

- [ ] **Step 4: Commit**

```bash
git add prd.json vault/30-platform/closing-a-coverage-gap.md vault/00-index/INDEX.md
git commit -m "docs(vault): pacing and the re-list guard on the coverage-gap runbook; US-3367 progress note"
```

Do NOT push. Per `feedback_batch_pushes_edge_downtime`, name the edge changes (cross-push.ts, cross-listings.ts, listing-lifecycle.ts, record-sale.ts, flipdesk-sales.ts, main.ts) and the extension changes (needs a store release, version bump is a separate decision) in the final message and let the founder push.

---

## Self-review

**Spec coverage.** A1 kit checklist + button -> Task 7. A2 skip guard -> Task 2. A3 pacing -> Task 6. A4 status row + link + End -> Tasks 1, 7. A5 End enqueues -> Task 3. A6 item card -> Task 8. B1 record route + dialog -> Tasks 4, 5. B2 anchor -> Task 3. B3 banner placement -> Task 8. Testing section: channel-state, cross-push-skip, record-sale, cross-listings-anchor, lister-pacing, sale-math, tenant case, verify -> Tasks 1 to 9. Migration: none. Out-of-scope items stay out.

**Placeholders.** None: every step carries code. The one open lookup (whether `/api/flipdesk/*` auth is a wildcard) is a check with both outcomes written.

**Type consistency.** `ChannelStatus` fields `{ state, row, queueItem, url, since }` used identically in Tasks 1, 7, 8. `CrossPushSkip` values `"already_live" | "already_queued"` match across edge lib, edge route, web hook, and the kit toast. `RecordSaleResult.queued` / `.unresolved` are `string[]` of platform keys, mapped to labels only in the dialog. `ListingEndResponse.queued` is read in Tasks 7 and 8; Task 7 says to add it if absent. `GT_LISTER_JOBS.pacesAfter/pacingHold/nextListDrainAt/pacingGapFor/PACING` match between the test and background.js.
