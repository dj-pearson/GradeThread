// US-1612: vitest coverage for the progress digest (Node env — see
// vitest.scripts.config.mjs).
import { describe, expect, it } from "vitest";
import { computeBlocked, digest, parseProgressEntries } from "./prd-digest.mjs";

describe("parseProgressEntries", () => {
  it("extracts dated headers + story ids, tolerates undated headers", () => {
    const text = [
      "=== 2026-07-05 (loop): US-1602 (Growth agent) ===",
      "some body text mentioning US-9999 (ignored — not a header)",
      "=== an undated header ===",
      "=== 2026-06-01 US-100 + US-101 done ===",
    ].join("\n");
    const entries = parseProgressEntries(text);
    expect(entries).toHaveLength(3);
    expect(entries[0].date).toBe("2026-07-05");
    expect(entries[0].ids).toContain("US-1602");
    expect(entries[1].date).toBe(null);
    expect(entries[2].ids).toEqual(["US-100", "US-101"]);
  });
});

describe("computeBlocked", () => {
  it("blocks an open story whose dependsOn points at another OPEN story", () => {
    const prd = {
      userStories: [
        { id: "US-1", passes: false, dependsOn: ["US-2"] }, // blocked (US-2 open)
        { id: "US-2", passes: false },
        { id: "US-3", passes: false, dependsOn: ["US-9"] }, // US-9 not open here → not blocked by that rule... but unknown
        { id: "US-4", passes: false, dependsOn: ["US-5"] }, // US-5 is done → satisfied
        { id: "US-5", passes: true },
      ],
    };
    const blocked = computeBlocked(prd);
    const ids = blocked.map((b) => b.id).sort();
    expect(ids).toEqual(["US-1"]);
    expect(blocked[0].blockedBy).toEqual(["US-2"]);
  });
});

describe("digest", () => {
  const prd = {
    userStories: [
      { id: "US-1", title: "Done thing", passes: true },
      { id: "US-2", title: "Open ready thing", passes: false },
      { id: "US-3", title: "Blocked thing", passes: false, dependsOn: ["US-2"] },
    ],
  };
  const progressText = [
    "=== 2026-07-05 (loop): US-1 landed ===",
    "body",
    "=== 2026-06-01 old entry ===",
  ].join("\n");

  it("summarizes backlog counts (ready vs blocked) + lands entries in range", () => {
    const md = digest({ progressText, prd, sinceDate: "2026-07-01" });
    expect(md).toContain("1 done, 2 open");
    expect(md).toContain("1 ready, 1 blocked");
    expect(md).toContain("Landed since 2026-07-01 (1)");
    expect(md).toContain("2026-07-05");
    expect(md).not.toContain("old entry"); // 2026-06-01 < since
    expect(md).toContain("US-3 — waiting on US-2");
  });

  it("without a since date lists all dated entries", () => {
    const md = digest({ progressText, prd, sinceDate: null });
    expect(md).toContain("Landed (2)");
  });
});
