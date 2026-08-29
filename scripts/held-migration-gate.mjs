// US-2346 AC4: refuse to push a migration that PENDING_MIGRATIONS.md still
// marks HELD.
//
// The held-migration rule is that a commit containing a migration reaches
// origin only AFTER the operator has applied the SQL to prod — otherwise the
// frontend auto-deploys and the edge's boot guard starts expecting a schema
// version the database does not have.
//
// That rule has been enforced by a hand-edited marker in PENDING_MIGRATIONS.md,
// and it has now failed twice six days apart: 00504-00506 (the original
// US-2346), and then 00510/00511, which sit on origin/main while still marked
// HELD in a file whose own header says prod is two versions behind. The second
// occurrence happened in a file that already contains a paragraph explaining
// the first. A paragraph is not a control.
//
// This is the control. It keys on the HELD MARKER, not on the migration's
// existence — otherwise it would block every push after a migration is
// legitimately applied and its heading flipped to APPLIED.
//
// AND IT FAILED A THIRD TIME, on 2026-08-03, with this gate already installed.
// 00515-00521 reached origin while still marked HELD. The hook runs on the
// machine that pushes; `--no-verify` skips it, a different clone never had it,
// and a concurrent agent pushing the same branch is not covered by any of them.
// The note that shipped this gate said so at the time — "the hook is bypassable
// with --no-verify, so the same check belongs in CI, where the comparison is
// against the pushed ref" — and that half was never built. This adds it.
//
// TWO MODES, because the question is different in each place:
//
//   • hook (default): is a HELD migration ALREADY reachable from the upstream
//     ref? Run before the push, this catches a leak that happened earlier.
//   • --ci: does a HELD migration EXIST in this tree at all? CI runs on the
//     pushed commit, so the file being here IS the leak — there is no "about to
//     push" left to prevent, only a report that it already happened.
//
// Both key on the HELD MARKER rather than on the migration's existence.
// Otherwise every push after a migration is legitimately applied and flipped to
// APPLIED would be blocked.
//
// Usage:  node scripts/held-migration-gate.mjs [--upstream origin/main] [--ci]
// Exit 0 = clean, exit 1 = a held migration has reached (or is on) origin.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DOC = "PENDING_MIGRATIONS.md";
// Headings look like:  ## ⏳ HELD: 00512_job_lock_holder_release.sql (US-2311 …)
// Deliberately tolerant of the emoji so a copy-paste that loses it still matches.
//
// THE FILENAME IS OPTIONAL, and that is a fix rather than a convenience
// (2026-08-22). This regex used to require `NNNNN_name.sql`. Two headings in
// PENDING_MIGRATIONS.md were written as `## HELD: 00645 - why a visual run
// offered nothing` - a version number and prose, no filename - so neither
// matched, and the gate printed "no HELD migrations listed - OK" while the file
// marked one held and origin/main already carried it. That is the FOURTH time
// this control has been routed around, and the first time by a heading rather
// than by `--no-verify`.
//
// So the VERSION alone arms it and the filename is resolved from the migrations
// directory. A gate that only fires on a perfectly formatted heading is a gate
// whose real trigger is formatting.
//
// AND THE WORD IS NOT ONLY "HELD" (2026-08-28). This is the FIFTH time the
// control has been routed around and the first by a SYNONYM. The active
// convention in PENDING_MIGRATIONS.md had drifted to `## ⏳ PENDING: NNNNN_…`,
// which this regex did not match, so the gate printed "no HELD migrations
// listed - OK" while the file carried TWO unapplied entries - 00678 (US-2956)
// and 00682 (US-2890) - and origin/main already had both.
//
// The lesson is the same one the filename fix taught and is worth stating
// twice: a gate whose real trigger is vocabulary is a gate that fails the day
// someone reaches for a different word, and it fails QUIETLY, in the direction
// of saying yes. Both words arm it now, and a test pins that.
const HELD_HEADING =
  /^##\s*(?:\S+\s+)?(?:HELD|PENDING):\s*(\d{5})(?:_([A-Za-z0-9_.-]+\.sql))?/gm;
const MIGRATIONS_DIR = "supabase/migrations";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** True when `path` exists in the given ref. */
function existsInRef(ref, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve a bare version to the file it names.
 *
 * Returns null when nothing on disk starts with that version - a heading for a
 * migration that was renamed, or never existed. Null is REPORTED by the caller
 * rather than guessed at: inventing a path would make the gate block on a file
 * nobody can find, which is how a control gets bypassed instead of fixed.
 */
function fileForVersion(version, readdir) {
  const hit = readdir(MIGRATIONS_DIR).find(
    (n) => n.startsWith(version + "_") && n.endsWith(".sql"),
  );
  return hit ? `${MIGRATIONS_DIR}/${hit}` : null;
}

export function heldMigrations(docText, readdir = defaultReaddir) {
  const out = [];
  const seen = new Set();
  for (const m of docText.matchAll(HELD_HEADING)) {
    const version = m[1];
    // One heading per version. A file that names the same migration twice -
    // an entry plus a later correction - is one held migration, not two.
    if (seen.has(version)) continue;
    seen.add(version);
    const file = m[2]
      ? `${MIGRATIONS_DIR}/${version}_${m[2]}`
      : fileForVersion(version, readdir);
    out.push({ version, file });
  }
  return out;
}

function main() {
  const upstream = arg("--upstream", "origin/main");
  const ciMode = process.argv.includes("--ci");

  let doc;
  try {
    doc = readFileSync(DOC, "utf8");
  } catch {
    console.log(`[held-migration-gate] no ${DOC} — nothing to check.`);
    return 0;
  }

  const held = heldMigrations(doc);

  // A heading naming a version with no file on disk is SAID OUT LOUD and then
  // set aside. It cannot be "in this push" - there is nothing to push - but
  // silently dropping it is the habit that let a mis-formatted heading disarm
  // this gate in the first place.
  for (const h of held.filter((h) => !h.file)) {
    console.warn(
      `[held-migration-gate] ${DOC} marks ${h.version} HELD, but no ` +
        `${MIGRATIONS_DIR}/${h.version}_*.sql exists. Renamed, or a typo in ` +
        `the heading.`,
    );
  }
  // Everything below asks a question about a PATH, so an orphan is dropped
  // once here rather than guarded at each of the six call sites.
  const runnable = held.filter((h) => h.file);

  if (runnable.length === 0) {
    console.log("[held-migration-gate] no HELD migrations listed — OK.");
    return 0;
  }

  // In CI the checkout IS the pushed commit, so the question is simply whether
  // the file is here. No ref comparison, and deliberately no "skip if the
  // upstream is missing" escape — that escape is right for a fresh clone on a
  // developer machine and wrong for the gate of last resort.
  if (ciMode) {
    const present = runnable.filter((h) => existsSync(h.file));
    if (present.length === 0) {
      console.log(
        `[held-migration-gate] ${runnable.length} HELD migration(s), none in this ` +
          `commit — OK.`,
      );
      return 0;
    }
    console.error("");
    console.error(
      "[held-migration-gate] BLOCKED — these migrations are marked HELD in " +
        "PENDING_MIGRATIONS.md and are present on the pushed commit:",
    );
    for (const h of present) console.error(`  • ${h.file}`);
    console.error("");
    console.error("  A held migration must not reach origin before its SQL is applied.");
    console.error("  If it HAS been applied, flip its heading to '## ✅ APPLIED:' and");
    console.error("  date it — that is the fix, not bypassing this.");
    console.error("");
    return 1;
  }

  // Does the upstream ref exist locally? On a fresh clone or a new branch it
  // may not, in which case there is nothing to compare against and blocking
  // would be wrong.
  try {
    git(["rev-parse", "--verify", `${upstream}^{commit}`]);
  } catch {
    console.log(
      `[held-migration-gate] upstream ${upstream} not found locally — skipping.`,
    );
    return 0;
  }

  // TWO QUESTIONS, and the second was missing until 2026-08-03.
  //
  // `already` is a leak that HAPPENED: the file is upstream while still marked
  // held. That was the whole hook, and it is retrospective — it reports a rule
  // that was already broken and cannot prevent the next break.
  //
  // `incoming` is the leak ABOUT TO HAPPEN: the file is in the commits this push
  // would send. Found by using the gate on a real held migration — the hook said
  // OK (correctly, by its own question) and the CI copy blocked a moment later,
  // which is the worst possible split: locally green, red after pushing. A
  // pre-push hook that cannot stop the thing it is named for is a detector, not
  // a gate.
  const already = runnable.filter((h) => existsInRef(upstream, h.file));
  const incoming = runnable.filter(
    (h) => !existsInRef(upstream, h.file) && existsSync(h.file),
  );
  const leaked = [...already, ...incoming];

  if (leaked.length === 0) {
    console.log(
      `[held-migration-gate] ${runnable.length} HELD migration(s), none on ${upstream} — OK.`,
    );
    return 0;
  }

  if (already.length === 0) {
    console.error("");
    console.error(
      "[held-migration-gate] BLOCKED — this push would send a migration that " +
        "PENDING_MIGRATIONS.md still marks HELD:",
    );
    for (const h of incoming) console.error(`  • ${h.file}`);
    console.error("");
    console.error("  Apply the SQL to prod first, then flip its heading to");
    console.error("  '## ✅ APPLIED:' and date it. That is the rule this enforces:");
    console.error("  the SQL lands before the code that expects it.");
    console.error("");
    return 1;
  }

  // BOTH kinds are present. They are different situations with different
  // remedies, and printing them under one heading is how an operator ends up
  // applying the wrong fix to the wrong file.
  //
  // Measured 2026-08-15: five migrations were listed here under "already on
  // origin/main" and two of them (00605, 00606) were not on origin at all —
  // they were the incoming set, sitting unpushed in the working tree, having
  // been applied to prod exactly as the rule asks. An operator following the
  // printed advice would have flipped a heading to APPLIED on the strength of a
  // leak that never happened, and the next genuinely-held migration in that
  // section would have inherited the flip.
  console.error("");
  console.error("[held-migration-gate] BLOCKED — two different problems:");
  console.error("");
  console.error(`  ALREADY ON ${upstream} — the rule was broken earlier:`);
  for (const h of already) console.error(`  • ${h.file}`);
  console.error("");
  console.error("  Either the SQL was applied to prod and PENDING_MIGRATIONS.md was");
  console.error("  never updated (flip the heading to '## ✅ APPLIED:' and date it),");
  console.error("  or code shipped ahead of the schema and the migration needs");
  console.error("  applying now. Do not bypass this to make it quiet.");
  console.error("");
  console.error("  IN THIS PUSH — still preventable:");
  for (const h of incoming) console.error(`  • ${h.file}`);
  console.error("");
  console.error("  Apply the SQL to prod first, then flip its heading to");
  console.error("  '## ✅ APPLIED:' and date it.");
  console.error("");
  return 1;
}

// pathToFileURL, not a hand-built file:// string — on Windows the manual form
// produces file://C:/... (two slashes) against Node's file:///C:/... and the
// comparison silently never matches, so the gate exits 0 having checked nothing.
// A guard that passes by doing nothing is worse than no guard.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
