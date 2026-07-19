// US-2076: vitest coverage for the shipped-copy drift guard (Node env — see
// vitest.scripts.config.mjs).
import { describe, expect, it } from "vitest";
import { checkPairs, parseRunbookSources } from "./runbook-sync.mjs";

const at = (day) => () => `${day}T12:00:00+00:00`;
const yes = () => true;
const pair = (over = {}) => ({ slug: "deploy-order", sourceNote: "vault/10-ops/deploy.md", reviewed: "2026-07-01", ...over });

describe("parseRunbookSources", () => {
  it("pairs each slug with its own sourceNote and reviewed", () => {
    const src = `
      { slug: "a", sourceNote: "vault/x.md", reviewed: "2026-01-01", body: "" },
      { slug: "b", sourceNote: "vault/y.md", reviewed: "2026-02-02", body: "" },
    `;
    expect(parseRunbookSources(src)).toEqual([
      { slug: "a", sourceNote: "vault/x.md", reviewed: "2026-01-01" },
      { slug: "b", sourceNote: "vault/y.md", reviewed: "2026-02-02" },
    ]);
  });
  it("does NOT lend a tagged entry's fields to an untagged one that follows", () => {
    // The regression this exists for: an untagged runbook silently inheriting
    // the previous entry's source would report as guarded while being guarded
    // by nothing.
    const src = `
      { slug: "tagged", sourceNote: "vault/x.md", reviewed: "2026-01-01", body: "" },
      { slug: "untagged", body: "" },
    `;
    const out = parseRunbookSources(src);
    expect(out[1]).toEqual({ slug: "untagged", sourceNote: null, reviewed: null });
  });
});

describe("checkPairs", () => {
  it("passes when the note is older than the review date", () => {
    const r = checkPairs([pair()], { commitTime: at("2026-06-01"), exists: yes });
    expect(r.errors).toEqual([]);
  });
  it("FAILS when the source note moved after the review date", () => {
    const r = checkPairs([pair()], { commitTime: at("2026-07-10"), exists: yes });
    expect(r.errors[0]).toMatch(/SHIPPED COPY MAY BE STALE/);
  });
  it("passes on the review date itself", () => {
    const r = checkPairs([pair()], { commitTime: at("2026-07-01"), exists: yes });
    expect(r.errors).toEqual([]);
  });
  it("errors when the sourceNote does not exist", () => {
    const r = checkPairs([pair()], { commitTime: at("2026-01-01"), exists: () => false });
    expect(r.errors[0]).toMatch(/does not exist/);
  });
  it("errors when a sourceNote is set but reviewed is missing", () => {
    const r = checkPairs([pair({ reviewed: null })], { commitTime: at("2026-01-01"), exists: yes });
    expect(r.errors[0]).toMatch(/reviewed is missing or malformed/);
  });
  it("warns, not errors, for a runbook with no vault counterpart", () => {
    const r = checkPairs([pair({ sourceNote: null })], { commitTime: at("2026-01-01"), exists: yes });
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/no sourceNote/);
  });
  it("skips a note git has no record of rather than guessing", () => {
    const r = checkPairs([pair()], { commitTime: () => null, exists: yes });
    expect(r.errors).toEqual([]);
  });
});
