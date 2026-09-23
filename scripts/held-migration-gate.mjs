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
// THE INPUT IS A REGISTRY NOW, NOT THE HEADINGS (2026-09-23, platform plan
// action 6). Seven bypasses, recorded below, were all the same bug: a regex
// over hand-written prose headings that matched nothing and printed "OK". The
// gate now reads supabase/held-migrations.json and nothing else. The heading
// parser below is kept for one job only: held-migrations-registry.test.mjs
// runs it over PENDING_MIGRATIONS.md and fails if a HELD heading and the
// registry disagree, so the prose and the list cannot drift apart silently.
// A registry that is missing or will not parse BLOCKS; it never reads as empty.
//
// Usage:  node scripts/held-migration-gate.mjs [--upstream origin/main] [--ci]
// Exit 0 = clean, exit 1 = a held migration has reached (or is on) origin.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REGISTRY = "supabase/held-migrations.json";
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
// AND THE COLON IS NOT ALWAYS NEXT TO THE WORD (2026-09-09). SIXTH bypass, and
// the first caused by the file's own good habit: every applied entry is dated
// inline - `## ✅ APPLIED 2026-09-08: 00772 — …` - so writing a held one the
// same way is the natural thing to do. `## ⏳ HELD 2026-09-06: 00745: …` did
// exactly that, and the regex, which wanted the version immediately after
// `HELD:`, matched nothing. 00745 (US-3132, two new tables) then sat unapplied
// on origin/main for three days while the gate reported it clean, and it
// surfaced only because a push was blocked by six OTHER entries and someone
// read the file by hand.
//
// So: an optional date, or any short bracketing token, may sit between the
// keyword and the colon. Same lesson a third time - filename, then vocabulary,
// now punctuation. Every version of this bug fails in the direction of saying
// yes, so the regex is now deliberately loose about everything except the two
// things that carry meaning: the keyword and the five-digit version.
// AND ONE HEADING CAN NAME MORE THAN ONE MIGRATION (2026-09-20). SEVENTH
// bypass, and it was introduced by the same commit that fixed it: US-3355 lands
// three batch files and the natural heading is
// `## HELD: 00810 / 00811 / 00812 - revoke ...`. The regex captured ONE version
// per heading, so the gate listed 00810 and said nothing about the other two -
// again failing in the direction of yes.
//
// The heading line is now matched first, and EVERY five-digit version on it is
// read. A trailing `_name.sql` still binds to the version it follows; the rest
// resolve through fileForVersion. Seventh time the lesson is the same, so it is
// worth stating flatly: this regex must be loose about everything except the
// keyword and the versions.
const HELD_HEADING =
  /^##\s*(?:\S+\s+)?(?:HELD|PENDING)\b[^:\n]*:(.*)$/gm;
const VERSION_IN_HEADING = /\b(\d{5})(?:_([A-Za-z0-9_.-]+\.sql))?/g;
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

/** The branch's own tracking ref, or null when it has none (a fresh branch). */
export function trackingUpstream(run = git) {
  try {
    return run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || null;
  } catch {
    return null;
  }
}

/**
 * The refs a held migration is checked against, in priority order.
 *
 * An explicit --upstream means the caller is asking one specific question, so it
 * wins alone. Otherwise it is the branch's tracking ref AND origin/main: a
 * feature branch can leak to its own remote without main ever seeing the file,
 * and main can carry a leak this branch does not have.
 */
export function upstreamRefs(explicit, tracking) {
  if (explicit) return [explicit];
  return [...new Set([tracking, "origin/main"].filter(Boolean))];
}

/** True when the ref resolves locally. A fresh clone may not have origin/main. */
function refExists(ref) {
  try {
    git(["rev-parse", "--verify", `${ref}^{commit}`]);
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
  for (const heading of docText.matchAll(HELD_HEADING)) {
    for (const m of heading[1].matchAll(VERSION_IN_HEADING)) {
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
  }
  return out;
}

/**
 * The held list from supabase/held-migrations.json.
 *
 * Returns `{ held, errors }`. Any error is a reason to BLOCK, not to skip: a
 * registry that silently reads as empty is the same "no HELD migrations - OK"
 * this file has recorded seven times. `file` is the repo path, or null when
 * nothing on disk carries that name (reported by the caller, as before).
 */
export function heldFromRegistry(text, exists = existsSync) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { held: [], errors: [`${REGISTRY} is not valid JSON: ${e.message}`] };
  }
  if (!data || !Array.isArray(data.held)) {
    return { held: [], errors: [`${REGISTRY} has no "held" array`] };
  }
  const held = [];
  const seen = new Set();
  for (const [i, e] of data.held.entries()) {
    const version = e?.version;
    const name = e?.file;
    if (typeof version !== "string" || !/^\d{5}$/.test(version)) {
      errors.push(`held[${i}] has no five-digit "version"`);
      continue;
    }
    if (typeof name !== "string" || !name.startsWith(version + "_") || !name.endsWith(".sql")) {
      errors.push(`held[${i}] (${version}) needs "file": "${version}_<name>.sql"`);
      continue;
    }
    if (seen.has(version)) {
      errors.push(`held[${i}] lists ${version} a second time`);
      continue;
    }
    seen.add(version);
    const file = `${MIGRATIONS_DIR}/${name}`;
    held.push({ version, file: exists(file) ? file : null, named: file });
  }
  return { held, errors };
}

function main() {
  const ciMode = process.argv.includes("--ci");

  let registryText;
  try {
    registryText = readFileSync(REGISTRY, "utf8");
  } catch {
    // Fail CLOSED. The old input's missing-file branch printed "nothing to
    // check" and exited 0; a deleted registry must not be a way to disarm this.
    console.error(`[held-migration-gate] BLOCKED — ${REGISTRY} is missing.`);
    console.error("  It is the gate's only input. Restore it; an empty list is");
    console.error('  written as { "held": [] }, never as no file.');
    return 1;
  }

  const { held, errors } = heldFromRegistry(registryText);
  if (errors.length > 0) {
    console.error(`[held-migration-gate] BLOCKED — ${REGISTRY} cannot be trusted:`);
    for (const e of errors) console.error(`  • ${e}`);
    return 1;
  }

  // An entry naming a file that is not on disk is SAID OUT LOUD and then set
  // aside. It cannot be "in this push" - there is nothing to push - but
  // silently dropping it is the habit that let a mis-formatted heading disarm
  // this gate in the first place.
  for (const h of held.filter((h) => !h.file)) {
    console.warn(
      `[held-migration-gate] ${REGISTRY} marks ${h.version} held, but ` +
        `${h.named} does not exist. Renamed, or a typo in the entry.`,
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
      `[held-migration-gate] BLOCKED — these migrations are held in ${REGISTRY} ` +
        "and are present on the pushed commit:",
    );
    for (const h of present) console.error(`  • ${h.file}`);
    console.error("");
    console.error("  A held migration must not reach origin before its SQL is applied.");
    console.error(`  If it HAS been applied, delete its entry from ${REGISTRY} and flip`);
    console.error("  its PENDING_MIGRATIONS.md heading to '## ✅ APPLIED:' with a date,");
    console.error("  in one commit. That is the fix, not bypassing this.");
    console.error("");
    return 1;
  }

  // WHICH REFS COUNT AS "UPSTREAM", and why this is a list (2026-09-18, US-3423).
  //
  // This resolved to origin/main and nothing else, so on a FEATURE branch it
  // asked the wrong question. Measured here: 00793 and 00797 were already on
  // origin/claude/wizardly-gauss-8osusm — the leak had happened — and the gate
  // reported them under "this push would send a migration", with the remedy for
  // a leak that was still preventable. The block was right; the sentence under
  // it was false, and it was false in the one direction this file keeps warning
  // about, the direction where an operator acts on the wrong message.
  //
  // It also blocked a push carrying NO migration at all, which is how a control
  // earns a --no-verify habit. Three of this gate's six recorded bypasses were
  // --no-verify.
  //
  // So: the branch's own tracking ref AND origin/main, both, deduped. Checking
  // more refs can only move a file from `incoming` into `already` or add one
  // that neither bucket held — it can never let a held migration through.
  const refs = upstreamRefs(arg("--upstream", null), trackingUpstream()).filter(
    refExists,
  );

  if (refs.length === 0) {
    console.log(
      `[held-migration-gate] no upstream ref found locally (tried ` +
        `${upstreamRefs(arg("--upstream", null), trackingUpstream()).join(", ")}) — skipping.`,
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
  //
  // `onAnyRef` replaced `existsInRef(upstream, …)`. The incoming predicate is
  // still "not upstream yet, but present here" — existsSync is deliberately
  // kept rather than a diff range, because a range that fails to compute would
  // answer "nothing incoming", and every failure of this control has been in
  // the direction of saying yes.
  // The ref each held file was found on, or null. Named per file rather than
  // per heading: with two refs in play, "ALREADY ON origin/main" over a file
  // that is only on the feature branch is the same false sentence this change
  // exists to remove, one layer in.
  const refOf = (h) => refs.find((ref) => existsInRef(ref, h.file)) ?? null;
  const already = runnable.filter((h) => refOf(h) !== null);
  const incoming = runnable.filter((h) => refOf(h) === null && existsSync(h.file));
  const leaked = [...already, ...incoming];

  if (leaked.length === 0) {
    console.log(
      `[held-migration-gate] ${runnable.length} HELD migration(s), none on ` +
        `${refs.join(" or ")} — OK.`,
    );
    return 0;
  }

  if (already.length === 0) {
    console.error("");
    console.error(
      "[held-migration-gate] BLOCKED — this push would send a migration that " +
        `${REGISTRY} still marks held:`,
    );
    for (const h of incoming) console.error(`  • ${h.file}`);
    console.error("");
    console.error("  Apply the SQL to prod first, then delete its registry entry and flip");
    console.error("  its heading to '## ✅ APPLIED:' with a date. That is the rule this enforces:");
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
  console.error("  ALREADY ON ORIGIN — the rule was broken earlier:");
  for (const h of already) console.error(`  • ${h.file}  (on ${refOf(h)})`);
  console.error("");
  console.error("  Either the SQL was applied to prod and the registry was never");
  console.error(`  updated (delete the entry from ${REGISTRY} and flip the heading),`);
  console.error("  or code shipped ahead of the schema and the migration needs");
  console.error("  applying now. Do not bypass this to make it quiet.");
  console.error("");
  // Only when there IS one. An empty list under this heading followed by its
  // remedy is the 2026-08-15 defect wearing different clothes: a true heading
  // over nothing, and an instruction addressed to a situation that is not
  // happening. Printed here on 2026-09-18 with `incoming` empty.
  if (incoming.length > 0) {
    console.error("  IN THIS PUSH — still preventable:");
    for (const h of incoming) console.error(`  • ${h.file}`);
    console.error("");
    console.error("  Apply the SQL to prod first, then delete its registry entry and");
    console.error("  flip its heading to '## ✅ APPLIED:' with a date.");
    console.error("");
  }
  return 1;
}

// pathToFileURL, not a hand-built file:// string — on Windows the manual form
// produces file://C:/... (two slashes) against Node's file:///C:/... and the
// comparison silently never matches, so the gate exits 0 having checked nothing.
// A guard that passes by doing nothing is worse than no guard.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
