import { describe, expect, it } from "vitest";
import {
  offlineSavedMessage,
  planIntakeSave,
  resolveIntakeSourceChoice,
} from "@/lib/intake-save-plan";

describe("resolveIntakeSourceChoice", () => {
  it("reads the picker's sentinel values", () => {
    expect(resolveIntakeSourceChoice("__new", "  Bins  ")).toEqual({ kind: "new", name: "Bins" });
    expect(resolveIntakeSourceChoice("__new", "   ")).toEqual({ kind: "none" });
    expect(resolveIntakeSourceChoice("__none", "")).toEqual({ kind: "none" });
    expect(resolveIntakeSourceChoice("", "")).toEqual({ kind: "none" });
    expect(resolveIntakeSourceChoice("src-1", "ignored")).toEqual({ kind: "existing", id: "src-1" });
  });
});

describe("planIntakeSave", () => {
  it("offline with a new source queues the NAME instead of failing", () => {
    const plan = planIntakeSave({
      online: false,
      source: { kind: "new", name: "Goodwill bins" },
      photoCount: 0,
    });
    expect(plan).toEqual({
      route: "queue",
      sourceId: null,
      newSourceName: "Goodwill bins",
      photoCount: 0,
    });
  });

  it("offline with staged photos queues them and the message says so", () => {
    const plan = planIntakeSave({
      online: false,
      source: { kind: "existing", id: "src-1" },
      photoCount: 3,
    });
    expect(plan).toMatchObject({ route: "queue", sourceId: "src-1", photoCount: 3 });
    if (plan.route !== "queue") throw new Error("expected queue");
    const msg = offlineSavedMessage("Wool coat", plan);
    expect(msg).toContain("3 photos");
    expect(msg).toMatch(/offline/);
  });

  it("names both the photos and the new source in one message", () => {
    const plan = planIntakeSave({
      online: false,
      source: { kind: "new", name: "Estate sale" },
      photoCount: 1,
    });
    if (plan.route !== "queue") throw new Error("expected queue");
    expect(offlineSavedMessage("Tee", plan)).toBe(
      'Saved "Tee", with 1 photo and the new source "Estate sale", offline. It will sync when you reconnect.',
    );
  });

  it("online creates the new source first, then inserts", () => {
    expect(
      planIntakeSave({ online: true, source: { kind: "new", name: "Bins" }, photoCount: 2 }),
    ).toEqual({ route: "insert", sourceId: null, newSourceName: "Bins" });
  });
});
