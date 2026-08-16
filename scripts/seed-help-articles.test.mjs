// US-2618: the seeder is the operator's one command, and until 2026-08-16 it
// had never been run. This pins the two things that were wrong or unproven.
//
// 1. `--force` COULD NOT WORK, and would have failed exactly when it was
//    needed. It POSTed with `Prefer: resolution=merge-duplicates`, and this
//    table cannot be upserted through PostgREST at all. Proven against a real
//    Postgres rather than argued:
//
//      * inserting an existing slug raises 23505 unique_violation;
//      * `ON CONFLICT (slug)` — what `?on_conflict=slug` compiles to — raises
//        42P10, "there is no unique or exclusion constraint matching the ON
//        CONFLICT specification".
//
//    Because the uniqueness is an EXPRESSION index, `unique (lower(slug))`.
//    Postgres can only target that with `ON CONFLICT (lower(slug))`, which
//    PostgREST has no syntax for. So `--force` now issues a PATCH keyed on the
//    slug, which is what "overwrite" honestly means here.
//
// 2. The payload has to FIT. All 83 articles were inserted into the live schema
//    inside a rolled-back transaction: every column exists, every category_key
//    resolves against the FK, no slug collides. That is a one-off proof; these
//    cases keep the shape that made it true.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RAW = readFileSync(join(process.cwd(), "scripts/seed-help-articles.mjs"), "utf8");

/**
 * The executable source. Comments are stripped because the fix's own comment
 * explains the bug BY NAMING IT — `resolution=merge-duplicates` — so a check
 * against the raw text failed on the corrected file. Third time this shape has
 * come up in this repo; it is not a coincidence, it is what happens when a
 * guard and an explanation live in the same file.
 */
const SRC = RAW.split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/00602_help_center_articles.sql"),
  "utf8",
);

describe("US-2618: --force overwrites by UPDATE, because upsert is impossible here", () => {
  it("does not ask PostgREST to merge duplicates", () => {
    expect(
      SRC.includes("resolution=merge-duplicates"),
      "resolution=merge-duplicates cannot resolve on this table — the unique " +
        "index is on lower(slug), an expression PostgREST cannot name as a " +
        "conflict target. It fails 23505 on every already-live article.",
    ).toBe(false);
  });

  it("PATCHes an existing slug instead", () => {
    expect(SRC).toMatch(/method:\s*"PATCH"/);
    expect(SRC).toMatch(/help_articles\?slug=eq\.\$\{encodeURIComponent\(a\.slug\)\}/);
  });

  it("matches the slug exactly, never with ilike", () => {
    // `_` and `%` are SQL wildcards and both are legal in a slug. The erasure
    // runbook records the same trap on email addresses.
    expect(SRC).not.toMatch(/slug=ilike/);
  });

  it("the premise still holds: uniqueness is an expression index", () => {
    // If a later migration adds a plain `unique (slug)` constraint, upsert
    // becomes available and the PATCH branch can be reconsidered — so this
    // records WHY rather than freezing the choice.
    expect(MIGRATION).toMatch(/unique index[\s\S]{0,80}help_articles \(lower\(slug\)\)/i);
    expect(MIGRATION).not.toMatch(/slug\s+text\s+not null\s+unique/i);
  });
});

describe("US-2618: the payload fits the table", () => {
  it("every article parses and carries the columns the schema requires", async () => {
    const { parseArticle } = await import("./seed-help-articles.mjs");
    const dir = join(process.cwd(), "content/help");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(83);

    // The NOT NULL columns on help_articles, read from the migration rather
    // than listed here — a hand-copied list is the thing that goes stale.
    const block = MIGRATION.slice(
      MIGRATION.indexOf("create table if not exists public.help_articles"),
    );
    const required = [...block.slice(0, block.indexOf(");")).matchAll(/^\s{2}([a-z_]+)\s+[^\n]*not null/gm)]
      .map((m) => m[1] ?? "")
      .filter((c) => !["id"].includes(c));
    expect(required.length).toBeGreaterThan(3);

    for (const f of files) {
      const row = parseArticle(readFileSync(join(dir, f), "utf8"), f);
      for (const col of required) {
        // A column with a DEFAULT may legitimately be absent from the payload.
        const hasDefault = new RegExp(`^\\s{2}${col}\\s+[^\\n]*default`, "m").test(block);
        if (hasDefault) continue;
        expect(row[col], `${f} has no ${col}, which is NOT NULL with no default`).toBeDefined();
      }
      expect(row.slug, `${f}: slug must be lowercase — the unique index is on lower(slug)`)
        .toBe(String(row.slug).toLowerCase());
    }
  });

  it("no two articles collide on the slug index", () => {
    const dir = join(process.cwd(), "content/help");
    const slugs = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => (readFileSync(join(dir, f), "utf8").match(/^slug:\s*(.+)$/m)?.[1] ?? f).trim().toLowerCase());
    expect(new Set(slugs).size, "two articles share a slug (case-insensitively)").toBe(slugs.length);
  });
});
