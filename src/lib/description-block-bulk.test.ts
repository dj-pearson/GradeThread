// US-2962: the bulk toggle set.
//
// Two things here can lose a seller's work quietly, and both are tested
// directly rather than through the toolbar that calls them:
//
//   * applyToggleSet writing anything other than `on`. Text, refs, units,
//     separators and the array ORDER all have to survive, because this runs
//     over a legacy conversion whose blocks the bulk grid has never seen.
//   * applyBlockToggles reaching a listing that is no longer a draft. The grid
//     queries drafts, but a batch left open while another tab publishes is
//     exactly how a toolbar ends up rewriting live copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyToggleSet,
  applyBlockToggles,
  bulkBlockSummary,
  BULK_TOGGLE_KEYS,
  BULK_TOGGLE_WARNINGS,
  hasChanges,
} from "@/lib/description-block-bulk";
import type { DescriptionBlock } from "@/types/database";

const listings = {
  select: vi.fn(),
  in: vi.fn(),
};
const from = vi.fn(() => listings);
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => from() },
}));

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));

const blocks = (): DescriptionBlock[] => [
  { key: "intro", on: true, src: "ai", text: "Jogger-style pants." },
  { key: "attributes", on: true, src: "item", fields: ["brand", "size"] },
  { key: "measurements", on: true, src: "item", unit: "cm", sep: "\n\n\n" },
  { key: "grade", on: false, src: "grade" },
  { key: "text", on: true, src: "user", text: "Legacy prose, verbatim." },
  { key: "facts", on: true, src: "system" },
];

describe("applyToggleSet (US-2962)", () => {
  it("writes only `on`, and only on the keys named", () => {
    const before = blocks();
    const after = applyToggleSet(before, { measurements: "off", grade: "on" });
    expect(after[2]).toEqual({
      key: "measurements",
      on: false,
      src: "item",
      unit: "cm",
      sep: "\n\n\n",
    });
    expect(after[3]!.on).toBe(true);
    // Everything else by reference: not rebuilt, not reordered, not retyped.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[4]).toBe(before[4]);
    expect(after[5]).toBe(before[5]);
    expect(after.map((b) => b.key)).toEqual(before.map((b) => b.key));
  });

  it("leaves a legacy conversion's own blocks alone", () => {
    // A `text` block holding the seller's original prose is what a legacy parse
    // produces, and no toggle in the bulk set names it.
    const before = blocks();
    const after = applyToggleSet(before, { intro: "off" });
    expect(after[4]).toBe(before[4]);
    expect(after[4]!.text).toBe("Legacy prose, verbatim.");
  });

  it("returns the SAME array when nothing would change", () => {
    // The caller skips the round trip on identity, so this is load-bearing: a
    // fresh object here would re-render every draft to identical bytes.
    const before = blocks();
    expect(applyToggleSet(before, {})).toBe(before);
    expect(applyToggleSet(before, { intro: "keep" })).toBe(before);
    expect(applyToggleSet(before, { intro: "on", grade: "off" })).toBe(before);
  });

  it("does not offer per-listing content", () => {
    // `snippet` and `text` hold one listing's own words. A blanket switch over
    // "whatever is in this slot" is not one decision.
    expect(BULK_TOGGLE_KEYS).not.toContain("snippet");
    expect(BULK_TOGGLE_KEYS).not.toContain("text");
  });

  it("DOES offer the grade disclosure, and warns about it", () => {
    // The highest-consequence switch on the panel: hiding it drops the defect
    // statement a buyer reads. Offered because a seller describing the same
    // flaws in their own prose has no other way to clear it forty times, and
    // warned about because it should not happen by muscle memory.
    expect(BULK_TOGGLE_KEYS).toContain("disclosure");
    expect(BULK_TOGGLE_WARNINGS.disclosure).toContain("defect statement");
    // And it is the only one carrying a warning, so the warning still reads as
    // one rather than as decoration on every row.
    expect(Object.keys(BULK_TOGGLE_WARNINGS)).toEqual(["disclosure"]);
  });

  it("hiding the disclosure is still opt-in, not a default", () => {
    const before = blocks().concat({ key: "disclosure", on: true, src: "grade" });
    const last = before.length - 1;
    expect(applyToggleSet(before, { measurements: "off" })[last]!.on).toBe(true);
    expect(applyToggleSet(before, { disclosure: "off" })[last]!.on).toBe(false);
  });

  it("hasChanges ignores a set that is all `keep`", () => {
    expect(hasChanges({})).toBe(false);
    expect(hasChanges({ intro: "keep", grade: "keep" })).toBe(false);
    expect(hasChanges({ grade: "off" })).toBe(true);
  });
});

describe("applyBlockToggles (US-2962)", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  function statuses(rows: { id: string; listing_status: string }[]) {
    listings.select.mockReturnValue(listings);
    listings.in.mockResolvedValue({ data: rows, error: null });
  }

  beforeEach(() => {
    from.mockClear();
    listings.select.mockReset();
    listings.in.mockReset();
    edgeFetch.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("does nothing at all when no section was set", async () => {
    const r = await applyBlockToggles(["a"], { intro: "keep" });
    expect(r).toEqual({ applied: 0, unchanged: 0, skipped: 0, failed: 0 });
    expect(from).not.toHaveBeenCalled();
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  it("loads, toggles and saves each draft through the description routes", async () => {
    statuses([{ id: "d1", listing_status: "draft" }]);
    edgeFetch
      .mockResolvedValueOnce(ok({ blocks: blocks() }))
      .mockResolvedValueOnce(ok({ description: "rendered" }));

    const r = await applyBlockToggles(["d1"], { measurements: "off" });

    expect(r).toEqual({ applied: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(edgeFetch.mock.calls[0]![0]).toBe(
      "/api/flipdesk/description/d1/blocks?unit=in",
    );
    const [path, opts] = edgeFetch.mock.calls[1] as [string, { json: { blocks: DescriptionBlock[] } }];
    expect(path).toBe("/api/flipdesk/description/d1/save");
    expect(opts.json.blocks.find((b) => b.key === "measurements")!.on).toBe(false);
  });

  it("SKIPS a selected listing that is no longer a draft", async () => {
    // The one that matters. The grid loaded these as drafts; one of them went
    // live in another tab, and a bulk toolbar must not rewrite live copy.
    statuses([
      { id: "d1", listing_status: "draft" },
      { id: "live", listing_status: "active" },
    ]);
    edgeFetch
      .mockResolvedValueOnce(ok({ blocks: blocks() }))
      .mockResolvedValueOnce(ok({ description: "rendered" }));

    const r = await applyBlockToggles(["d1", "live"], { grade: "on" });

    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
    for (const call of edgeFetch.mock.calls) {
      expect(String(call[0])).not.toContain("live");
    }
  });

  it("converts a legacy draft first and sends its other blocks back unchanged", async () => {
    // AC3. A listing whose description_blocks is null comes back from GET
    // already parsed, and the only thing this run is allowed to change is the
    // `on` flag of the sections the seller named. The verbatim text block, its
    // separator and the array order all have to survive the trip.
    const legacy: DescriptionBlock[] = [
      { key: "text", on: true, src: "user", text: "Veronica Beard pants.", sep: "" },
      { key: "measurements", on: true, src: "item", sep: "\n\n\n" },
      { key: "credentials", on: true, src: "seller", sep: "\n" },
    ];
    statuses([{ id: "legacy-1", listing_status: "draft" }]);
    edgeFetch
      .mockResolvedValueOnce(ok({ blocks: legacy, converted: true }))
      .mockResolvedValueOnce(ok({ description: "rendered" }));

    const r = await applyBlockToggles(["legacy-1"], { measurements: "off" });

    expect(r.applied).toBe(1);
    const [, opts] = edgeFetch.mock.calls[1] as [string, { json: { blocks: DescriptionBlock[] } }];
    expect(opts.json.blocks).toEqual([
      { key: "text", on: true, src: "user", text: "Veronica Beard pants.", sep: "" },
      { key: "measurements", on: false, src: "item", sep: "\n\n\n" },
      { key: "credentials", on: true, src: "seller", sep: "\n" },
    ]);
  });

  it("counts a row RLS did not return as skipped, not as applied", async () => {
    statuses([]);
    const r = await applyBlockToggles(["someone-elses"], { grade: "on" });
    expect(r).toEqual({ applied: 0, unchanged: 0, skipped: 1, failed: 0 });
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  it("skips the save when the draft is already set that way", async () => {
    statuses([{ id: "d1", listing_status: "draft" }]);
    edgeFetch.mockResolvedValueOnce(ok({ blocks: blocks() }));

    const r = await applyBlockToggles(["d1"], { intro: "on" });

    expect(r).toEqual({ applied: 0, unchanged: 1, skipped: 0, failed: 0 });
    expect(edgeFetch).toHaveBeenCalledTimes(1);
  });

  it("counts a refused save as failed and keeps going", async () => {
    statuses([
      { id: "d1", listing_status: "draft" },
      { id: "d2", listing_status: "draft" },
    ]);
    edgeFetch
      .mockResolvedValueOnce(ok({ blocks: blocks() }))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(ok({ blocks: blocks() }))
      .mockResolvedValueOnce(ok({ description: "rendered" }));

    const r = await applyBlockToggles(["d1", "d2"], { measurements: "off" });

    expect(r.failed).toBe(1);
    expect(r.applied).toBe(1);
  });

  it("reports every draft as failed when the status read itself fails", async () => {
    listings.select.mockReturnValue(listings);
    listings.in.mockResolvedValue({ data: null, error: new Error("boom") });
    const r = await applyBlockToggles(["d1", "d2"], { grade: "on" });
    expect(r.failed).toBe(2);
    expect(edgeFetch).not.toHaveBeenCalled();
  });
});

describe("bulkBlockSummary (US-2962)", () => {
  it("says how many were skipped and why", () => {
    expect(
      bulkBlockSummary({ applied: 12, unchanged: 0, skipped: 3, failed: 0 }),
    ).toBe("Updated 12 drafts. 3 skipped, because they are no longer drafts.");
    expect(
      bulkBlockSummary({ applied: 1, unchanged: 0, skipped: 1, failed: 0 }),
    ).toBe("Updated 1 draft. 1 skipped, because it is no longer a draft.");
  });

  it("distinguishes already-set from failed", () => {
    expect(
      bulkBlockSummary({ applied: 2, unchanged: 5, skipped: 0, failed: 1 }),
    ).toBe("Updated 2 drafts. 5 were already set that way. 1 did not save.");
  });
});
