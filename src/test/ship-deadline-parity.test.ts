import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_HANDLING_DAYS, shipDeadlineOf } from "@/lib/work-candidates";

// US-3168: the planner's ship-by copy, pinned to the edge's original.
//
// WHY A COPY EXISTS AT ALL. services/edge-functions runs on Deno with its own
// import map and src/ runs on Vite with the @/ alias; neither can import the
// other's modules, so a rule needed on both sides is written twice. That is the
// repo's existing answer (sale-math.ts pins the net-profit formula to the edge
// the same way), and it is only safe while something reads BOTH sources and
// fails when they disagree.
//
// WHAT IS PINNED is the part that changes the answer: the maximum believable
// handling time, and the PRECEDENCE -- marketplace date, then sold_at plus
// handling days, then null. The planner adds a provenance label the edge does
// not need, so the shapes differ on purpose and the test does not compare them.

const EDGE = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/ship-deadline.ts",
);

function edgeSource(): string {
  return readFileSync(EDGE, "utf8");
}

describe("ship-by parity with the edge (US-3168)", () => {
  it("the maximum handling time is the same number on both sides", () => {
    const src = edgeSource();
    const m = /export const MAX_HANDLING_DAYS = (\d+);/.exec(src);
    expect(m, "MAX_HANDLING_DAYS moved or was renamed on the edge").not.toBeNull();
    expect(Number(m![1])).toBe(MAX_HANDLING_DAYS);
  });

  it("the edge still resolves in the order the planner copies", () => {
    const src = edgeSource();
    const body = src.slice(src.indexOf("export function resolveShipBy"));
    const reportedAt = body.indexOf("input.shipByDate");
    const soldAt = body.indexOf("input.soldAt");
    const daysAt = body.indexOf("input.handlingDays");
    expect(reportedAt).toBeGreaterThan(-1);
    expect(soldAt).toBeGreaterThan(reportedAt);
    expect(daysAt).toBeGreaterThan(soldAt);
  });

  it("the edge still treats zero handling days as a real answer", () => {
    // The planner reports that as an estimated deadline of the sale instant.
    // If the edge ever starts refusing zero the two disagree about same-day
    // dispatch, which is a whole class of order.
    expect(edgeSource()).toMatch(/days < 0/);
    expect(shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z", handlingDays: 0 }))
      .toEqual({ at: "2026-09-21T10:00:00.000Z", confidence: "estimated" });
  });

  it("neither side invents a deadline when it has nothing", () => {
    expect(edgeSource()).toMatch(/return null;/);
    expect(shipDeadlineOf({}).at).toBeNull();
    expect(shipDeadlineOf({}).confidence).toBe("unknown");
  });
});
