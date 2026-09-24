import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ALL_SURFACES } from "@/lib/surfaces";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendSnapHistory,
  clearAllSnapHistory,
  clearSnapHistory,
  LEGACY_SNAP_HISTORY_KEY,
  readSnapHistory,
  removeSnapHistoryEntry,
  SNAP_DISCLAIMER,
  snapHistoryKey,
  type SnapHistoryEntry,
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

function snapKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("gt.snap-history.")) out.push(k);
  }
  return out;
}

const A = "user-a";
const B = "user-b";

/** Append to user A's stored list and return the new list. */
function add(r: SnapResult, opts: { brand?: string; keyword?: string } = {}, uid = A) {
  return appendSnapHistory(uid, readSnapHistory(uid), r, opts).entries;
}

describe("a snap survives a reload (US-2554 AC1, AC2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps what the list needs to show, newest first", () => {
    add(result(7.5, 4200), { brand: "Patagonia", keyword: "Better Sweater" });
    add(result(9), { brand: "Arc'teryx" });
    const history = readSnapHistory(A);
    expect(history).toHaveLength(2);
    expect(history[0]?.brand).toBe("Arc'teryx");
    expect(history[0]?.grade).toBe(9);
    expect(history[1]?.valueCents).toBe(4200);
    // The result rides along, so revisiting one shows what it showed.
    expect(history[1]?.result.grade.overall_score).toBe(7.5);
    // The disclaimer is rehydrated, not stored twenty times.
    expect(history[1]?.result.disclaimer).toBe(SNAP_DISCLAIMER);
    expect(localStorage.getItem(snapHistoryKey(A))).not.toContain("ESTIMATE");
  });

  it("does not keep the photo", () => {
    // The endpoint never stores the image (US-276 strips and discards it), and a
    // data URI per entry would blow the storage quota and evict the very
    // history it belongs to.
    add(result(8), { brand: "Nike" });
    const raw = JSON.stringify(readSnapHistory(A));
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain("imageDataUri");
  });

  it("is bounded", () => {
    for (let i = 0; i < 30; i++) add(result(5), { brand: `b${i}` });
    expect(readSnapHistory(A).length).toBeLessThanOrEqual(20);
    // And the newest survived, not the oldest.
    expect(readSnapHistory(A)[0]?.brand).toBe("b29");
  });

  it("survives a corrupt or hostile stored value", () => {
    // localStorage is user-writable, so a bad value must not take the page down
    // or render blank rows.
    localStorage.setItem(snapHistoryKey(A), "not json");
    expect(readSnapHistory(A)).toEqual([]);
    localStorage.setItem(snapHistoryKey(A), JSON.stringify([{ nope: true }, null]));
    expect(readSnapHistory(A)).toEqual([]);
  });

  it("drops a shallow-valid entry whose result would crash the card (SNAP-06)", () => {
    const good = add(result(7, 3000), { brand: "ok" })[0]!;
    const hostile = [
      { ...good, id: "empty-result", result: {} },
      { ...good, id: "string-score", result: { ...good.result, grade: { ...good.result.grade, overall_score: "7" } } },
      { ...good, id: "bad-date", at: "yesterday" },
      { ...good, id: "bad-value", valueCents: "lots" },
      { ...good, id: "bad-tier", gradeTier: 7 },
      { ...good, id: "bad-median", result: { ...good.result, value: { ...good.result.value, medianCents: "x" } } },
      good,
    ];
    localStorage.setItem(snapHistoryKey(A), JSON.stringify(hostile));
    expect(readSnapHistory(A).map((e) => e.id)).toEqual([good.id]);
  });

  it("entries can be removed individually and wholesale", () => {
    add(result(6), { brand: "keep" });
    const list = add(result(7), { brand: "drop" });
    const dropId = list[0]!.id;
    expect(removeSnapHistoryEntry(A, list, dropId).entries.map((e) => e.brand)).toEqual(["keep"]);
    expect(readSnapHistory(A).map((e) => e.brand)).toEqual(["keep"]);
    clearSnapHistory(A);
    expect(readSnapHistory(A)).toEqual([]);
  });

  it("the page records on success only, and can reopen one", () => {
    const src = read(SNAP);
    // A failed snap has nothing to revisit, and a rate-limit refusal is not an
    // estimate, so the history write hangs off success, not off the mutate call.
    expect(read("src/hooks/use-snap.ts") + src).toMatch(/onSuccess/);
    expect(read("src/hooks/use-snap.ts") + src).toContain("appendSnapHistory(");
    expect(src).toContain("setRevisited(");
    // And it says where the history lives, rather than implying an account.
    expect(src).toContain("Kept on this device only");
  });
});

describe("snap history is scoped to the signed-in user (SNAP-01)", () => {
  beforeEach(() => localStorage.clear());

  it("user B never reads user A's snaps", () => {
    add(result(8, 5000), { brand: "Private brand" }, A);
    expect(readSnapHistory(A)).toHaveLength(1);
    expect(readSnapHistory(B)).toEqual([]);
  });

  it("nothing is read or written without a user", () => {
    const w = appendSnapHistory(null, [], result(8), { brand: "x" });
    expect(w.persisted).toBe(false);
    expect(readSnapHistory(null)).toEqual([]);
    expect(snapKeys()).toEqual([]);
  });

  it("the legacy unscoped v1 key is removed on read, not migrated", () => {
    localStorage.setItem(LEGACY_SNAP_HISTORY_KEY, JSON.stringify([{ id: "old" }]));
    expect(readSnapHistory(A)).toEqual([]);
    expect(localStorage.getItem(LEGACY_SNAP_HISTORY_KEY)).toBeNull();
  });

  it("clearAllSnapHistory leaves no snap key behind", () => {
    add(result(8), { brand: "a" }, A);
    add(result(8), { brand: "b" }, B);
    localStorage.setItem(LEGACY_SNAP_HISTORY_KEY, "[]");
    expect(snapKeys()).toHaveLength(3);
    localStorage.setItem("unrelated", "keep");
    clearAllSnapHistory();
    expect(snapKeys()).toEqual([]);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("sign-out wipes it", () => {
    const auth = read("src/hooks/use-auth.ts");
    const at = auth.indexOf("SIGNED_OUT: sign-out is SPA navigation");
    expect(at).toBeGreaterThan(-1);
    const branch = auth.slice(at, auth.indexOf("s.reset();", at));
    expect(branch).toContain("clearAllSnapHistory();");
  });

  it("the page reads under the user id and listens for other tabs", () => {
    const src = read(SNAP);
    expect(src).toContain("readSnapHistory(userId)");
    expect(src).toContain('addEventListener("storage"');
  });
});

describe("snap history when storage fails (SNAP-06)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("works on the caller's list when every write throws", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    let list: SnapHistoryEntry[] = [];
    for (let i = 0; i < 3; i++) {
      const w = appendSnapHistory(A, list, result(6), { brand: `b${i}` });
      expect(w.persisted).toBe(false);
      list = w.entries;
    }
    expect(list).toHaveLength(3);
    const after = removeSnapHistoryEntry(A, list, list[1]!.id);
    expect(after.persisted).toBe(false);
    expect(after.entries.map((e) => e.brand)).toEqual(["b2", "b0"]);
  });

  it("the quota fallback returns exactly what it stored", () => {
    let list: SnapHistoryEntry[] = [];
    for (let i = 0; i < 12; i++) list = appendSnapHistory(A, list, result(6), { brand: `b${i}` }).entries;
    const real = localStorage.setItem.bind(localStorage);
    let calls = 0;
    vi.spyOn(localStorage, "setItem").mockImplementation((k: string, v: string) => {
      calls++;
      if (calls === 1) throw new Error("QuotaExceededError");
      real(k, v);
    });
    const w = appendSnapHistory(A, list, result(9), { brand: "newest" });
    expect(w.persisted).toBe(true);
    expect(w.entries).toHaveLength(5);
    expect(w.entries[0]?.brand).toBe("newest");
    vi.restoreAllMocks();
    expect(readSnapHistory(A).map((e) => e.id)).toEqual(w.entries.map((e) => e.id));
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
