import { describe, it, expect, vi, beforeEach } from "vitest";

// US-3389. The four AutoLister cleanups were a bare `void ....remove(orphans)`: no
// await, no error read, no `void` to even discard. The mocks below RESOLVE with
// `{ error }` and never reject, because that is the property the whole bug
// lives on: a rejecting mock would prove the opposite of what these claim.
const captured = vi.hoisted(() => vi.fn());
const warned = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sentry", () => ({ captureException: captured }));
vi.mock("sonner", () => ({ toast: { warning: warned } }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: () => {
        throw new Error("the real bucket must not be reached from a test");
      },
    },
  },
}));

import { discardStagedObjects } from "../discard-staged-objects";

function store(error: unknown) {
  const calls: string[][] = [];
  return {
    calls,
    remove: (paths: string[]) => {
      calls.push(paths);
      return Promise.resolve({ error });
    },
  };
}

const PATHS = ["u1/_staging/s1/a.jpg", "u1/_staging/s1/a_thumb.jpg"];

describe("discardStagedObjects (US-3389)", () => {
  beforeEach(() => {
    captured.mockClear();
    warned.mockClear();
  });

  it("removes the objects and reports nothing on success", async () => {
    const s = store(null);
    await expect(discardStagedObjects(PATHS, "delete staged photos", { store: s }))
      .resolves.toBe(true);
    expect(s.calls).toEqual([PATHS]);
    expect(captured).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  it("does not call storage at all for an empty list", async () => {
    const s = store(null);
    await expect(discardStagedObjects([], "delete staged photos", { store: s }))
      .resolves.toBe(true);
    expect(s.calls).toEqual([]);
  });

  it("reports a RESOLVED refusal and answers false", async () => {
    const s = store({ message: "Object not found" });
    await expect(
      discardStagedObjects(PATHS, "re-stage processed photo", { store: s }),
    ).resolves.toBe(false);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0]?.[1]).toMatchObject({
      extra: { user_action: "re-stage processed photo", stranded_objects: PATHS },
    });
  });

  it("does NOT reject, so a caller's loop cannot be aborted by a refusal", async () => {
    // restageProcessed's cleanup runs once per photo inside two sequential
    // batch loops (applyBgToAll, enhanceAll). A throw there would stop the
    // batch partway and leave a worse mixed state, the shape US-3381 hit with
    // the SKU throw.
    const s = store({ message: "403" });
    let after = 0;
    for (const p of [PATHS, PATHS, PATHS]) {
      await discardStagedObjects(p, "undo background removal", { store: s });
      after++;
    }
    expect(after).toBe(3);
    expect(s.calls.length).toBe(3);
  });

  it("stays silent on screen unless the caller asks to notify", async () => {
    const s = store({ message: "403" });
    await discardStagedObjects(PATHS, "replace staged photo with an edit", {
      store: s,
    });
    expect(warned).not.toHaveBeenCalled();
  });

  it("warns the seller on the path where THEY pressed Delete", async () => {
    const s = store({ message: "403" });
    await discardStagedObjects(PATHS, "delete staged photos", {
      store: s,
      notify: true,
    });
    expect(warned).toHaveBeenCalledTimes(1);
    const copy = String(warned.mock.calls[0]?.[0]);
    // It has to say what happened and what is still true, not just "error".
    expect(copy).toMatch(/2 photo files/);
    expect(copy).toMatch(/out of your batch/i);
  });
});
