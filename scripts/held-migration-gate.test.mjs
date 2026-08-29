// US-2346 AC4: the held-migration gate's parser.
//
// The git half needs a repo, so what is unit-tested here is the part that
// decides WHICH migrations count as held — the half that, if it silently
// matched nothing, would make the gate pass by doing nothing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { heldMigrations } from "./held-migration-gate.mjs";

describe("US-2346: which headings count as HELD", () => {
  it("reads the real file's shape, emoji and all", () => {
    const doc = [
      "# PENDING MIGRATIONS",
      "",
      "## ⏳ HELD: 00512_job_lock_holder_release.sql (US-2311 job-lock holder check, 2026-08-02)",
      "- some prose",
      "",
      "## ⏳ HELD: 00511_submissions_protected_columns_guard.sql (US-2376, 2026-08-01)",
    ].join("\n");
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00512", "00511"]);
    expect(heldMigrations(doc)[0].file).toBe(
      "supabase/migrations/00512_job_lock_holder_release.sql",
    );
  });

  it("matches PENDING as well as HELD, because the vocabulary drifted", () => {
    // 2026-08-28. This is the FIFTH time this control has been routed around
    // and the first by a SYNONYM. PENDING_MIGRATIONS.md's active convention had
    // become "## ⏳ PENDING: NNNNN_…" while the gate only matched "HELD:", so it
    // printed "no HELD migrations listed — OK" with TWO unapplied entries in the
    // file and BOTH already on origin/main: 00678 (US-2956) and 00682 (US-2890).
    //
    // A gate whose real trigger is vocabulary fails the day someone reaches for
    // a different word, and it fails quietly, in the direction of saying yes.
    const doc = [
      "# PENDING MIGRATIONS",
      "",
      "## ⏳ PENDING: 00682_auto_upright_setting.sql (US-2890)",
      "",
      "## ⏳ PENDING: 00678_listing_description_blocks.sql (US-2956)",
    ].join("\n");
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00682", "00678"]);
  });

  it("treats HELD and PENDING as the same state in one document", () => {
    // Both spellings appear in the file's history, so a mixed document has to
    // arm on every one of them rather than on whichever came first.
    const doc = [
      "## ⏳ HELD: 00512_job_lock_holder_release.sql (US-2311)",
      "## ⏳ PENDING: 00682_auto_upright_setting.sql (US-2890)",
      "## ✅ APPLIED: 00677_marketplace_promotions.sql (US-2949)",
    ].join("\n");
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00512", "00682"]);
  });

  it("does not match the word PENDING in prose", () => {
    // The complement of the HELD-in-prose case below. The file's own header is
    // "# PENDING MIGRATIONS — applied to prod separately from the push", and a
    // gate that armed on that would block every push forever.
    const doc = [
      "# PENDING MIGRATIONS — applied to prod separately from the push",
      "",
      "Nothing is pending right now; 00682 was applied on 2026-08-28.",
    ].join("\n");
    expect(heldMigrations(doc)).toEqual([]);
  });

  it("ignores an APPLIED heading — this is the whole point of keying on the marker", () => {
    // Keying on the migration's EXISTENCE instead would block every push after
    // a migration is legitimately applied and its heading flipped.
    const doc = [
      "## ✅ APPLIED: 00506_items_full_quality_score.sql (US-2170, 2026-07-30)",
      "## ✅ APPLIED: 00505_grading_roi_period_filter.sql (US-2234, 2026-07-30)",
    ].join("\n");
    expect(heldMigrations(doc)).toEqual([]);
  });

  it("survives a lost emoji, because a copy-paste that drops it must not disarm the gate", () => {
    const doc = "## HELD: 00512_job_lock_holder_release.sql (US-2311)";
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00512"]);
  });

  it("does not match the word HELD in prose", () => {
    const doc = [
      "Some paragraph explaining why a migration is HELD: it has not been applied.",
      "- **Apply order.** After 00511.",
    ].join("\n");
    expect(heldMigrations(doc)).toEqual([]);
  });

  it("returns nothing for a doc with no headings at all", () => {
    expect(heldMigrations("# PENDING MIGRATIONS\n\nNothing pending.\n")).toEqual([]);
  });

  it("matches the template line in the doc's own footer only if it is a real version", () => {
    // The footer shows `## ⏳ HELD: NNNNN_name.sql` as an instruction. NNNNN is
    // not five digits, so it must not be picked up as a pending migration.
    const doc = "Add one `## ⏳ HELD: NNNNN_name.sql (US-#### short title, YYYY-MM-DD)` heading";
    expect(heldMigrations(doc)).toEqual([]);
  });
});

// ── US-2346 AC4, CI half ────────────────────────────────────────────────────
//
// The hook has run this gate since 2026-08-02 and a held migration STILL reached
// origin on 2026-08-03. The hook lives on the machine that pushes, so
// `--no-verify`, a different clone, or a concurrent agent pushing the same
// branch all walk past it. CI mode is the copy that cannot be skipped, and it
// asks a different question: not "is this already upstream" but "is it HERE",
// because CI runs on the pushed commit and the file being present IS the leak.
describe("US-2346: the CI half of the gate", () => {
  it("is wired into ci.yml, not only into the hook", () => {
    const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(
      ci.includes("held-migration-gate.mjs --ci"),
      "the CI copy is gone — the gate is back to being skippable with --no-verify",
    ).toBe(true);
    const hook = readFileSync(resolve(process.cwd(), ".githooks/pre-push"), "utf8");
    expect(
      hook.includes("held-migration-gate.mjs"),
      "the hook copy is gone — the fast local feedback went with it",
    ).toBe(true);
  });

  it("CI mode has no upstream-missing escape hatch", () => {
    // The hook skips when the upstream ref is absent, which is right on a fresh
    // clone. In CI that escape would be a way for the gate of last resort to
    // pass by doing nothing — the exact failure this script's own header warns
    // about.
    const src = readFileSync(resolve(process.cwd(), "scripts/held-migration-gate.mjs"), "utf8");
    const ci = src.slice(src.indexOf("if (ciMode) {"), src.indexOf("// Does the upstream ref exist"));
    expect(ci.length).toBeGreaterThan(100);
    expect(ci).not.toContain("rev-parse");
    expect(ci).toContain("existsSync");
  });

  it("both modes key on the HELD marker, never on the file's existence alone", () => {
    // The design decision that makes it usable. Keying on the migration being
    // present would block every push after one is legitimately applied and its
    // heading flipped to APPLIED.
    const src = readFileSync(resolve(process.cwd(), "scripts/held-migration-gate.mjs"), "utf8");
    expect(src).toContain("HELD_HEADING");
    expect(
      /const held = heldMigrations\(doc\)/.test(src),
      "the gate no longer derives its list from the HELD headings",
    ).toBe(true);
  });
});

// ── The gap the gate found in itself, 2026-08-03 ────────────────────────────
//
// The hook only ever asked "is a held migration ALREADY upstream?" — which is
// retrospective. Using it on a real held migration showed the split: the hook
// said OK (correctly, by its own question) and the CI copy blocked a moment
// later. Locally green, red after pushing, which is the worst arrangement of
// the two. A pre-push hook that cannot stop the thing it is named for is a
// detector, not a gate.
describe("US-2346: the hook blocks an INCOMING held migration", () => {
  it("asks both questions, not only the retrospective one", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/held-migration-gate.mjs"), "utf8");
    expect(src, "the already-upstream check is gone").toContain("const already =");
    expect(
      src,
      "the incoming check is gone — the hook is back to reporting a rule that " +
        "was already broken rather than preventing the next break",
    ).toContain("const incoming =");
    // The incoming case is "not upstream yet, but present here", and both halves
    // matter: without the first it would fire on every already-known leak twice,
    // without the second it fires on nothing.
    expect(src).toMatch(/!existsInRef\(upstream, h\.file\)[\s\S]{0,80}existsSync\(h\.file\)/);
  });

  it("tells the two cases apart in its output", () => {
    // They need different fixes. "Already upstream" usually means the doc was
    // never updated after applying; "about to push" means apply the SQL first.
    const src = readFileSync(resolve(process.cwd(), "scripts/held-migration-gate.mjs"), "utf8");
    expect(src).toContain("this push would send a migration");
    expect(src).toContain("ALREADY ON ");
  });

  it("does not print an incoming migration under the already-upstream heading", () => {
    // The defect, measured 2026-08-15 on this repo: with both sets non-empty
    // the branch printed `leaked` — already PLUS incoming — under a heading
    // reading "held migrations are already on origin/main". Two of the five it
    // named were not on origin at all. The remedy it advises for that heading
    // is "flip it to APPLIED", so following the message would have marked an
    // unapplied migration as applied, and the section would have carried that
    // flip forward to the next one written under it.
    const src = readFileSync(resolve(process.cwd(), "scripts/held-migration-gate.mjs"), "utf8");
    const both = src.slice(src.indexOf("BOTH kinds are present"));
    expect(
      both,
      "the both-present branch still prints the combined list under one heading",
    ).not.toMatch(/for \(const h of leaked\)/);
    // Each list printed from its own array, so the heading above it is true.
    expect(both).toMatch(/for \(const h of already\)/);
    expect(both).toMatch(/for \(const h of incoming\)/);
  });
});

// ── The gap the gate found in itself, 2026-08-22 ────────────────────────────
//
// The FOURTH bypass of this control, and the first that was not `--no-verify`.
//
// PENDING_MIGRATIONS.md carried two HELD headings written as
// `## HELD: 00645 - why a visual run offered nothing`: a version number and
// prose, with no `_name.sql`. HELD_HEADING required the filename, so neither
// matched. The gate printed "no HELD migrations listed - OK" while the file
// marked one held and origin/main already carried it — a green control with
// nothing behind it, which is worse than no control, because the green is read
// as evidence.
//
// The fix is that the VERSION arms the gate and the filename is resolved from
// disk. These pin that, because the failure mode is silence: a regression here
// does not throw, it returns an empty list.

describe("US-2777: a heading with no filename still arms the gate", () => {
  const readdir = () => [
    "00644_cross_post_channels.sql",
    "00645_provenance_decline_reason.sql",
    "00648_lister_locales.sql",
  ];

  it("resolves a bare version to the file on disk", () => {
    const held = heldMigrations("## HELD: 00645 - why a visual run offered nothing", readdir);
    expect(held).toEqual([
      { version: "00645", file: "supabase/migrations/00645_provenance_decline_reason.sql" },
    ]);
  });

  it("still reads a fully spelled heading, filename and all", () => {
    const held = heldMigrations("## ⏳ HELD: 00648_lister_locales.sql (US-2777)", readdir);
    expect(held).toEqual([
      { version: "00648", file: "supabase/migrations/00648_lister_locales.sql" },
    ]);
  });

  it("reports a version with no file rather than inventing a path", () => {
    // A renamed migration, or a typo. `file: null` is what makes the caller
    // warn about it; a guessed path would make the gate block on something
    // nobody can find, which is how a control gets bypassed instead of fixed.
    const held = heldMigrations("## HELD: 09999 - nothing on disk", readdir);
    expect(held).toEqual([{ version: "09999", file: null }]);
  });

  it("counts one migration once even when the file names it twice", () => {
    const doc = [
      "## HELD: 00648_lister_locales.sql (US-2777)",
      "",
      "## HELD: 00648 - a later correction to the same entry",
    ].join("\n");
    expect(heldMigrations(doc, readdir)).toHaveLength(1);
  });

  it("the real PENDING_MIGRATIONS.md headings all parse", () => {
    // The regression that started this: a heading nobody could see. Every HELD
    // heading in the shipped file must resolve to a real path.
    const doc = readFileSync(resolve(process.cwd(), "PENDING_MIGRATIONS.md"), "utf8");
    for (const h of heldMigrations(doc)) {
      expect(h.file, `PENDING_MIGRATIONS.md marks ${h.version} HELD with no file on disk`)
        .not.toBeNull();
    }
  });
});
