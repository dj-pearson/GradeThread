// AL-13: Undo within the window sends no storage delete; letting it lapse, or
// hiding the page, sends exactly one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discard-staged-objects", () => ({ discardStagedObjects: vi.fn() }));

import { DELETE_UNDO_MS, PendingDeletes } from "../pending-deletes";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PendingDeletes (AL-13)", () => {
  it("Undo within 8 s sends no storage delete for 200 photos", () => {
    const discard = vi.fn();
    const d = new PendingDeletes(discard);
    const paths = Array.from({ length: 200 }, (_, i) => `o/_staging/s/${i}.jpg`);
    const id = d.schedule(paths);
    vi.advanceTimersByTime(DELETE_UNDO_MS - 1);
    expect(d.cancel(id)).toBe(true);
    vi.advanceTimersByTime(DELETE_UNDO_MS * 2);
    expect(discard).not.toHaveBeenCalled();
  });

  it("the delete runs once when the window lapses, and Undo is then too late", () => {
    const discard = vi.fn();
    const d = new PendingDeletes(discard);
    const id = d.schedule(["a", "b"]);
    vi.advanceTimersByTime(DELETE_UNDO_MS);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(["a", "b"]);
    expect(d.cancel(id)).toBe(false);
  });

  it("flushAll (pagehide) sends every queued delete now", () => {
    const discard = vi.fn();
    const d = new PendingDeletes(discard);
    d.schedule(["a"]);
    d.schedule(["b"]);
    d.flushAll();
    expect(discard).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(DELETE_UNDO_MS);
    expect(discard).toHaveBeenCalledTimes(2);
  });
});
