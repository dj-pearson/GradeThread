// US-3179: the outcome comparison, driven against rows a REAL edge service
// returned from a REAL database.
//
// The unit suite beside this one builds its own rows and proves the rules.
// What it cannot prove is that the columns the route selects are the columns
// the comparison reads, that a repeat session in two real rows collapses to
// one outcome, and that another seller's sale is not in the answer. Those are
// questions about pieces agreeing.
//
// Skips with a reason when the stack is absent.

import { describe, it, expect } from "vitest";
import { compareOutcomes, summarize } from "@/lib/work-outcomes";

const EDGE = process.env.LIVE_EDGE_URL;
const TOKEN_A = process.env.LIVE_TOKEN_A;
const TOKEN_B = process.env.LIVE_TOKEN_B;
const READY = Boolean(EDGE && TOKEN_A && TOKEN_B);

async function outcomesFor(token: string) {
  const res = await fetch(`${EDGE}/api/flipdesk/planner/outcomes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`outcomes read failed: ${res.status}`);
  const body = await res.json();
  return compareOutcomes({
    tasks: (body.tasks ?? []).map((t: Record<string, unknown>) => ({
      taskId: t.task_id as string,
      sessionId: t.session_id as string,
      inventoryItemId: t.inventory_item_id as string | null,
      itemTitleSnapshot: t.item_title_snapshot as string | null,
      actionKey: t.action_key as string,
      taskState: t.task_state as string,
      sessionState: t.session_state as string,
      estimateValueCents: t.estimate_value_cents as number | null,
      estimateSource: t.estimate_source as string | null,
      estimateTakenAt: t.estimate_taken_at as string | null,
      confirmedMinutes: t.confirmed_minutes as number | null,
      correctionMinutes: t.correction_minutes as number | null,
    })),
    sales: (body.sales ?? []).map((s: Record<string, unknown>) => ({
      saleId: s.sale_id as string,
      inventoryItemId: s.inventory_item_id as string | null,
      status: s.status as string,
      cancelledAt: s.cancelled_at as string | null,
      soldAt: s.sold_at as string | null,
      money: s.money as never,
      acquiredPrice: s.acquired_price as number | string | null,
      legacyShipTotal: null,
      marketplace: s.marketplace as string | null,
    })),
    items: (body.items ?? []).map((i: Record<string, unknown>) => ({
      inventoryItemId: i.inventory_item_id as string,
      createdAt: i.created_at as string | null,
    })),
    now: body.now as string,
  });
}

describe.skipIf(!READY)("comparing against real rows (US-3179)", () => {
  it("a garment planned in TWO sessions is one outcome with the first estimate", async () => {
    const { outcomes } = await outcomesFor(TOKEN_A!);
    const jacket = outcomes.find(
      (o) => o.inventoryItemId === "aaaa0001-0000-0000-0000-000000000001",
    )!;
    expect(jacket).toBeTruthy();
    expect(jacket.sessionCount).toBe(2);
    // $33 from the first session, not the $25 from the second.
    expect(jacket.estimatedNetCents).toBe(3300);
    // 8 minutes photographing plus 4 reviewing the draft, across both.
    expect(jacket.confirmedMinutes).toBe(12);
    expect(jacket.state).toBe("sold");
    // The books' own figure: 6000 - 800 - 200 - 900 - 2200.
    expect(jacket.recordedNetCents).toBe(1900);
  });

  it("an item with no recorded acquisition price cannot be scored", async () => {
    const { outcomes } = await outcomesFor(TOKEN_A!);
    const jeans = outcomes.find(
      (o) => o.inventoryItemId === "aaaa0003-0000-0000-0000-000000000003",
    )!;
    expect(jeans.state).toBe("incomplete_costs");
    expect(jeans.recordedNetCents).toBeNull();
    expect(jeans.incompleteReason).toContain("acquired_price");
  });

  it("a refunded sale restates rather than staying a win", async () => {
    const { outcomes } = await outcomesFor(TOKEN_A!);
    const fleece = outcomes.find(
      (o) => o.inventoryItemId === "aaaa0004-0000-0000-0000-000000000004",
    )!;
    expect(fleece.state).toBe("refunded");
    expect(fleece.recordedNetCents).not.toBeNull();
  });

  it("unsold stock past the horizon says so rather than scoring zero", async () => {
    const { outcomes } = await outcomesFor(TOKEN_A!);
    const unsold = outcomes.find(
      (o) => o.inventoryItemId === "aaaa0002-0000-0000-0000-000000000002",
    )!;
    expect(unsold.state).toBe("not_sold_within_horizon");
    expect(unsold.recordedNetCents).toBeNull();
    // Its estimate is NOT in the comparable total.
    const s = summarize(outcomes);
    expect(s.counts.not_sold_within_horizon).toBe(1);
  });

  it("THE OTHER SELLER'S SALE IS NOT IN THE ANSWER", async () => {
    const mine = await outcomesFor(TOKEN_A!);
    const theirs = await outcomesFor(TOKEN_B!);
    expect(theirs.outcomes.length).toBeGreaterThan(0);
    const myIds = new Set(mine.outcomes.map((o) => o.inventoryItemId));
    for (const o of theirs.outcomes) {
      expect(myIds.has(o.inventoryItemId), `${o.inventoryItemId} crossed`).toBe(false);
    }
    // Their $999 estimate is nowhere in my totals.
    expect(mine.outcomes.some((o) => o.estimatedNetCents === 99900)).toBe(false);
  });

  it("the summary totals only what actually settled", async () => {
    const { outcomes } = await outcomesFor(TOKEN_A!);
    const s = summarize(outcomes);
    // The jacket (sold) and the Synchilla (refunded) are comparable. The
    // jeans are incomplete and the fleece never sold.
    expect(s.comparable).toBe(2);
    expect(s.counts.incomplete_costs).toBe(1);
    expect(s.counts.not_sold_within_horizon).toBe(1);
    // Evidence sources are reported separately, never averaged together.
    expect(s.bySource.sold_comp).toBeGreaterThan(0);
    expect(s.bySource.active_asking).toBeGreaterThan(0);
  });
});
