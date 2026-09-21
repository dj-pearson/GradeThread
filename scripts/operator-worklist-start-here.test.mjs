// The operator worklist's "Start here" must agree with PENDING_MIGRATIONS.md.
//
// WHY THIS IS A DRIFT GUARD AND NOT A PARSER TEST. docs/operator-worklist.md is
// generated and checked in, and the thing that goes wrong with a generated file
// is not the generator: it is that a migration lands, nobody re-runs the script,
// and the owner reads a "Start here" naming a migration they applied last week.
// A hand-kept opening move is out of date the first time one lands, which is why
// the section is computed at all -- and computing it is worth nothing if the
// committed copy is stale.
//
// It parses PENDING_MIGRATIONS.md INDEPENDENTLY rather than importing the
// generator's function, so a regex that stops matching cannot agree with itself.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const pending = readFileSync(resolve(ROOT, "PENDING_MIGRATIONS.md"), "utf8");
const worklist = readFileSync(resolve(ROOT, "docs/operator-worklist.md"), "utf8");

/** Held migration files, by their own heading, oldest first. */
const held = [...pending.matchAll(/^##[^\n]*?HELD:\s*(\d{5})_(\S+?)\.sql/gim)]
  .map((m) => `${m[1]}_${m[2]}.sql`)
  .sort();

/** Just the Start here section, so a match elsewhere in 1,000 lines cannot count. */
function startHereBlock() {
  const from = worklist.indexOf("## Start here");
  expect(from, "the worklist has no Start here section").toBeGreaterThanOrEqual(0);
  const to = worklist.indexOf("\n## ", from + 1);
  const block = to === -1 ? worklist.slice(from) : worklist.slice(from, to);
  // Fail closed: an empty slice would make every assertion below vacuous.
  expect(block.length).toBeGreaterThan(80);
  return block;
}

describe("operator worklist: Start here", () => {
  it("names every held migration, and no migration that is not held", () => {
    const block = startHereBlock();
    if (held.length === 0) {
      // ⚠ 2026-09-20: this used to demand the literal "No migration is held",
      // and that is only ONE of the two no-held shapes the generator writes.
      // startHere() prints that sentence when nothing is held AND nothing is
      // waiting on an edge deploy; with a deploy still pending it writes the
      // computed path with the migration step omitted. The day the owner
      // applied all ten, this case failed on a worklist that was correct.
      // What must hold in either shape is that the block names no migration,
      // which is the assertion below and is checked here too.
      expect(
        [...block.matchAll(/(\d{5}_\S+?\.sql)/g)].map((m) => m[1]),
        "nothing is held, so the worklist must not send the owner to apply anything",
      ).toEqual([]);
      return;
    }
    for (const file of held) {
      expect(
        block,
        `${file} is HELD in PENDING_MIGRATIONS.md but the committed worklist ` +
          "does not name it. Run: node scripts/operator-worklist.mjs",
      ).toContain(file);
    }
    // The other direction: a migration the worklist still names but which has
    // since been applied is worse than a missing one, because it sends the
    // owner to run something twice.
    const named = [...block.matchAll(/(\d{5}_\S+?\.sql)/g)].map((m) => m[1]);
    expect(
      [...new Set(named)].filter((f) => !held.includes(f)).sort(),
      "the worklist names a migration PENDING_MIGRATIONS.md no longer holds. " +
        "Run: node scripts/operator-worklist.mjs",
    ).toEqual([]);
  });

  it("puts the edge deploy after the migrations, never before", () => {
    // The boot guard expects the schema version the migrations set, so a
    // worklist that told the owner to deploy first would brick the edge for
    // the length of the grace window.
    const block = startHereBlock();
    if (held.length === 0) return;
    const applyAt = block.indexOf("Apply the");
    const deployAt = block.indexOf("Redeploy the edge");
    expect(applyAt).toBeGreaterThanOrEqual(0);
    expect(deployAt).toBeGreaterThan(applyAt);
  });

  it("finds held migrations at all, so a silent regex change cannot read as clean", () => {
    // Guards the guard. If the heading shape changes, `held` goes empty, and
    // every case above passes on the "No migration is held" branch while the
    // real answer is four. This case says which state we are in out loud.
    if (held.length === 0) {
      expect(pending).not.toMatch(/^##[^\n]*HELD:/im);
    } else {
      expect(held.length).toBeGreaterThan(0);
    }
  });
});
