// US-1997: `PublicGradeReportRow` must not describe columns the view does not
// project.
//
// THE STATE THIS ENDS. `factor_scores` and `rubric_key` were declared on this
// interface, read by `certificate.tsx` (which branches on both to render a
// non-clothing factor breakdown), and NEVER PROJECTED by
// `public_grade_reports`. Both `certificate.tsx` and `embed-grade.tsx` fetch
// with `.select("*")` and cast the result to this interface, so the cast was
// the only thing asserting those fields exist — and a cast is an assertion the
// compiler trusts. The branch was unreachable for as long as the view stayed
// silent about the columns, and nothing anywhere failed.
//
// That is the same failure direction `listing-row-schema-parity.test.ts` was
// written for, mirrored: there the TYPE described LESS than the row, here it
// described MORE. Both are invisible without a guard, because in neither case
// does anything throw — you get `undefined` on whichever surface reads it first,
// which reads exactly like "no data yet".
//
// The view side is PARSED from the migration corpus rather than hand-listed. A
// hand-listed expectation is a third copy, and it drifts too.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = resolve(ROOT, "supabase/migrations");

/**
 * The LAST `CREATE OR REPLACE VIEW public.public_grade_reports` in filename
 * order — the view is recreated wholesale by each migration that touches it
 * (00314, 00315, 00316, 00318, 00356, 00530…), so the newest definition wins
 * outright and earlier ones are history.
 */
function latestViewSql(): string {
  let found: string | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), "utf8");
    const at = sql.toLowerCase().lastIndexOf(
      "create or replace view public.public_grade_reports as",
    );
    if (at === -1) continue;
    // Bounded by the statement terminator that ends the SELECT.
    const body = sql.slice(at);
    const end = body.indexOf(";\n");
    found = end === -1 ? body : body.slice(0, end);
  }
  if (!found) throw new Error("no CREATE OR REPLACE VIEW public_grade_reports found");
  return found;
}

/** Split a SELECT list on commas that are not inside parentheses or quotes. */
function topLevelItems(selectList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < selectList.length; i++) {
    const ch = selectList[i];
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") {
      quoted = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Output column names of the view: the `AS <name>` alias when present,
 * otherwise the trailing segment of a `gr.<column>` reference.
 */
function viewColumns(): Set<string> {
  const sql = latestViewSql();
  const from = sql.toLowerCase().lastIndexOf("\nfrom public.grade_reports");
  expect(from, "the view's FROM clause moved — this parser needs updating").toBeGreaterThan(-1);
  const selectAt = sql.toLowerCase().indexOf(" as\n") + " as\n".length;
  const selectList = sql
    .slice(selectAt, from)
    .replace(/^\s*select\b/i, "")
    // Comments would otherwise contribute stray identifiers.
    .replace(/--[^\n]*/g, "");

  const cols = new Set<string>();
  for (const item of topLevelItems(selectList)) {
    const text = item.trim();
    if (!text) continue;
    const alias = /\bas\s+([a-z_][a-z0-9_]*)\s*$/i.exec(text)?.[1];
    if (alias) {
      cols.add(alias.toLowerCase());
      continue;
    }
    const bare = /(?:^|\.)([a-z_][a-z0-9_]*)\s*$/i.exec(text)?.[1];
    if (bare) cols.add(bare.toLowerCase());
  }
  return cols;
}

/** Field names declared on the `PublicGradeReportRow` interface. */
function interfaceFields(): string[] {
  const src = readFileSync(resolve(ROOT, "src/types/database.ts"), "utf8");
  const at = src.indexOf("export interface PublicGradeReportRow {");
  expect(at, "PublicGradeReportRow was renamed or moved").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n}", at));
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    // Only top-level members: exactly two spaces of indent, then `name?:` /
    // `name:`. Nested object literals indent further and are skipped.
    const name = /^ {2}([a-z_][a-z0-9_]*)\??:/.exec(line)?.[1];
    if (name) fields.push(name);
  }
  expect(fields.length, "parsed no fields — the interface's shape changed").toBeGreaterThan(10);
  return fields;
}

describe("public_grade_reports view / PublicGradeReportRow parity", () => {
  it("projects every field the interface declares", () => {
    const cols = viewColumns();
    const missing = interfaceFields().filter((f) => !cols.has(f.toLowerCase()));
    expect(
      missing,
      "PublicGradeReportRow declares fields the view does not project. Both " +
        "certificate.tsx and embed-grade.tsx cast a `select(\"*\")` result to " +
        "this interface, so these read as `undefined` at runtime and any branch " +
        "guarding on them is dead. Add the column to the view (a new migration " +
        "recreating it) or drop the field from the interface.",
    ).toEqual([]);
  });

  it("projects the non-clothing rubric columns US-1997 activated", () => {
    // The two this guard was written for. Named explicitly so a future
    // migration that recreates the view from an older copy — which is how the
    // view is edited, by reproducing the previous SELECT list — cannot silently
    // drop them again.
    const cols = viewColumns();
    expect(cols.has("rubric_key")).toBe(true);
    expect(cols.has("factor_scores")).toBe(true);
  });

  it("sanitizes factor_scores rather than passing the raw jsonb through", () => {
    // factor_scores is free-form jsonb on a PUBLIC, anon-readable view. The
    // rebuild keeps only number-valued entries so a future writer cannot turn
    // the column into a leak channel, and NULLIF keeps an empty result from
    // reaching the client as `{}` — which is truthy, and would send
    // certificate.tsx into the non-clothing branch with every factor at 0.
    const sql = latestViewSql();
    expect(
      /jsonb_typeof\(e\.value\)\s*=\s*'number'/.test(sql),
      "factor_scores is no longer filtered to number-valued entries",
    ).toBe(true);
    expect(
      /NULLIF\(/i.test(sql),
      "an empty factor_scores would now reach the client as {} (truthy)",
    ).toBe(true);
  });
});
