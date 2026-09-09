import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A subject access request is the one document where an empty section is a
// statement of fact. The person is being told, in a file they may hand to a
// regulator, that GradeThread holds no grade reports for them.
//
// Every read in this file except one discarded its error and fell through to
// `[]`, so a failed read produced exactly that claim and looked identical to a
// genuinely empty account. The financial summary is built from the same rows,
// so a dropped table also reported their lifetime revenue as zero. And every
// read was unbounded, which PostgREST clips at `db-max-rows` with no error and
// no flag, so a long-standing seller's archive would simply have been short.
//
// A source scan, because neither failure is visible at runtime: the export
// succeeds, the ZIP downloads, and every file in it is well-formed JSON.

const FILE = "src/lib/account-export.ts";
const src = readFileSync(resolve(process.cwd(), FILE), "utf8");

describe("the account export never reports a failed read as an empty record set", () => {
  it("routes every record set through the paging helper", () => {
    // The helper is the only place that decides what a failed read means, so
    // a read that goes around it is a read that can start lying again.
    expect(src).toContain("async function exportRows");
    expect(src).toContain("fetchAllPages");
  });

  it("the helper throws on a read error instead of returning rows", () => {
    const at = src.indexOf("async function exportRows");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 2000);
    expect(body).toContain("if (error) {");
    expect(body).toMatch(/throw new Error\(/);
  });

  it("no read in the export falls through to an empty array", () => {
    // `x.data ?? []` and `(data ?? []) as Row[]` are the two shapes that were
    // there. Either one turns "we could not read this" into "you have none".
    const offenders = src
      .split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\bdata\s*\?\?\s*\[\]/.test(line))
      // The helper's own `(data ?? []) as T[]` runs only AFTER the error check
      // above it, so an empty page there really is an empty page.
      .filter(({ line }) => !line.includes("as T[]"));
    expect(offenders).toEqual([]);
  });

  it("checks the profile read too, so profile.json cannot be a bare null", () => {
    expect(src).toContain("error: profileErr");
    expect(src).toContain("if (profileErr)");
  });

  it("keeps the one deliberate best-effort field documented as such", () => {
    // fetchShippingProfile is allowed to fail: those two values come from the
    // edge, which holds the decryption key, and a whole export must not fail
    // because one optional field could not be unlocked. That exception is
    // fine BECAUSE it is written down and narrow — this pins it to one call.
    const catches = [...src.matchAll(/catch\s*\(/g)];
    expect(catches.length).toBe(1);
    expect(src).toContain("fetchShippingProfile");
  });

  it("still excludes the secrets it always excluded", () => {
    // Named in the doc comment as a thing excluded; never in a select list.
    const at = src.indexOf('"api_keys"');
    expect(at, "the api_keys read moved — re-point this guard").toBeGreaterThan(-1);
    const apiKeyRead = src.slice(at, at + 300);
    expect(apiKeyRead).toContain("key_prefix");
    expect(apiKeyRead).not.toContain("key_hash");
    // marketplace_connections is column-restricted, never select("*").
    const conn = src.indexOf('"marketplace_connections"');
    expect(conn).toBeGreaterThan(-1);
    expect(src.slice(conn, conn + 300)).toContain("account_handle");
  });
});
