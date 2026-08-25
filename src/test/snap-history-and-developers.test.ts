import { describe, it, expect, beforeEach } from "vitest";
import { ALL_SURFACES } from "@/lib/surfaces";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendSnapHistory,
  clearSnapHistory,
  readSnapHistory,
  removeSnapHistoryEntry,
} from "@/lib/snap-history";
import type { SnapResult } from "@/hooks/use-snap";

// US-2554. Two unrelated halves of one story: a snap was thrown away the moment
// the page unmounted, and the whole developer product lived inside an Account
// tab.

const SNAP = "src/pages/snap.tsx";
const KEYS = "src/pages/api-keys.tsx";
const ROUTES = "src/routes/index.tsx";
const SIDEBAR = "src/components/dashboard/sidebar.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function result(score: number, medianCents: number | null = null): SnapResult {
  return {
    grade: {
      overall_score: score,
      grade_tier: "Good",
      confidence: 0.8,
      factor_scores: {},
    },
    value: medianCents == null
      ? null
      : {
        lowCents: medianCents - 500,
        medianCents,
        highCents: medianCents + 500,
        sampleSize: 12,
        confidence: 0.7,
        sufficient: true,
        currency: "USD",
      },
    estimate: true,
    disclaimer: "estimate",
  };
}

describe("a snap survives a reload (US-2554 AC1, AC2)", () => {
  beforeEach(() => clearSnapHistory());

  it("keeps what the list needs to show, newest first", () => {
    appendSnapHistory(result(7.5, 4200), { brand: "Patagonia", keyword: "Better Sweater" });
    appendSnapHistory(result(9), { brand: "Arc'teryx" });
    const history = readSnapHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.brand).toBe("Arc'teryx");
    expect(history[0]?.grade).toBe(9);
    expect(history[1]?.valueCents).toBe(4200);
    // The whole result rides along, so revisiting one shows what it showed.
    expect(history[1]?.result.grade.overall_score).toBe(7.5);
  });

  it("does not keep the photo", () => {
    // The endpoint never stores the image (US-276 strips and discards it), and a
    // 2400px data URI per entry would blow the storage quota and evict the very
    // history it belongs to.
    appendSnapHistory(result(8), { brand: "Nike" });
    const raw = JSON.stringify(readSnapHistory());
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain("imageDataUri");
  });

  it("is bounded", () => {
    for (let i = 0; i < 30; i++) appendSnapHistory(result(5), { brand: `b${i}` });
    expect(readSnapHistory().length).toBeLessThanOrEqual(20);
    // And the newest survived, not the oldest.
    expect(readSnapHistory()[0]?.brand).toBe("b29");
  });

  it("survives a corrupt or hostile stored value", () => {
    // localStorage is user-writable, so a bad value must not take the page down
    // or render blank rows.
    localStorage.setItem("gt.snap-history.v1", "not json");
    expect(readSnapHistory()).toEqual([]);
    localStorage.setItem("gt.snap-history.v1", JSON.stringify([{ nope: true }, null]));
    expect(readSnapHistory()).toEqual([]);
  });

  it("entries can be removed individually and wholesale", () => {
    appendSnapHistory(result(6), { brand: "keep" });
    appendSnapHistory(result(7), { brand: "drop" });
    const dropId = readSnapHistory()[0]!.id;
    expect(removeSnapHistoryEntry(dropId).map((e) => e.brand)).toEqual(["keep"]);
    clearSnapHistory();
    expect(readSnapHistory()).toEqual([]);
  });

  it("the page records on success only, and can reopen one", () => {
    const src = read(SNAP);
    // A failed snap has nothing to revisit, and a rate-limit refusal is not an
    // estimate — so this hangs off onSuccess, not off the mutate call.
    expect(src).toContain("onSuccess: (data) =>");
    expect(src).toContain("appendSnapHistory(data, { brand, keyword })");
    expect(src).toContain("setRevisited(");
    // The reopened entry wins over the last mutation result.
    expect(src).toContain("const result = revisited?.result ?? snap.data;");
    // And it says where the history lives, rather than implying an account.
    expect(src).toContain("Kept on this device only");
  });
});

describe("the developer surface is its own destination (US-2554 AC3)", () => {
  it("has a top-level route and a nav entry", () => {
    const routes = read(ROUTES);
    expect(routes).toContain('path: "/dashboard/developers"');
    expect(routes).toContain("const ApiKeysPage = lazy(");
    // US-2876: the nav entry and its capability gate live in the registry now,
    // and the sidebar builds itself from it.
    const developers = ALL_SURFACES.find((s) => s.web === "/dashboard/developers");
    expect(developers, "the Developers nav entry is gone").toBeDefined();
    expect(developers!.nav).not.toBeNull();
    expect(developers!.requires).toBe("manage_api_keys");
    expect(read(SIDEBAR)).toContain("ALL_SURFACES");
  });

  it("the old path still resolves, because Stripe returns to it", () => {
    // US-2511's rule: a money path never gets an extra client-side hop, and the
    // API-overage checkout success_url is baked into payments.ts.
    const routes = read(ROUTES);
    expect(routes).toContain('path: "/dashboard/api-keys"');
    expect(routes).toContain('initialTab="api-keys"');
    expect(read("services/edge-functions/src/routes/payments.ts")).toContain(
      "/dashboard/api-keys?checkout=success",
    );
  });
});

describe("the keys page stops looking like something it is not (US-2554 AC4, AC5)", () => {
  const src = read(KEYS);

  it("every resource tile that looks like a link is one", () => {
    // Two of the three were non-interactive divs with the same border, padding
    // and hover-less styling as the anchor beside them.
    const at = src.indexOf("Developer Resources");
    const block = src.slice(at, at + 2600);
    expect(block).not.toMatch(/<div className="flex items-start gap-3 rounded-lg border p-4">/);
    expect((block.match(/<Link/g) ?? []).length).toBe(3);
    expect(block).toContain('to="/developers#sdk"');
    expect(block).toContain('to="/developers#sandbox"');
  });

  it("the seven-column table can be scrolled on a phone", () => {
    // Without the wrapper the row is clipped and the revoke button is
    // unreachable, which is how a leaked key stays live.
    const at = src.indexOf("<Table>");
    expect(src.slice(at - 400, at)).toContain('<div className="overflow-x-auto">');
  });

  it("the empty state is the shared one, and offers the action", () => {
    expect(src).toContain('from "@/components/ui/empty-state"');
    expect(src).toContain("<EmptyState");
    expect(src).toContain('label: "Create a key"');
    // The hand-rolled version had no CTA at all.
    expect(src).not.toContain('<h3 className="mt-4 text-lg font-medium">No API keys</h3>');
  });
});
