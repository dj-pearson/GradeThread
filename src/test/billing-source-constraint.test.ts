// US-2287: the users_billing_source_chk allowed set must match the
// billing_source literals the code actually writes.
//
// THE HISTORY THIS GUARDS AGAINST. 00104_appstore_billing.sql created the
// constraint as CHECK (billing_source IS NULL OR billing_source IN
// ('stripe','appstore')). 00321_google_play_billing.sql later added the Play
// columns and its own header says "billing_source already carries
// 'stripe'/'appstore'; Play sets 'googleplay'" — which reads as though the
// constraint had been widened. It never was. Meanwhile
// lib/google-play/products.ts declares billing_source: 'googleplay' as a
// literal type on the users update, so every Play subscription grant violated
// the check and returned 23514: the customer paid Google and was entitled to
// nothing here, and the Play expiry sweep could never match a row because no
// row could hold the value it filters on.
//
// WHY IT WAS EASY TO MISS, AND THEREFORE WHY THIS TEST EXISTS. Three OTHER
// constraints WERE correctly widened for Play — 00354 (dead-letter provider),
// 00414 (buyer_billing_source) and 00486 (agreed-terms source). A targeted
// grep for 'googleplay' across supabase/migrations returns four confident
// looking hits and none of them is the one that matters. Human review of a
// grep result is exactly the check that failed; a mechanical correspondence is
// the version that cannot.
//
// This is a source scan rather than a runtime assertion on a live database
// because the failure mode is a DIVERGENCE between two files, and both of them
// are readable statically. A fourth processor added in code with no migration
// reddens here at the moment the literal is introduced, which is the moment it
// is cheap to fix — not after a customer has been charged.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/**
 * Directories whose object-literal writes land on public.users.billing_source.
 * The frontend never writes the column (it is a service-role-only field), so
 * scanning the edge service plus the Pages Functions covers every writer.
 */
const WRITE_SCAN_DIRS = [
  join(REPO_ROOT, "services", "edge-functions", "src"),
  join(REPO_ROOT, "src"),
  join(REPO_ROOT, "functions"),
];

const CODE_EXTENSIONS = [".ts", ".tsx"];

/** Test fixtures assert against the constraint; they are not product writers. */
const EXCLUDED_PATH_SEGMENTS = ["tests", "test", "__tests__", "node_modules"];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_PATH_SEGMENTS.includes(entry)) continue;
      out = out.concat(walk(full));
    } else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      if (entry.includes(".test.") || entry.endsWith("_test.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * The LIVE allowed set: the highest-numbered migration that defines
 * users_billing_source_chk wins, because apply order is filename order and a
 * later drop-and-add supersedes an earlier definition.
 *
 * Deliberately parses the CHECK body rather than trusting a constant in this
 * file — a constant here would be a third copy that also has to be maintained,
 * which is the same class of bug the test is for.
 */
function liveAllowedSet(): { version: string; values: string[] } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let found: { version: string; values: string[] } | null = null;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!sql.includes("users_billing_source_chk")) continue;

    // Match the ADD CONSTRAINT ... CHECK (...) body, not the IF NOT EXISTS
    // probe, by requiring the IN (...) list to be present.
    const match = sql.match(
      /ADD\s+CONSTRAINT\s+users_billing_source_chk\s+CHECK\s*\([^)]*IN\s*\(([^)]*)\)/i,
    );
    if (!match) continue;

    const values = [...(match[1] ?? "").matchAll(/'([^']+)'/g)]
      .map((m) => m[1] ?? "")
      .filter(Boolean)
      .sort();
    found = { version: file.slice(0, 5), values };
  }

  if (!found) {
    throw new Error(
      "No migration defines users_billing_source_chk with an IN (...) list. " +
        "If the constraint was renamed or replaced, update this test to match.",
    );
  }
  return found;
}

/**
 * Every literal assigned to billing_source in a WRITE position — an
 * object-literal key, which is what supabase-js .insert()/.update()/.upsert()
 * payloads and their TypeScript row types are built from.
 *
 * buyer_billing_source is a SEPARATE column with its own constraint (00414),
 * so the negative lookbehind on `_` keeps it out; matching it here would make
 * the two columns' allowed sets appear to be one set.
 */
function writtenLiterals(): Map<string, string[]> {
  const byValue = new Map<string, string[]>();
  const pattern = /(?<![A-Za-z0-9_])billing_source"?\s*:\s*"([a-z_]+)"/g;

  for (const dir of WRITE_SCAN_DIRS) {
    for (const file of walk(dir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const value = match[1];
        if (!value) continue;
        const rel = file.slice(REPO_ROOT.length + 1).split("\\").join("/");
        const sites = byValue.get(value) ?? [];
        if (!sites.includes(rel)) sites.push(rel);
        byValue.set(value, sites);
      }
    }
  }
  return byValue;
}

describe("users_billing_source_chk matches the code's billing_source literals", () => {
  it("allows every literal the code writes", () => {
    const { version, values } = liveAllowedSet();
    const written = writtenLiterals();

    const rejected = [...written.entries()]
      .filter(([value]) => !values.includes(value))
      .map(([value, sites]) => `  '${value}' written at: ${sites.join(", ")}`);

    expect(
      rejected,
      `users_billing_source_chk (defined in migration ${version}) allows ` +
        `[${values.join(", ")}] but the code writes values it rejects.\n` +
        `Every write below fails with 23514 — the customer is charged by the ` +
        `processor and receives no entitlement:\n${rejected.join("\n")}\n\n` +
        `Fix: add a migration that drops and re-adds the constraint with the ` +
        `value included. Do NOT widen this test.`,
    ).toEqual([]);
  });

  it("allows nothing the code never writes", () => {
    const { version, values } = liveAllowedSet();
    const written = new Set(writtenLiterals().keys());

    const orphaned = values.filter((value) => !written.has(value));

    expect(
      orphaned,
      `users_billing_source_chk (migration ${version}) permits ` +
        `[${orphaned.join(", ")}], which no code path writes. Either a writer ` +
        `was removed and the constraint should narrow, or the write moved to ` +
        `a file this test does not scan (see WRITE_SCAN_DIRS).`,
    ).toEqual([]);
  });

  it("includes googleplay — the value US-2287 was filed for", () => {
    // Pinned by name as well as by correspondence. The two assertions above
    // both pass if the Play writer is deleted AND the constraint narrows,
    // which would be a silent removal of Android billing rather than a fix.
    const { values } = liveAllowedSet();
    expect(values).toContain("googleplay");
    expect(values).toContain("appstore");
    expect(values).toContain("stripe");
  });
});
