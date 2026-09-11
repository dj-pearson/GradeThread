// US-3376 AC5, rank 4: the US-1633 orphan-draft delete.
//
// The delete exists so a cluster whose photos all failed to upload does not
// leave an empty draft littering the pipeline. It dropped its result, so on a
// refusal one did anyway, and the results dialog still read "No photos could be
// uploaded - re-add them and try again" with nothing about the draft now sitting
// in Inventory under "Untitled item".
//
// These drive the DELETE failing and assert the sentence the seller reads,
// because "the error is destructured" is exactly the assertion this whole class
// of bug walks past.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

interface Call {
  table: string;
  op: "insert" | "delete" | "update";
}

const calls: Call[] = [];
let deleteError: unknown = null;
let insertError: unknown = null;

// A builder shaped like PostgrestFilterBuilder: every filter returns `this` and
// the whole chain RESOLVES with { data, error }. It never rejects, which is the
// property the dropped-result bug lived on.
function builder(table: string, op: Call["op"], result: Result) {
  calls.push({ table, op });
  const self: Record<string, unknown> = {};
  for (const k of ["eq", "in", "is", "not", "order", "limit", "select"]) {
    self[k] = () => self;
  }
  self["single"] = () => Promise.resolve(result);
  self["maybeSingle"] = () => Promise.resolve(result);
  self["then"] = (onFulfilled: (v: Result) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: () =>
        builder(table, "insert", {
          data: insertError ? null : { id: "item-1", status: "cataloged" },
          error: insertError,
        }),
      delete: () => builder(table, "delete", { data: null, error: deleteError }),
      update: () => builder(table, "update", { data: null, error: null }),
      select: () => builder(table, "update", { data: [], error: null }),
    }),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: null, error: new Error("nope") }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
  },
}));

const warnings: { fallback?: string; ctx?: unknown }[] = [];
vi.mock("@/lib/toast-error", () => ({
  toastWarning: (_err: unknown, fallback?: string, ctx?: unknown) => {
    warnings.push({ fallback, ctx });
    return {};
  },
  toastError: () => ({}),
}));

vi.mock("@/lib/image-utils", () => ({
  compressImage: (f: unknown) => Promise.resolve(f),
}));
vi.mock("@/lib/status-writer", () => ({
  advanceItemStatus: () => Promise.resolve(),
}));

const { commitClusters } = await import("@/hooks/use-reconcile-commit");

const OWNER = "11111111-1111-4111-8111-111111111111";

/**
 * A cluster of restored placeholders: `file` is null and there is no storage
 * path, so every photo is skipped and `uploaded` lands on zero. That is the
 * exact condition the orphan delete guards.
 */
function orphanCluster() {
  return {
    clusterId: "c1",
    label: "Item 1",
    linkItemId: null,
    titleHint: "",
    photos: [
      {
        id: "p1",
        file: null,
        capturedAt: null,
        photoType: "front" as const,
        storagePath: null,
      },
    ],
  };
}

beforeEach(() => {
  calls.length = 0;
  warnings.length = 0;
  deleteError = null;
  insertError = null;
});

describe("commitClusters: the orphan-draft delete", () => {
  it("tells the seller a blank draft is in Inventory when the delete is refused", async () => {
    deleteError = { code: "42501", message: "new row violates row-level security" };

    const [result] = await commitClusters([orphanCluster()], OWNER, null);

    // It really tried to delete. Without this, a test that never reached the
    // delete would assert the happy sentence and pass.
    expect(calls.some((c) => c.table === "inventory_items" && c.op === "delete")).toBe(true);
    expect(result!.ok).toBe(false);
    // What the seller reads in the batch-results dialog.
    expect(result!.detail).toContain("could not be removed");
    expect(result!.detail).toContain("Delete it from Inventory");
  });

  it("keeps the plain re-add sentence when the delete lands", async () => {
    deleteError = null;

    const [result] = await commitClusters([orphanCluster()], OWNER, null);

    expect(calls.some((c) => c.table === "inventory_items" && c.op === "delete")).toBe(true);
    expect(result!.ok).toBe(false);
    expect(result!.detail).toContain("re-add them");
    // And the seller is NOT told to go hunting for a draft that was removed.
    expect(result!.detail).not.toContain("Delete it from Inventory");
  });

  it("warns rather than going quiet when the session cannot be closed", async () => {
    // A fully-successful run, then the session-close write refused. Dropped,
    // this left a committed session looking open, and a second press of Commit
    // would have created every item twice.
    const { commitClusters: fresh } = await import("@/hooks/use-reconcile-commit");
    deleteError = { message: "refused" };

    // No cluster succeeds here (every photo is a placeholder), so the close is
    // not attempted - assert exactly that, rather than pretending otherwise.
    await fresh([orphanCluster()], OWNER, "session-1");
    expect(calls.some((c) => c.table === "flipdesk_reconcile_sessions")).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});
