import { describe, expect, it } from "vitest";
import {
  RUNBOOKS,
  RUNBOOK_CATEGORIES,
  getRunbook,
  searchRunbooks,
} from "../runbooks";

// US-910 AC5: "No secrets/credentials are rendered in these docs — verified by
// a content check." This suite is that check, plus structural guards so a future
// edit can't ship a malformed or unsafe runbook.

// Patterns that strongly indicate a real secret VALUE leaked into the prose.
// Env-var NAMES (e.g. SUPABASE_SERVICE_ROLE_KEY) are fine and expected; only
// concrete values are forbidden.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "stripe secret/restricted key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/ },
  { name: "stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{8,}/ },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "jwt / supabase key", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "anthropic key", re: /\bsk-ant-[A-Za-z0-9-]{8,}/ },
  { name: "pem/private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // An env assignment with a value that isn't an obvious placeholder.
  {
    name: "env var with inline value",
    re: /\b[A-Z][A-Z0-9_]{3,}(?:KEY|SECRET|TOKEN|PASSWORD|PASS|DSN)\s*=\s*(?!$|<|\$|\.\.\.|your|xxx|placeholder|\s)[^\s]+/,
  },
];

describe("operational runbooks", () => {
  it("renders no secrets or credential values (AC5)", () => {
    for (const rb of RUNBOOKS) {
      const haystack = `${rb.summary}\n${rb.body}\n${rb.keywords.join(" ")}`;
      for (const { name, re } of SECRET_PATTERNS) {
        const match = haystack.match(re);
        expect(
          match,
          `runbook "${rb.slug}" appears to contain a ${name}: ${match?.[0]}`,
        ).toBeNull();
      }
    }
  });

  it("has unique, url-safe slugs", () => {
    const slugs = RUNBOOKS.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug, `slug "${slug}" is not url-safe`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every runbook is complete", () => {
    expect(RUNBOOKS.length).toBeGreaterThan(0);
    for (const rb of RUNBOOKS) {
      expect(rb.title.length, rb.slug).toBeGreaterThan(0);
      expect(rb.category.length, rb.slug).toBeGreaterThan(0);
      expect(rb.summary.length, rb.slug).toBeGreaterThan(0);
      expect(rb.body.length, rb.slug).toBeGreaterThan(50);
      expect(rb.keywords.length, rb.slug).toBeGreaterThan(0);
    }
  });

  it("every control deep-links to an in-app admin route (AC2)", () => {
    const hasAnyControl = RUNBOOKS.some((r) => r.controls.length > 0);
    expect(hasAnyControl).toBe(true);
    for (const rb of RUNBOOKS) {
      for (const control of rb.controls) {
        expect(control.label.length, rb.slug).toBeGreaterThan(0);
        expect(control.description.length, rb.slug).toBeGreaterThan(0);
        expect(
          control.to.startsWith("/admin/") || control.to.startsWith("/dashboard/"),
          `control "${control.label}" in "${rb.slug}" must link to an in-app admin route, got "${control.to}"`,
        ).toBe(true);
      }
    }
  });

  it("derives categories in first-seen order", () => {
    expect(RUNBOOK_CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(RUNBOOK_CATEGORIES).size).toBe(RUNBOOK_CATEGORIES.length);
  });

  it("getRunbook resolves by slug", () => {
    expect(getRunbook(RUNBOOKS[0]!.slug)).toBe(RUNBOOKS[0]);
    expect(getRunbook("does-not-exist")).toBeUndefined();
  });

  describe("searchRunbooks", () => {
    it("returns everything for a blank query", () => {
      expect(searchRunbooks("")).toHaveLength(RUNBOOKS.length);
      expect(searchRunbooks("   ")).toHaveLength(RUNBOOKS.length);
    });

    it("matches title/keyword hits and is case-insensitive", () => {
      const hits = searchRunbooks("ROLLBACK");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((r) => r.slug === "rollback")).toBe(true);
    });

    it("ranks strong (title/keyword) matches ahead of body-only matches", () => {
      // "deploy" is in the deploy-order title/keywords but only in the body of
      // other runbooks, so deploy-order should lead.
      const hits = searchRunbooks("deploy");
      expect(hits[0]?.slug).toBe("deploy-order");
    });

    it("returns nothing for a term in no runbook", () => {
      expect(searchRunbooks("zzzznotarealterm")).toHaveLength(0);
    });
  });
});
