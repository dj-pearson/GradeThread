// US-2934: the ranking behind the "needs you" list.
//
// The rule this pins is the one every "sort by value" version of this screen
// gets backwards: a $200 dispute due next week is LESS urgent than a $12 return
// due today. Only the deadline can be lost by waiting.
import { describe, it, expect } from "vitest";
import { rankNeedsYou, type NeedsYouItem } from "@/pages/flipdesk/needs-you";

const item = (over: Partial<NeedsYouItem> & { id: string }): NeedsYouItem => ({
  kind: "return",
  subject: over.id,
  deadline: null,
  amountCents: null,
  action: "Answer",
  ...over,
});

describe("rankNeedsYou", () => {
  it("puts the sooner deadline first, whatever the money says", () => {
    const out = rankNeedsYou([
      item({ id: "big-later", deadline: "2026-09-05T00:00:00Z", amountCents: 20_000 }),
      item({ id: "small-today", deadline: "2026-08-27T00:00:00Z", amountCents: 1_200 }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["small-today", "big-later"]);
  });

  it("breaks a deadline tie with money, largest first", () => {
    const out = rankNeedsYou([
      item({ id: "cheap", deadline: "2026-08-27T00:00:00Z", amountCents: 500 }),
      item({ id: "dear", deadline: "2026-08-27T00:00:00Z", amountCents: 9_000 }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["dear", "cheap"]);
  });

  it("puts an item with NO deadline LAST", () => {
    // eBay is running no clock on it, so it is genuinely less urgent than
    // anything that has one — the opposite of "unknown is scary".
    const out = rankNeedsYou([
      item({ id: "undated", amountCents: 50_000 }),
      item({ id: "dated", deadline: "2026-09-30T00:00:00Z", amountCents: 100 }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["dated", "undated"]);
  });

  it("treats an unreadable deadline as no deadline", () => {
    const out = rankNeedsYou([
      item({ id: "junk", deadline: "whenever" }),
      item({ id: "real", deadline: "2026-09-30T00:00:00Z" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["real", "junk"]);
  });

  it("does NOT let the case type override the clock", () => {
    // A case is more damaging than a return. A case due in six days is still
    // not more urgent than a return due in three hours, and encoding a severity
    // order would quietly override the deadline this whole list is sorted by.
    const out = rankNeedsYou([
      item({ id: "case-later", kind: "case", deadline: "2026-09-02T00:00:00Z" }),
      item({ id: "return-now", kind: "return", deadline: "2026-08-27T03:00:00Z" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["return-now", "case-later"]);
  });

  it("is stable and does not mutate its input", () => {
    const input = [
      item({ id: "b", deadline: "2026-08-27T00:00:00Z" }),
      item({ id: "a", deadline: "2026-08-27T00:00:00Z" }),
    ];
    const before = input.map((i) => i.id);
    expect(rankNeedsYou(input).map((i) => i.id)).toEqual(
      rankNeedsYou(input).map((i) => i.id),
    );
    expect(input.map((i) => i.id)).toEqual(before);
  });
});
