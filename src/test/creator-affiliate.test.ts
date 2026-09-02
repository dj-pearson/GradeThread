import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_AFFILIATE } from "@/lib/constants";

// US-9212: the creator commission numbers live in three places by design — the
// decision record's table in pricing.md, the web constant, and the edge's
// default config. This is the pricing.md mirror pattern: parse all three and
// fail when any of them drifts.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const EDGE = read("services/edge-functions/src/lib/affiliate-payout-math.ts");
const NOTE = read("vault/50-business/pricing.md");

function edgeDefault(key: string): number | string | undefined {
  const block = /DEFAULT_AFFILIATE_PAYOUT_CONFIG[^{]*\{([\s\S]*?)\n\};/.exec(EDGE)?.[1] ?? "";
  const m = new RegExp(`${key}:\\s*("?[\\w.]+"?)`).exec(block);
  if (!m) return undefined;
  return m[1]!.startsWith('"') ? m[1]!.replace(/"/g, "") : Number(m[1]);
}

describe("creator affiliate commission (US-9212)", () => {
  it("the rate sits inside the band, and the band is the one that was decided", () => {
    expect(CREATOR_AFFILIATE.commissionMinPct).toBe(20);
    expect(CREATOR_AFFILIATE.commissionMaxPct).toBe(30);
    expect(CREATOR_AFFILIATE.commissionPct).toBeGreaterThanOrEqual(20);
    expect(CREATOR_AFFILIATE.commissionPct).toBeLessThanOrEqual(30);
  });

  it("the edge default config matches the web constant", () => {
    expect(edgeDefault("commission_pct")).toBe(CREATOR_AFFILIATE.commissionPct);
    expect(edgeDefault("commission_cap_usd")).toBe(CREATOR_AFFILIATE.capUsd);
    expect(edgeDefault("commission_window_months")).toBe(CREATOR_AFFILIATE.windowMonths);
    expect(edgeDefault("commission_model")).toBe("subscription_pct");
    expect(edgeDefault("mode"), "the programme ships dark").toBe("off");
  });

  it("pricing.md states the same numbers", () => {
    const section = NOTE.split("## Creator affiliate commission")[1] ?? "";
    expect(section.length, "the section must exist").toBeGreaterThan(200);
    expect(section).toContain(`**${CREATOR_AFFILIATE.commissionPct}%**`);
    expect(section).toContain(`**$${CREATOR_AFFILIATE.capUsd}**`);
    expect(section).toContain(`**${CREATOR_AFFILIATE.windowMonths} months**`);
    expect(section).toContain(`**${CREATOR_AFFILIATE.holdDays} days**`);
    expect(section, "user referral stays credits-only").toMatch(/credits-only/);
  });

  it("no cash may move without a certified tax profile", () => {
    // The gate is in the pure planner and defaults to refusal, so a caller that
    // forgets it queues rather than pays.
    expect(EDGE).toMatch(/tax_profile_missing/);
    expect(EDGE).toMatch(/args\.taxProfileComplete !== true/);
    const engine = read("services/edge-functions/src/lib/affiliate-payout.ts");
    expect(engine).toMatch(/hasCertifiedTaxProfile/);
    // Fails closed: a read error answers false.
    expect(engine).toMatch(/if \(error\) return false;/);
  });

  // ── The separation itself (AC2) ──────────────────────────────────────────

  it("the creator terms note, the web constant and the edge route agree on a version", () => {
    const terms = read("vault/50-business/creator-affiliate-terms.md");
    expect(terms).toContain(`**Version:** \`${CREATOR_AFFILIATE.termsVersion}\``);
    const route = read("services/edge-functions/src/routes/affiliate.ts");
    expect(route).toContain(`const CREATOR_TERMS_VERSION = "${CREATOR_AFFILIATE.termsVersion}"`);
    // The terms have to say the three things that make them the CREATOR's, not
    // the seller referral everybody has.
    expect(terms, "cash vs credits must be stated").toMatch(/grade credits/i);
    expect(terms, "the tax gate must be stated").toMatch(/tax profile/i);
    expect(terms, "admission is not automatic").toMatch(/application/i);
  });

  it("cash is creator-only: the pure planners refuse anything else by default", () => {
    // planAccrual and planSubscriptionAccrual both name the refusal, and both
    // reach it when the caller says nothing — the same fail-closed shape as the
    // tax gate. A user who shared a referral link can never accrue cash.
    expect(EDGE).toMatch(/"not_creator"/);
    expect(EDGE).toMatch(/args\.program !== "creator"/);
    expect(EDGE).toMatch(/args\.program !== "creator"|program !== "creator"/);
  });

  it("the database refuses a creator with no recorded consent", () => {
    const migration = read("supabase/migrations/00719_creator_affiliate_programme.sql");
    expect(migration).toMatch(/affiliate_accounts_creator_needs_consent/);
    expect(migration).toMatch(/program <> 'creator'/);
    expect(migration).toMatch(/DEFAULT 'user'/);
    // One commission row per PAID INVOICE for the percentage model, one per
    // conversion for the flat bounty. Both idempotency rules must survive.
    expect(migration).toMatch(/uniq_affiliate_commission_invoice/);
    expect(migration).toMatch(/uniq_affiliate_commission_event/);
    // The boot guard has to be at or past this migration; a later one bumps it
    // further, which is fine -- what must not happen is the code shipping ahead
    // of a schema that has no program column.
    const expected = /EXPECTED_SCHEMA_VERSION = "(\d{5})"/.exec(
      read("services/edge-functions/src/lib/schema-version.ts"),
    )?.[1];
    expect(Number(expected)).toBeGreaterThanOrEqual(719);
  });

  it("/partners is registered everywhere a public route has to be", () => {
    const routes = read("src/lib/seo/public-routes.ts");
    expect(routes).toMatch(/path: "\/partners"/);
    // The prerender needs both halves: the element to render and the module to
    // load. A route in one and not the other fails the CI sync guard.
    const prerender = read("src/prerender/entry-server.tsx");
    expect(prerender).toContain('"/partners": <PartnersPage />');
    expect(prerender).toContain('"/partners": `${M}marketing/partners`');
    expect(read("src/routes/index.tsx")).toMatch(/path: "\/partners"/);
  });

  it("the partners page cannot advertise a rate the ledger does not pay", () => {
    const page = read("src/pages/marketing/partners.tsx");
    // Every number comes from the constant, so there is no literal to drift.
    expect(page).toContain("CREATOR_AFFILIATE.commissionPct");
    expect(page).toContain("CREATOR_AFFILIATE.capUsd");
    expect(page).toContain("CREATOR_AFFILIATE.windowMonths");
    expect(page).toContain("CREATOR_AFFILIATE.holdDays");
    expect(page).toContain("CREATOR_AFFILIATE.termsVersion");
    // It must not promise cash is flowing, and must say credits are the other
    // programme -- the ADR's line, on the page that recruits creators.
    expect(page).toMatch(/grade credits/i);
    expect(page).toMatch(/apply/i);
  });

  it("the tax table is deny-all and registered as service-role only", () => {
    const migration = read("supabase/migrations/00718_affiliate_tax_profiles.sql");
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).not.toMatch(/CREATE POLICY/);
    expect(migration).toMatch(/owner_user_id/);
    expect(read("services/edge-functions/src/tests/rls-guard_test.ts")).toContain(
      '"affiliate_tax_profiles"',
    );
  });
});
