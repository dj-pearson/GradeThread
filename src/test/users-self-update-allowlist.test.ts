// US-2283: the users self-update guard is now DENY-BY-DEFAULT (migration 00526).
//
// 00076/00331/00402 froze a hand-listed set of columns on public.users. The
// table has ~100, so every column added since had to be remembered into that
// list or it silently became writable by the account owner through PostgREST.
// Six were missed — included_grades_this_period, ai_actions_used_this_month,
// ai_actions_reset_at, past_due_since, billing_source, google_purchase_token —
// and the first two are free grading billed to us.
//
// Inverting the list closes every future column too, but it moves the risk: a
// client write to a column NOT on the allowlist now fails at runtime, on a real
// user, in production. This test is the other half of that trade. It reads the
// allowlist out of the migration itself (not a copy) and fails if any browser or
// iOS write path targets a column the database will refuse. "The migration" is
// resolved dynamically — see `guardMigration` — because extending the allowlist
// means restating the function in a NEW file, never editing the applied one.
//
// WHY IT SCANS ios/ TOO: the iOS app holds the same anon key and the same
// authenticated role. A Swift write to users is indistinguishable from a browser
// one at the database, and nothing else in the web test suite looks at Swift.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * The migration that currently DEFINES the guard.
 *
 * This used to be pinned to 00526. That was wrong in a way nothing could show
 * until someone legitimately extended the allowlist: applied migrations are
 * immutable, so a new self-service column arrives as a `CREATE OR REPLACE` in a
 * LATER file (US-1861/00550 was the first), and a guard reading only 00526 would
 * keep asserting against a body the database has already replaced — reporting a
 * refusal that will not happen, and missing one that will.
 *
 * Highest-numbered file wins, which is the order the migrations actually apply
 * in.
 */
function guardMigration(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").includes(
        "self_service constant text[] := ARRAY[",
      ),
    );
  expect(
    files.length,
    "no migration declares the self_service allowlist — the guard moved",
  ).toBeGreaterThan(0);
  return join(MIGRATIONS_DIR, files[files.length - 1]!);
}

const MIGRATION = guardMigration();

/** The allowlist as the database will actually see it. */
function selfServiceColumns(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("self_service constant text[] := ARRAY[");
  expect(start, "the allowlist declaration moved — update this guard").toBeGreaterThan(-1);
  const body = sql.slice(start, sql.indexOf("];", start));
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** Every column public.users has ever been given, minus the dropped ones. */
function usersColumns(): Set<string> {
  const dir = "supabase/migrations";
  const cols = new Set<string>();
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const create = /create table (?:if not exists )?public\.users\s*\(([\s\S]*?)\n\);/i.exec(sql);
    if (create) {
      for (const line of create[1]!.split(/\r?\n/)) {
        const m = /^\s{2}([a-z_]+)\s+[a-z]/.exec(line);
        if (m && !/^(primary|constraint|unique|check|foreign)$/.test(m[1]!)) cols.add(m[1]!);
      }
    }
    for (const alter of sql.matchAll(/alter table (?:only )?public\.users([\s\S]*?);/gi)) {
      for (const add of alter[1]!.matchAll(/add column (?:if not exists )?([a-z_]+)/gi)) {
        cols.add(add[1]!.toLowerCase());
      }
      for (const drop of alter[1]!.matchAll(/drop column (?:if exists )?([a-z_]+)/gi)) {
        cols.delete(drop[1]!.toLowerCase());
      }
    }
  }
  return cols;
}

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Column names written on a users row from a client. Anchored on the `.from`
 * call so an unrelated object literal elsewhere in the file can't register: the
 * payload is built within a few lines of the call in every current site, and a
 * site that moves it further away is one this guard should be re-read for.
 */
function clientWrittenColumns(files: string[], columns: Set<string>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/\.from\(\s*"users"\s*\)/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 25), i + 12).join("\n");
      if (!/\.update\(/.test(window)) return;
      // Object keys and Swift struct fields both read as `name:`.
      for (const key of window.matchAll(/(?:^|[{,\s])([a-z_]{3,})\s*:/gm)) {
        const col = key[1]!;
        if (!columns.has(col)) continue;
        const path = file.replace(/\\/g, "/");
        if (!found.has(col)) found.set(col, new Set());
        found.get(col)!.add(path);
      }
    });
  }
  return found;
}

describe("users self-update allowlist (US-2283)", () => {
  const allowlist = selfServiceColumns();
  const columns = usersColumns();

  it("names only real columns", () => {
    const phantom = allowlist.filter((c) => !columns.has(c));
    expect(phantom, "allowlist entries that are not columns of public.users").toEqual([]);
  });

  it("never allows an entitlement, usage or billing column", () => {
    // The six the hand-list missed, plus the ones it did protect. If any of
    // these ever appears in the allowlist, the guard is back to granting free
    // grading — which is the whole reason the story is a P0.
    const mustBeFrozen = [
      "included_grades_this_period",
      "ai_actions_used_this_month",
      "ai_actions_reset_at",
      "past_due_since",
      "billing_source",
      "google_purchase_token",
      "grade_credit_balance",
      "grades_used_this_month",
      "grade_reset_at",
      "snaps_used_this_month",
      "snaps_reset_at",
      "role",
      "suspended",
      "plan",
      "flipdesk_plan",
      "buyer_plan",
      "trial_ends_at",
      "stripe_customer_id",
      "subscription_status",
      "is_seller",
      "is_buyer",
      "verified_enabled",
      "email",
      "id",
    ];
    const leaked = mustBeFrozen.filter((c) => allowlist.includes(c));
    expect(leaked, "these must never be self-service").toEqual([]);
  });

  it("the guard is deny-by-default, not another hand-list", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // The property: the comparison subtracts the allowlist from BOTH rows, so a
    // column nobody thought about is refused rather than permitted.
    expect(sql).toMatch(/to_jsonb\(OLD\)\s*-\s*self_service/);
    expect(sql).toMatch(/to_jsonb\(NEW\)\s*-\s*self_service/);
    // Service-role and SECURITY DEFINER writers still bypass — entitlement
    // changes belong there, and removing this locks the edge out of its own table.
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'authenticated'/);
  });

  it("no browser or iOS write path targets a column the database will refuse", () => {
    const files = [...walk("src", /\.tsx?$/), ...walk("ios", /\.swift$/)];
    const written = clientWrittenColumns(files, columns);
    const refused = [...written.entries()]
      .filter(([col]) => !allowlist.includes(col))
      .map(([col, where]) => `${col} (${[...where].join(", ")})`)
      .sort();
    expect(
      refused,
      "These columns are written on public.users from a client that runs as the " +
        "authenticated role, and the guard refuses them. Either the write " +
        "belongs on the edge (service-role), or the column belongs in the " +
        "latest migration's " +
        "self_service list — decide which, but a client write to a frozen column " +
        "fails on a real user in production, not here.",
    ).toEqual([]);
  });
});
