// prd-lint's stale-HELD check must resolve by SEGMENT ORDER.
//
// THE BLIND SPOT THIS PINS. The check tested the whole notes string for a
// correction, so the FIRST correction a story ever recorded suppressed the
// warning permanently — including for a HELD claim written in a later segment.
// Found 2026-08-09 on US-2289, whose 2026-08-02 segment carries a correction
// and whose 2026-08-03 segment then says "migration 00516 (HELD)" about a
// migration that is on origin/main and applied.
//
// Fixing it surfaced THREE hidden cases at once (US-1880, US-1996, US-2289),
// which is the measure of how much the blind spot was costing: the guard had
// been silent about exactly the thing it exists to catch.
//
// Notes are append-only, so position carries meaning. `findUnresolvedDeferrals`
// in the same file already resolved by segment order for this reason; the HELD
// check now matches it.
//
// Why this matters more than a tidy warning: "HELD" is not a status, it is an
// instruction to stop. A stale one tells the next reader the branch is frozen
// when it is not, and that cost real sessions before it was caught.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import { findStaleHeldMigrations } from "../../scripts/prd-lint.mjs";

/** What the check returns per hit; only `id` is asserted here. */
type Hit = { id: string };

/** Migration ids the fake origin/main is holding. */
const PUSHED = new Set(["00100", "00200"]);

function story(id: string, notes: string) {
  return { id, passes: false, notes };
}

describe("prd-lint: a stale HELD claim is caught", () => {
  it("warns when every migration the note names is already pushed", () => {
    const hits = findStaleHeldMigrations(
      [story("US-1", "did the thing, migration 00100 (HELD)")],
      PUSHED,
    );
    expect(hits.map((h: Hit) => h.id)).toEqual(["US-1"]);
  });

  it("stays silent when the note names a migration that is genuinely unpushed", () => {
    // The deliberate false-negative in the original design, and it is right: a
    // note citing 00100 as context while holding 00999 is a CORRECT hold, and a
    // false positive here is worse than silence — it would teach a reader to
    // ignore the one check that stops them trusting a stale freeze.
    const hits = findStaleHeldMigrations(
      [story("US-2", "builds on 00100; migration 00999 (HELD)")],
      PUSHED,
    );
    expect(hits).toEqual([]);
  });

  it("a correction AFTER the claim clears it", () => {
    const hits = findStaleHeldMigrations(
      [story("US-3", "migration 00100 (HELD) | STATUS CORRECTION: 00100 is pushed")],
      PUSHED,
    );
    expect(hits).toEqual([]);
  });

  it("a correction in the SAME segment as the claim clears it", () => {
    // One segment can raise and settle in the same breath, exactly as the
    // deferral check allows.
    const hits = findStaleHeldMigrations(
      [story("US-4", "said 00100 was HELD — STATUS CORRECTION: it is pushed")],
      PUSHED,
    );
    expect(hits).toEqual([]);
  });

  it("a correction BEFORE a later claim does NOT clear it", () => {
    // THE REGRESSION. This is the exact shape of US-2289: an early correction,
    // then a later segment that says HELD again. Before the fix this returned
    // nothing.
    const hits = findStaleHeldMigrations(
      [
        story(
          "US-5",
          "STATUS CORRECTION: the old hold was stale | later: migration 00100 (HELD)",
        ),
      ],
      PUSHED,
    );
    expect(hits.map((h: Hit) => h.id)).toEqual(["US-5"]);
  });

  it("does NOT filter on passes, and that is correct here", () => {
    // Written expecting a filter, and there is none — so this pins the real
    // contract rather than the assumed one. It is right: a stale freeze misleads
    // whoever reads the note, and a closed story's notes get read plenty (four
    // were re-read today). The reason it does not flood the output is that
    // archive-passing-stories.mjs moves passes:true rows out of prd.json, so the
    // active file this runs over is effectively open-only.
    //
    // That coupling is worth stating: if archiving ever stops, this check starts
    // reporting closed stories, and the fix is to archive — not to add a filter
    // that would hide a stale freeze from the next reader.
    const closed = { id: "US-6", passes: true, notes: "migration 00100 (HELD)" };
    expect(findStaleHeldMigrations([closed], PUSHED).map((h: Hit) => h.id)).toEqual([
      "US-6",
    ]);
  });
});
