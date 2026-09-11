// US-3376 AC5, rank 2: the composer's garment_type / garment_category write.
//
// GradeThisItemCard's inline picker calls onPatchGarment and then returns
// immediately - "no round-trip here", says its own comment. The composer DOES do
// a round-trip, and it used to drop the result twice over: an async IIFE behind
// `void`, with the update's `{ error }` never destructured. The card had already
// cleared its garment blocker and the invalidates cleared the preview, so a
// refused write read as saved, and the next press of "Submit for grading" paid
// to grade the OLD garment type.
//
// What is asserted here is what the seller SEES, not that an error was
// destructured: on failure a toast names the garment type and says to pick it
// again before submitting; on success there is no toast at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

let updateError: unknown = null;
const updates: { table: string; patch: Record<string, unknown>; id: string }[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        // Resolves with { error }. It does NOT reject - that is the whole
        // reason a try/catch around one of these is not protection.
        eq: (_col: string, id: string) => {
          updates.push({ table, patch, id });
          return Promise.resolve({ data: null, error: updateError });
        },
      }),
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

const errorToasts: { fallback?: string; nextStep?: string }[] = [];
vi.mock("@/lib/toast-error", () => ({
  toastError: (
    _err: unknown,
    fallback?: string,
    ctx?: { nextStep?: string },
  ) => {
    errorToasts.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
  toastWarning: () => ({}),
}));

const { persistGarmentPatch } = await import("@/pages/flipdesk/composer");

const invalidated: unknown[][] = [];
function fakeQueryClient() {
  return {
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof persistGarmentPatch>[3];
}

beforeEach(() => {
  updates.length = 0;
  invalidated.length = 0;
  errorToasts.length = 0;
  updateError = null;
});

describe("persistGarmentPatch", () => {
  it("says so, out loud, when the garment write is refused", async () => {
    updateError = {
      code: "42501",
      message: "new row violates row-level security policy",
    };

    await persistGarmentPatch("item-1", "outerwear", "jacket", fakeQueryClient());

    // Prove the write was attempted with the picked values. Without this a
    // version that never issued the update would satisfy the toast assertion.
    expect(updates).toEqual([
      {
        table: "inventory_items",
        id: "item-1",
        patch: { garment_type: "outerwear", garment_category: "jacket" },
      },
    ]);
    expect(errorToasts).toHaveLength(1);
    expect(errorToasts[0]!.fallback).toBe("Couldn't save the garment type.");
    // The instruction has to name the consequence the seller is about to pay
    // for, not just "try again".
    expect(errorToasts[0]!.nextStep).toContain("submit this for grading");
  });

  it("still refreshes the reads on failure, so the stale value comes back", async () => {
    // The card cleared its own blocker synchronously. If the invalidates were
    // skipped on failure, the cleared preview would stand beside the error
    // toast and the two would disagree.
    updateError = { message: "refused" };

    await persistGarmentPatch("item-9", "tops", "t-shirt", fakeQueryClient());

    expect(invalidated).toEqual([
      ["inventory_item_ebay", "item-9"],
      ["items_full"],
    ]);
  });

  it("stays silent when the write lands", async () => {
    await persistGarmentPatch("item-2", "bottoms", "jeans", fakeQueryClient());

    expect(updates).toHaveLength(1);
    expect(errorToasts).toHaveLength(0);
  });
});
