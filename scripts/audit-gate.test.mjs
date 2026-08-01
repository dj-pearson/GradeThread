// Coverage for the npm-audit gate (Node env — see vitest.scripts.config.mjs).
//
// The behaviours worth pinning are the ones that make an allowlist safe rather
// than convenient: a row must be specific, it must expire, and a malformed row
// must NOT accept anything.
import { describe, expect, it } from "vitest";
import { collectAdvisories, evaluate, parseAllowlist } from "./audit-gate.mjs";

const advisory = (over = {}) => ({
  id: "GHSA-AAAA-BBBB-CCCC",
  package: "left-pad",
  severity: "high",
  title: "bad thing",
  url: "https://github.com/advisories/GHSA-AAAA-BBBB-CCCC",
  ...over,
});

describe("parseAllowlist", () => {
  it("reads the advisory id and re-check date out of a table row", () => {
    const md = `
| Advisory | Package | Severity | Why | Re-check by |
|---|---|---|---|---|
| GHSA-AAAA-BBBB-CCCC | left-pad | high | not reachable | 2026-09-01 |
`;
    expect(parseAllowlist(md)).toEqual([
      { id: "GHSA-AAAA-BBBB-CCCC", package: "left-pad", recheckBy: "2026-09-01" },
    ]);
  });

  it("ignores the header and separator rows", () => {
    const md = "| Advisory | Package | Severity | Why | Re-check by |\n|---|---|---|---|---|\n";
    expect(parseAllowlist(md)).toEqual([]);
  });

  it("fails CLOSED on a row with no date — a malformed acceptance accepts nothing", () => {
    const md = "| GHSA-AAAA-BBBB-CCCC | left-pad | high | reason | soon |\n";
    expect(parseAllowlist(md)).toEqual([]);
  });
});

describe("collectAdvisories", () => {
  it("reads advisory objects out of `via` and skips the string back-references", () => {
    const out = collectAdvisories({
      vulnerabilities: {
        "left-pad": { name: "left-pad", via: [{ source: 1, name: "left-pad", url: advisory().url, severity: "high", title: "bad thing" }] },
        "uses-left-pad": { name: "uses-left-pad", via: ["left-pad"] },
      },
    });
    expect(out).toEqual([advisory()]);
  });

  it("dedupes one advisory reaching the tree through two packages", () => {
    const via = { source: 1, name: "left-pad", url: advisory().url, severity: "high", title: "bad thing" };
    const out = collectAdvisories({
      vulnerabilities: { a: { name: "a", via: [via] }, b: { name: "b", via: [via] } },
    });
    expect(out).toHaveLength(1);
  });
});

describe("evaluate", () => {
  const allowed = [{ id: "GHSA-AAAA-BBBB-CCCC", package: "left-pad", recheckBy: "2026-09-01" }];

  it("blocks an advisory that is not listed", () => {
    const { blocking } = evaluate([advisory({ id: "GHSA-ZZZZ-ZZZZ-ZZZZ" })], allowed, "2026-08-01");
    expect(blocking).toHaveLength(1);
  });

  it("accepts a listed advisory before its re-check date", () => {
    const { blocking, accepted } = evaluate([advisory()], allowed, "2026-08-01");
    expect(blocking).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it("blocks again once the acceptance has expired", () => {
    const { blocking } = evaluate([advisory()], allowed, "2026-09-02");
    expect(blocking).toHaveLength(1);
    expect(blocking[0].reason).toMatch(/expired/);
  });

  it("does not block moderate or low findings — the threshold is still high", () => {
    const { blocking } = evaluate([advisory({ id: "GHSA-ZZZZ-ZZZZ-ZZZZ", severity: "moderate" })], allowed, "2026-08-01");
    expect(blocking).toEqual([]);
  });

  it("accepting one advisory does not accept a second one in the SAME package", () => {
    const { blocking } = evaluate(
      [advisory(), advisory({ id: "GHSA-DDDD-EEEE-FFFF", title: "a different hole" })],
      allowed,
      "2026-08-01",
    );
    expect(blocking).toHaveLength(1);
    expect(blocking[0].id).toBe("GHSA-DDDD-EEEE-FFFF");
  });
});
