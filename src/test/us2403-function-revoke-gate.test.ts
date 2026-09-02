// US-2403: a new migration must not REVOKE EXECUTE on a public function from
// anon, authenticated or PUBLIC until the crash is mitigated.
//
// THE THING THIS EXISTS TO STOP, and it has already happened five times.
// On this Postgres image, supautils appends a "GRANT …" hint to a
// permission-denied error when the calling role is in `supautils.hint_roles`
// (here: `anon, authenticated, service_role`). Building that hint SEGFAULTS the
// backend for a FUNCTION denial — verified again 2026-08-16 by
// `scripts/db-denied-rpc-crash-check.mjs`, which still reports the connection
// dropped and a recovery line in the server log. Every other session dies with
// it. `anon` is the role behind the anon key that ships in the browser bundle,
// so each revoked function is one HTTP call away from restarting the database.
//
// US-2282's bulk revoke (00527) is parked as `.BLOCKED` for exactly this, and
// that file cannot apply because `apply-prod-migrations.sh` globs `*.sql`. But
// nothing stopped the same thing arriving ONE FUNCTION AT A TIME, and it did:
// 00560, 00594, 00595, 00596 and 00606 all shipped REVOKEs AFTER this was
// raised on 2026-08-04. Measured on the local stack with all 609 migrations
// applied, the count of public functions `anon` may not execute went from the
// 14 recorded on 2026-08-08 to **20**. The parked migration held; the drip did
// not, because there was nothing to hold it.
//
// So the gate is the corpus, not the one file. The allowlist below is every
// migration that already does this, and it may only SHRINK — an entry that
// stops matching fails too, so nobody can quietly widen it by editing a file it
// names.
//
// ✅ HOW TO UN-BLOCK ALL OF THIS. Clear `supautils.hint_roles` in
// /etc/postgresql-custom/supautils.conf on the host and restart Postgres. The
// hint only decorates an error message. It CANNOT be done from SQL — supautils
// rejects `ALTER SYSTEM SET` on that parameter even as superuser — so it is an
// operator action on Coolify, and no migration here can substitute for it.
// Once done: re-run the crash check, delete this gate, rename 00527 back to
// `.sql`, and close US-2282.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/**
 * Migrations that already revoke function EXECUTE from a hinted role, each with
 * why it is tolerated. SHRINK-ONLY: every version here must still match, so
 * removing the revoke from one of these files is a change this test notices.
 *
 * "Pre-dates the finding" is not an endorsement — these are the live crash
 * entry points, enumerated in US-2403 AC5. They are tolerated because reverting
 * a revoke would trade a crash bug for a permissions bug, which is worse.
 *
 * Five of these (00216, 00317, 00490, 00501, 00503) were missed by the ripgrep
 * sweep that seeded this list and found only by the scanner below, because
 * their REVOKE spans several lines around a long argument list. Worth knowing
 * before trusting any line-oriented grep about this corpus.
 */
const ALLOWED: Record<string, string> = {
  "00711": "bump_ebay_api_calls — the same mistake as 00685, shipped on 2026-09-01. Superseded by 00720, which restores the default EXECUTE and moves the service-role check into the function body. Listed because the text stays in an applied migration, NOT because the pattern is acceptable (2026-09-02)",
  "00685": "rebuild_ledger_for_user — a REVOKE that should never have shipped, and it was APPLIED to prod before anyone noticed. Superseded by 00686, which restores the default EXECUTE and moves the authorization into the function body. Listed here because the text stays in an applied migration, NOT because the pattern is acceptable (2026-08-29)",
  "00043": "delete_account — pre-dates the finding (2026-08-04)",
  "00048": "refund_grade — pre-dates the finding",
  "00093": "refund_grade + credit_ledger_reconciliation — pre-dates the finding",
  "00094": "try_acquire_job_lock + release_job_lock — pre-dates the finding",
  "00097": "data_integrity_scan — pre-dates the finding",
  "00099": "reserve_snap + refund_snap — pre-dates the finding",
  "00117": "reconcile_payout_link — pre-dates the finding",
  "00119": "merge_inventory_items — pre-dates the finding",
  "00121": "increment_certificate_view — pre-dates the finding",
  "00126": "latest_schema_migration — pre-dates the finding",
  "00162": "bump_cache_signal + get_cache_signal — pre-dates the finding",
  "00170": "north_star_*_counts — pre-dates the finding",
  "00216": "admin_adjust_credits — pre-dates the finding",
  "00254": "latest_schema_migration, re-revoked — pre-dates the finding",
  "00294": "record_campaign_email_open/click — pre-dates the finding",
  "00304": "reconcile_payout_link, re-revoked — pre-dates the finding",
  "00317": "create_listing_template — pre-dates the finding",
  "00485": "equity_snapshot_owners — pre-dates the finding",
  "00490": "reserve_guarantee_pool_drawdown — pre-dates the finding",
  "00492": "channel_attribution — pre-dates the finding",
  "00501": "record_registered_number_sighting — pre-dates the finding",
  "00503": "record_style_code_observation — pre-dates the finding",
  "00512": "release_job_lock, new signature — pre-dates the finding",
  "00527": "THE PARKED BULK REVOKE. Held as .BLOCKED, which is why it is here.",
  "00536": "refund_grade, re-revoked — pre-dates the finding",
  "00537": "buyer_growth_metrics — pre-dates the finding",
  // ── The five that shipped AFTER the finding. Each added a live crash entry
  // point and none was wrong to want the permission; they are recorded here so
  // the drip is visible rather than implied.
  "00560": "flipdesk_listing_performance_{summary,page} — SHIPPED AFTER 2026-08-04",
  "00594": "flipdesk_overview_metrics — SHIPPED AFTER 2026-08-04",
  "00595": "redact_subscription_event_pii — SHIPPED AFTER 2026-08-04",
  "00596": "prune_api_idempotency_records — SHIPPED AFTER 2026-08-04",
  "00606": "record_help_article_view + help_zero_result_queries — SHIPPED AFTER 2026-08-04",
};

/**
 * `REVOKE … ON FUNCTION … FROM …` naming a hinted role.
 *
 * Comments are stripped first. 00609 explains at length why it does NOT revoke,
 * and matching that paragraph would report a migration that is the one doing
 * the right thing — the same self-referential trap that has bitten three
 * guards in this repo already.
 */
function revokingMigrations(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!/^\d{5}_.*\.sql(\.BLOCKED)?$/.test(file)) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const hits = [
      ...sql.matchAll(
        /REVOKE\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\b[^;]*?\bFROM\b[^;]*?\b(?:PUBLIC|anon|authenticated)\b/gis,
      ),
    ].map((m) => m[0].replace(/\s+/g, " ").trim().slice(0, 90));
    if (hits.length) out.set(file.slice(0, 5), hits);
  }
  return out;
}

describe("US-2403: no NEW migration arms the denied-function crash", () => {
  it("every revoking migration is named, with a reason", () => {
    const found = revokingMigrations();
    const unlisted = [...found.entries()]
      .filter(([version]) => !ALLOWED[version])
      .map(([version, hits]) => `  ${version}: ${hits[0]}`);

    expect(
      unlisted,
      "This migration revokes function EXECUTE from a role in " +
        "supautils.hint_roles, which on this Postgres image SEGFAULTS the " +
        "backend when the denied call happens — restarting the database and " +
        "killing every other session. `anon` is the key that ships in the " +
        "browser bundle.\n\n" +
        "Do NOT add it to the allowlist to make this pass. The permission you " +
        "want is right; the image cannot express it safely yet. Either drop " +
        "the REVOKE (00609 shows the shape, with the reasoning in the file), " +
        "or mitigate first: clear supautils.hint_roles on the host, prove it " +
        "with scripts/db-denied-rpc-crash-check.mjs, and then this whole gate " +
        "goes away along with US-2282.\n\n" +
        `Unlisted:\n${unlisted.join("\n")}`,
    ).toEqual([]);
  });

  it("the allowlist can only shrink", () => {
    // An entry that no longer matches is either a fixed migration (delete the
    // line) or a revoke that moved somewhere this scan cannot see. Both need a
    // human; neither should pass quietly.
    const found = revokingMigrations();
    const stale = Object.keys(ALLOWED).filter((v) => !found.has(v));
    expect(
      stale,
      `These versions no longer revoke function EXECUTE, so their allowlist ` +
        `entries are dead: ${stale.join(", ")}. Delete them.`,
    ).toEqual([]);
  });

  it("00527 is still parked, and parked in the way that actually holds", () => {
    // The suffix is the mechanism, not documentation: apply-prod-migrations.sh
    // globs *.sql, so `.BLOCKED` is what keeps it out of a directory run.
    // Renaming it back is a deliberate step of the mitigation, not a tidy-up.
    const files = readdirSync(MIGRATIONS);
    expect(files).toContain("00527_revoke_public_function_execute.sql.BLOCKED");
    expect(files).not.toContain("00527_revoke_public_function_execute.sql");
  });
});
