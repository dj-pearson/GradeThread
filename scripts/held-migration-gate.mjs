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
// Usage:  node scripts/held-migration-gate.mjs [--upstream origin/main]
// Exit 0 = clean, exit 1 = at least one held migration is already reachable
// from the upstream ref (or would be pushed).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DOC = "PENDING_MIGRATIONS.md";
// Headings look like:  ## ⏳ HELD: 00512_job_lock_holder_release.sql (US-2311 …)
// Deliberately tolerant of the emoji so a copy-paste that loses it still matches.
const HELD_HEADING = /^##\s*(?:\S+\s+)?HELD:\s*(\d{5})_([A-Za-z0-9_.-]+\.sql)/gm;

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

export function heldMigrations(docText) {
  const out = [];
  for (const m of docText.matchAll(HELD_HEADING)) {
    out.push({ version: m[1], file: `supabase/migrations/${m[1]}_${m[2]}` });
  }
  return out;
}

function main() {
  const upstream = arg("--upstream", "origin/main");

  let doc;
  try {
    doc = readFileSync(DOC, "utf8");
  } catch {
    console.log(`[held-migration-gate] no ${DOC} — nothing to check.`);
    return 0;
  }

  const held = heldMigrations(doc);
  if (held.length === 0) {
    console.log("[held-migration-gate] no HELD migrations listed — OK.");
    return 0;
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

  const leaked = held.filter((h) => existsInRef(upstream, h.file));

  if (leaked.length === 0) {
    console.log(
      `[held-migration-gate] ${held.length} HELD migration(s), none on ${upstream} — OK.`,
    );
    return 0;
  }

  console.error("");
  console.error("[held-migration-gate] BLOCKED — held migrations are already on " + upstream + ":");
  for (const h of leaked) console.error(`  • ${h.file}`);
  console.error("");
  console.error("  Either the SQL was applied to prod and PENDING_MIGRATIONS.md was");
  console.error("  never updated (flip the heading to '## ✅ APPLIED:' and date it),");
  console.error("  or code shipped ahead of the schema and the migration needs");
  console.error("  applying now. Do not bypass this to make it quiet.");
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
