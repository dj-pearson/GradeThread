// The restore drill is the one procedure whose failure mode is silent until the
// day it matters, and nothing in this repo checked it. These are source-scanned
// properties, not a run: running it boots a scratch Postgres and takes ~20s, and
// a unit suite must not depend on Docker.
//
// Executed 2026-08-16 for real against the local stack, which is what turned up
// the first case below.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DRILL = readFileSync(
  resolve(import.meta.dirname, "..", "scripts/ops/restore-drill.sh"),
  "utf8",
);

describe("the restore drill runs without being told how", () => {
  it("falls back to rage when age is absent", () => {
    // `age` is not packaged for Windows and `rage` is, so on the dev box the
    // hard default meant the drill stopped with an error — AFTER completing the
    // pg_dump — and the fix was a sentence in its own header. A drill is the
    // thing people run rarely and under stress; a documented workaround is not
    // a working default.
    expect(DRILL).toMatch(/command -v age >\/dev\/null 2>&1; then AGE_BIN=age/);
    expect(DRILL).toMatch(/elif command -v rage/);
    expect(DRILL).toMatch(/using rage \(format-compatible\)/);
  });

  it("an explicit AGE_BIN still wins", () => {
    // The fallback must not take over a host that has both and has pinned one.
    expect(DRILL).toMatch(/if \[ -z "\$\{AGE_BIN:-\}" \]; then/);
  });

  it("checks the keygen binary too, and before the dump work is wasted", () => {
    // Without this it fails later, at the keygen line, with a bare
    // "command not found" naming neither the step nor the fix.
    expect(DRILL).toMatch(/command -v "\$AGE_KEYGEN_BIN"/);
    const keygenCheck = DRILL.indexOf('command -v "$AGE_KEYGEN_BIN"');
    const keygenUse = DRILL.indexOf('"$AGE_KEYGEN_BIN" -o');
    expect(keygenCheck).toBeGreaterThan(-1);
    expect(keygenCheck).toBeLessThan(keygenUse);
  });

  it("encryption is still on by default and only skippable on purpose", () => {
    // "An encryption change that breaks restore is worse than no encryption" is
    // the whole risk. A drill that quietly skipped it would measure a procedure
    // production does not use.
    expect(DRILL).toMatch(/DRILL_SKIP_ENCRYPTION/);
    expect(DRILL).toMatch(/prod ships ENCRYPTED backups/);
    // …and the skip is opt-IN: the encrypted path is the else-less default.
    expect(DRILL).not.toMatch(/DRILL_SKIP_ENCRYPTION:-1/);
  });

  it("still proves the ciphertext is not a passthrough copy", () => {
    // The failure this catches is an encryption step that silently writes the
    // plaintext through — every later check would pass.
    expect(DRILL).toMatch(/age-encryption\.org\/v1/);
  });

  it("compares the restored copy against the source rather than asserting success", () => {
    // pg_restore reports "errors ignored" as a matter of course, so its exit
    // status is not evidence. The row/policy/migration comparison is.
    expect(DRILL).toMatch(/pg_policies/);
    expect(DRILL).toMatch(/supabase_migrations\.schema_migrations/);
  });
});
