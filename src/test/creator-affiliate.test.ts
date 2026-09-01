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
