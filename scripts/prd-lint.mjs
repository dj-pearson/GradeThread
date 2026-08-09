#!/usr/bin/env node
// US-1612 / AGENTIC-OS Phase 2 (Module Z): prd.json linter — the Ralph Governor's
// hygiene check on the OS's own backlog. Host-side, NOT edge code. It REPORTS;
// it NEVER rewrites prd.json (a passes:true re-archive is a human/stopped-loop
// procedure — see the accumulation reminder).
//
// Checks: nextId strictly greater than the max story id ANYWHERE (active + a
// targeted archive max-id probe that never JSON-parses the 1.6 MB archive), no
// duplicate ids, required fields present, and dependsOn has no cycles or
// references to ids that exist in neither the active backlog nor the archive.
// Errors exit nonzero; the accumulation + LEARNINGS.md-size guards are warnings.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isValidPriority } from "./lib/prd-priority.mjs";

export const ACCUMULATION_THRESHOLD = 50;
export const LEARNINGS_LINE_WARN = 800;
const REQUIRED_FIELDS = ["id", "title", "description", "acceptanceCriteria", "passes"];
// Subset of the above that only applies while a story is still PLANNED work.
export const PLANNING_FIELDS = ["description", "acceptanceCriteria"];

/** nextId as a number, accepting 2088 or "US-2088". null if neither. */
export function normalizeNextId(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/^US-(\d+)$/);
    if (m) return Number(m[1]);
  }
  return null;
}
const ID_RE = /^US-\d+$/;
const ID_FIELD_RE = /"id":\s*"US-(\d+)"/g;

export function parseIdNum(id) {
  const m = /^US-(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : NaN;
}

// The verbatim stop-the-loop-first procedure the accumulation reminder must
// carry (AC) — a prd.json rewrite while the Ralph loop runs would clobber it.
export function accumulationReminder(done, threshold) {
  return [
    `${done} passes:true stories in the ACTIVE prd.json (> ${threshold}) — re-archive them to prd.archive.json.`,
    "STOP THE RALPH LOOP FIRST so it can't clobber the rewrite:",
    "  bash scripts/ralph/stop-ralph.sh      (Git Bash / Linux / macOS)",
    "  pwsh scripts/ralph/stop-ralph.ps1     (Windows)",
    "Then move the passes:true stories into prd.archive.json and leave only the",
    "active (passes:false) backlog in prd.json. NEVER let the linter or an agent",
    "auto-rewrite prd.json — this is a human (or stopped-loop) procedure.",
  ].join("\n");
}

// ── Pure lint over already-loaded data ───────────────────────────────────────

// US-1996: a story marked passes:true whose notes still carry an UNRESOLVED
// blocker marker ("[DEFERRED …]", "NOT DONE (blocks passes)").
//
// WHY THIS IS A REAL CLASS AND NOT PEDANTRY. US-1770 shipped exactly this way:
// deferred pending a held migration, then closed anyway. Its authenticity eval
// gate has no callers, so the safety ACs it claims — a prompt must clear an
// accuracy gate BEFORE activation, a per-brand regression must BLOCK activation
// — are enforced by nothing, while the story reads as delivered. US-744 and
// US-1399 share the shape. Nothing surfaced any of them until someone thought to
// grep, which is not a control.
//
// WARNING, NEVER AN ERROR. A later note legitimately supersedes an earlier
// blocker: US-1883 carried "NOT DONE (blocks passes): AC2 …" for weeks and was
// then genuinely finished, the closing note appended after the stale one. Hard
// failing would punish the correct history. So this reports and lets a human
// judge.
const BLOCKER_MARKER =
  /(\[DEFERRED\b[^\]]*\]|\bDEFERRED \d{4}-\d{2}-\d{2}|NOT DONE \(blocks passes\)|\bblocks passes\b)/i;

// A STRUCTURED closing marker, deliberately CASE-SENSITIVE and anchored to a
// note segment — not an English word.
//
// The first version of this guard matched /\b(DONE|...)\b/i anywhere after the
// blocker, and so cleared US-1770 — the exact story it was written for —
// because 2300 characters later the prose said "best done in a user-present
// session". Searching long free text for a common word will always find it.
// Notes in this repo are append-only and pipe-separated, and real closings look
// like "| DONE 2026-07-12:", "| CLOSED 2026-07-18", "| PROD-VERIFIED", so the
// signal is an UPPERCASE token in a LATER SEGMENT.
// COMPLETION and "un-deferred" are listed because US-1399 was a real false
// positive: its notes carry "[COMPLETION 2026-07-03 - un-deferred]" and the work
// was genuinely finished, but COMPLETED? does not match COMPLETION, so the guard
// reported a resolved story as still blocked. A guard that cries wolf gets
// ignored — the same trust problem this whole check exists to fix.
const CLOSING_TOKEN =
  /\b(DONE|CLOSED|SHIPPED|COMPLETED?|COMPLETION|RESOLVED|VERIFIED|PROD-VERIFIED)\b|un-deferred/;
// "NOT DONE (blocks passes)" contains an uppercase DONE and is the OPPOSITE of a
// closing — it must never clear anything.
const NEGATED_CLOSING = /\bNOT\s+DONE\b/;

/**
 * Returns the stories that claim to pass while still carrying an unresolved
 * blocker marker. Pure + exported so it is testable on its own.
 *
 * Resolution requires an uppercase closing token in a note segment AFTER the one
 * raising the blocker. Segment-scoped because ordering is meaningful (notes are
 * append-only) and because free-text proximity is not evidence of anything.
 */
export function findUnresolvedDeferrals(stories) {
  const hits = [];
  for (const s of stories ?? []) {
    if (s?.passes !== true) continue;
    const notes = typeof s.notes === "string" ? s.notes : "";
    const m = BLOCKER_MARKER.exec(notes);
    if (!m) continue;

    const segments = notes.split(/\s\|\s/);
    // Which segment raised the blocker? (offset walk, so a marker appearing
    // twice resolves against its FIRST occurrence — the conservative choice.)
    let idx = 0;
    let seen = 0;
    for (let i = 0; i < segments.length; i++) {
      const end = seen + segments[i].length;
      if (m.index <= end) {
        idx = i;
        break;
      }
      seen = end + 3; // the " | " separator
    }

    // Resolution counts in a LATER segment, or later within the SAME one.
    //
    // The same-segment case is not a nicety: US-1399's entire history is a
    // single segment that ends in an un-deferral, so requiring a segment break
    // reported a finished story as blocked. Position still matters — text
    // BEFORE the marker cannot resolve it — and the token must be the
    // structured uppercase form, which is what keeps the original false
    // NEGATIVE closed (a lowercase prose "done" 2300 characters later must not
    // clear a real deferral, which is how the first version of this guard
    // cleared US-1770).
    const seg = segments[idx] ?? "";
    // Slice past the END of the marker, not one character past its start.
    // Slicing at +1 leaves "OT DONE (blocks passes)" behind, whose uppercase
    // DONE then clears the very blocker it announces — the guard's own suite
    // caught that regression.
    const segMatch = BLOCKER_MARKER.exec(seg);
    const afterInSeg = segMatch ? seg.slice(segMatch.index + segMatch[0].length) : "";
    const closedHere = CLOSING_TOKEN.test(afterInSeg) && !NEGATED_CLOSING.test(afterInSeg);
    const laterClosed = segments
      .slice(idx + 1)
      .some((sg) => CLOSING_TOKEN.test(sg) && !NEGATED_CLOSING.test(sg));
    if (closedHere || laterClosed) continue;
    hits.push({ id: s.id, marker: m[0].trim() });
  }
  return hits;
}

// US-1421/1849/1850: a story whose notes still say a migration is HELD, when
// that migration is already on origin/main.
//
// The invariant is exact, which is what makes this checkable at all: the
// standing rule says a commit containing a migration is NOT pushed until the
// operator applies the SQL. So a migration present on origin/main was pushed,
// which means its hold was released — and any note still calling it held is
// stale. A stale hold is not cosmetic: it tells the next reader the branch is
// frozen and invites a pointless prod session.
//
// Deliberately keyed on PUSHED rather than on a version number. That makes the
// check immune to its own corrections — an annotation explaining the fix names
// the genuinely-pending migrations, and those are by definition not on
// origin/main, so quoting them cannot re-trigger the warning. Reading version
// NUMBERS out of notes had exactly that failure, reclassifying corrected
// stories as pending because the correction mentioned 00475/00476.
const HELD_MARKER = /\bHELD\b|held migration|not pushed/i;
// Five digits. An earlier hand-written sweep used 00[3-4][0-9]{3} — six — and
// could never match 00345, so it reported zero and read as clean.
//
// NOT \b on the right, and that is the whole point. Underscore is a word
// character, so \b never fires between "00573" and "_" — which means the most
// natural way to name a migration in a note, its FILENAME
// (00573_legal_acceptances_signup_confirmed.sql), was invisible to this check.
// Found 2026-08-09 when US-2116 warned while holding 00573: the note named the
// held migration by filename, the id never matched, so the "does this note name
// anything genuinely unpushed?" escape hatch saw nothing to hold and cried wolf
// on a correct freeze. The same blindness runs the other way and is worse — a
// genuinely stale "00516_foo.sql (HELD)" would never have been reported at all.
// So: not preceded by a word character (don't split 000355 mid-number), and not
// followed by a DIGIT (a 6-digit name is not a 5-digit id). An underscore, a
// colon or a period after the number is part of how migrations are written
// about, not a reason to look away.
const MIGRATION_ID = /(?<!\w)(00\d{3})(?!\d)/g;

/**
 * Stories claiming a HELD migration that is already pushed.
 * `pushedMigrationIds` is a Set of five-digit ids present on origin/main.
 * Pure + exported; the CLI supplies the set from git.
 */
// Notes here are append-only, so a stale claim is corrected by APPENDING a
// correction rather than editing the original sentence out. Both texts then
// coexist, and a naive check keeps firing on a story someone already fixed —
// which is how a warning becomes background noise and stops being read. So an
// explicit correction silences it.
const HELD_CORRECTED =
  /STALE HELD-MIGRATION CLAIM|STATUS CORRECTION|is STALE and should not be acted on/i;

export function findStaleHeldMigrations(stories, pushedMigrationIds) {
  const hits = [];
  for (const s of stories ?? []) {
    const notes = typeof s?.notes === "string" ? s.notes : "";
    if (!HELD_MARKER.test(notes)) continue;
    // A CORRECTION ONLY CLEARS CLAIMS THAT CAME BEFORE IT.
    //
    // This used to test the whole notes string, so the first correction a story
    // ever carried suppressed the warning permanently — including for a HELD
    // claim written in a LATER segment. Found 2026-08-09 on US-2289: a
    // 2026-08-02 segment carries "STATUS CORRECTION", and the 2026-08-03
    // segment after it says "migration 00516 (HELD)" about a migration that is
    // on origin/main and applied. The guard was silent, which is the one thing
    // it exists not to be.
    //
    // Mirrors findUnresolvedDeferrals above, which already resolves by SEGMENT
    // ORDER for exactly this reason. Notes are append-only, so position is
    // meaningful: only a correction at or after the LAST held claim can be
    // talking about it.
    const heldSegments = notes.split(/\s\|\s/);
    const lastHeld = heldSegments.reduce(
      (acc, seg, i) => (HELD_MARKER.test(seg) ? i : acc),
      -1,
    );
    const correctedAfter = heldSegments
      .slice(Math.max(0, lastHeld))
      .some((seg) => HELD_CORRECTED.test(seg));
    if (correctedAfter) continue;
    const ids = [...new Set([...notes.matchAll(MIGRATION_ID)].map((m) => m[1]))];
    const pushed = ids.filter((id) => pushedMigrationIds.has(id)).sort();
    if (!pushed.length) continue;
    // A note that mentions ANY genuinely-unpushed migration is not stale: the
    // HELD claim is about that one, and the pushed ids are context (the note
    // citing which earlier migration added the column it builds on). Warning
    // here would be a false positive on a CORRECT hold — and a false positive
    // is worse than silence for this check, because its whole job is to stop a
    // reader trusting a stale freeze. Only warn when EVERY migration the note
    // names is already pushed, i.e. there is nothing left that could be held.
    if (ids.some((id) => !pushedMigrationIds.has(id))) continue;
    hits.push({ id: s.id, migrations: pushed });
  }
  return hits;
}

export function findCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const cycles = [];
  const stack = [];
  const seenCycle = new Set();
  const visit = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.get(u) ?? []) {
      if (!graph.has(v)) continue; // edge to an archive/leaf id — cannot cycle here
      if (color.get(v) === GRAY) {
        const i = stack.indexOf(v);
        const cyc = [...stack.slice(i), v];
        const norm = [...cyc].sort().join(",");
        if (!seenCycle.has(norm)) {
          seenCycle.add(norm);
          cycles.push(cyc);
        }
      } else if (color.get(v) === WHITE) {
        visit(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const k of graph.keys()) if (color.get(k) === WHITE) visit(k);
  return cycles;
}

export function lintPrd({ prd, archiveIds = new Set(), archiveMaxId = 0, archivedStories = [], learningsLines = 0, pushedMigrationIds = null, opts = {} }) {
  const errors = [];
  const warnings = [];
  const threshold = opts.accumulationThreshold ?? ACCUMULATION_THRESHOLD;
  const learningsWarn = opts.learningsLineWarn ?? LEARNINGS_LINE_WARN;
  const stories = Array.isArray(prd?.userStories) ? prd.userStories : [];

  // ids + duplicates + active max
  const seen = new Set();
  const activeIds = new Set();
  let maxActive = 0;
  for (const s of stories) {
    if (typeof s?.id !== "string" || !ID_RE.test(s.id)) {
      errors.push(`invalid id: ${JSON.stringify(s?.id)}`);
      continue;
    }
    if (seen.has(s.id)) errors.push(`duplicate id: ${s.id}`);
    seen.add(s.id);
    activeIds.add(s.id);
    maxActive = Math.max(maxActive, parseIdNum(s.id));
  }

  // required fields + type checks
  //
  // US-2088: description and acceptanceCriteria are PLANNING fields — they say
  // what the work is and how you will know it is done. A story that is already
  // `passes: true` cannot be planned; requiring them there is ceremony, and it
  // blocked a legitimate use that emerged in practice: recording a completed
  // audit or a negative result as a lightweight {id, title, passes, notes} entry.
  //
  // They stay REQUIRED for `passes: false`, which is the actionable backlog the
  // Ralph loop selects from and the only place the fields do any work. So the
  // guard still catches the failure that matters — an unplannable story entering
  // the queue — while no longer rejecting a finished record.
  for (const s of stories) {
    const id = typeof s?.id === "string" ? s.id : "(no id)";
    const planning = s?.passes !== true;
    for (const f of REQUIRED_FIELDS) {
      if (!planning && PLANNING_FIELDS.includes(f)) continue;
      if (!(f in s) || s[f] === undefined || s[f] === null) errors.push(`${id}: missing required field "${f}"`);
    }
    if ("acceptanceCriteria" in s && !Array.isArray(s.acceptanceCriteria)) errors.push(`${id}: acceptanceCriteria must be an array`);
    if ("passes" in s && typeof s.passes !== "boolean") errors.push(`${id}: passes must be a boolean`);
    // US-2371: `priority` may be absent — that means unranked, and the ascending
    // comparator sorts it last. What it may NOT be is present and non-numeric: a
    // string or a null yields NaN in the comparator, and a NaN comparator makes
    // TimSort emit an arbitrary order instead of an obviously wrong one, so the
    // same backlog silently produces different next stories on different runs.
    if (planning && "priority" in s && !isValidPriority(s.priority)) {
      errors.push(
        `${id}: priority must be a finite number or absent (absent = unranked, sorts last), got ${JSON.stringify(s.priority)}`,
      );
    }
  }

  // nextId strictly greater than the max id ANYWHERE.
  //
  // Accepts either 2088 or "US-2088". Only this linter reads nextId, so the
  // form is a style question; the invariant (it must beat every id anywhere) is
  // the part that matters, and it holds for both. The string form is canonical
  // because that is what an author copies straight into a new story's `id`.
  const maxAnywhere = Math.max(maxActive, archiveMaxId);
  const nextIdNum = normalizeNextId(prd?.nextId);
  if (nextIdNum === null) {
    errors.push(`nextId must be an integer or a "US-<n>" string, got ${JSON.stringify(prd?.nextId)}`);
  } else if (nextIdNum <= maxAnywhere) {
    errors.push(`nextId (${prd.nextId}) must be > the max story id anywhere (active max ${maxActive}, archive max ${archiveMaxId})`);
  }

  // dependsOn: unknown refs + cycles (only active→active edges can cycle)
  const known = new Set([...activeIds, ...archiveIds]);
  const graph = new Map();
  for (const s of stories) {
    if (typeof s?.id !== "string") continue;
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    graph.set(s.id, []);
    for (const d of deps) {
      if (!known.has(d)) errors.push(`${s.id}: dependsOn references unknown id ${d}`);
      if (activeIds.has(d)) graph.get(s.id).push(d);
    }
  }
  for (const cyc of findCycles(graph)) errors.push(`dependsOn cycle: ${cyc.join(" -> ")}`);

  // accumulation guard (WARNING — a full active backlog is not a failure)
  const done = stories.filter((s) => s?.passes === true).length;
  if (done > threshold) warnings.push(accumulationReminder(done, threshold));

  // US-1421/1849/1850 (WARNING): a HELD claim on an already-pushed migration.
  // Skipped entirely when the caller could not determine what is pushed (no
  // remote, offline) — guessing there would be worse than not checking.
  if (pushedMigrationIds && pushedMigrationIds.size > 0) {
    const stale = findStaleHeldMigrations(stories, pushedMigrationIds);
    if (stale.length > 0) {
      warnings.push(
        stale.length +
          " story(ies) still describe a migration as HELD that is already on origin/main — " +
          "a held migration is by definition unpushed, so these notes tell the next reader the " +
          "branch is frozen when it is not: " +
          stale.map((h) => h.id + " [" + h.migrations.join(",") + "]").join(", "),
      );
    }
  }

  // US-1996 (WARNING): passes:true with an unresolved blocker marker. See
  // findUnresolvedDeferrals — a later note can legitimately supersede an earlier
  // blocker, so this can never be an error.
  // US-1996 AC4, corrected 2026-08-02: scan the ARCHIVE as well as the active
  // backlog. The guard shipped reading only prd.json — and all THREE stories it
  // was written for (US-1770, US-744, US-1399) had already been archived, so it
  // could not see a single one of them. A check that structurally cannot reach
  // its own founding cases reads as green for the wrong reason, which is the
  // exact failure this warning exists to surface, one level up.
  //
  // Cheap enough to be worth it: over the whole archive this flags 2 stories,
  // not a wall. A warning that named hundreds would be ignored, and then the
  // active-backlog half would be ignored with it.
  const deferred = findUnresolvedDeferrals([...stories, ...(archivedStories ?? [])]);
  if (deferred.length > 0) {
    warnings.push(
      `${deferred.length} story(ies) marked passes:true still carry an unresolved blocker note ` +
        `— verify the behaviour actually ships before trusting the flag ` +
        `(US-1770 was closed this way; its gate was later made fail-closed by US-2130): ` +
        deferred.map((d) => `${d.id} "${d.marker}"`).join(", "),
    );
  }

  // Ralph playbook size guard (WARNING — it's read every Ralph iteration)
  if (learningsLines > learningsWarn) {
    warnings.push(`vault/70-agent/ralph-learnings.md is ${learningsLines} lines (> ${learningsWarn}); it is read every Ralph iteration — prune it to keep loop cost down.`);
  }

  return { errors, warnings, ok: errors.length === 0, stats: { active: stories.length, done, maxActive, maxAnywhere } };
}

// ── Impure helpers (CLI) ─────────────────────────────────────────────────────

// Stream the archive and pull ONLY story ids via a regex — never JSON.parse the
// whole 1.6 MB file (CLAUDE.md rule). Returns { maxId, ids }.
export async function probeArchiveIds(archivePath) {
  const ids = new Set();
  let maxId = 0;
  if (!existsSync(archivePath)) return { maxId, ids };
  const rl = createInterface({ input: createReadStream(archivePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    let m;
    ID_FIELD_RE.lastIndex = 0;
    while ((m = ID_FIELD_RE.exec(line)) !== null) {
      ids.add(`US-${m[1]}`);
      const n = Number(m[1]);
      if (n > maxId) maxId = n;
    }
  }
  return { maxId, ids };
}

function countLines(path) {
  if (!existsSync(path)) return 0;
  const txt = readFileSync(path, "utf8");
  if (txt.length === 0) return 0;
  return txt.split("\n").length;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const prdPath = resolve(root, "prd.json");
  const archivePath = resolve(root, "prd.archive.json");
  // US-2061: the playbook moved into the vault. Pointing this at the old path
  // would measure a 4-line REDIRECT STUB against an 800-line threshold — a guard
  // that can never fire, which is worse than no guard because it reads as green.
  const learningsPath = resolve(root, "vault/70-agent/ralph-learnings.md");

  const prd = JSON.parse(readFileSync(prdPath, "utf8"));
  const { maxId: archiveMaxId, ids: archiveIds } = await probeArchiveIds(archivePath);
  // US-1996 AC4: the deferral guard needs the archived stories' NOTES, which the
  // streaming id probe deliberately does not collect. Parsing 1.6 MB costs ~50ms
  // on a lint that runs on demand, and it is the only way the guard can reach the
  // stories it was written for — every one of them is archived. Best-effort: a
  // missing or unparseable archive leaves the guard scanning the active backlog
  // alone rather than failing the lint over a file it only reads for warnings.
  let archivedStories = [];
  try {
    if (existsSync(archivePath)) {
      archivedStories = JSON.parse(readFileSync(archivePath, "utf8")).userStories ?? [];
    }
  } catch {
    archivedStories = [];
  }
  const learningsLines = countLines(learningsPath);

  // Which migrations are already PUSHED? Held means unpushed, so anything on
  // origin/main has had its hold released. Best-effort: no remote, no fetch, or
  // a git failure yields null and the check is skipped rather than guessed.
  let pushedMigrationIds = null;
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      "git",
      ["ls-tree", "--name-only", "origin/main", "supabase/migrations/"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const ids = new Set();
    for (const line of out.split("\n")) {
      const m = /\/(\d{5})_/.exec(line);
      if (m) ids.add(m[1]);
    }
    if (ids.size > 0) pushedMigrationIds = ids;
  } catch {
    pushedMigrationIds = null;
  }

  const { errors, warnings, ok, stats } = lintPrd({
    prd,
    archiveIds,
    archiveMaxId,
    archivedStories,
    learningsLines,
    pushedMigrationIds,
  });

  process.stdout.write(`prd-lint: ${stats.active} active stories, ${stats.done} passes:true, max id ${stats.maxAnywhere}, nextId ${prd.nextId}\n`);
  for (const w of warnings) process.stdout.write(`\n⚠️  ${w}\n`);
  if (errors.length) {
    process.stdout.write(`\n\x1b[31m${errors.length} error(s):\x1b[0m\n`);
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n\x1b[32mprd-lint OK\x1b[0m${warnings.length ? ` (${warnings.length} warning(s))` : ""}\n`);
}

// Entry check. Compare URL to URL: `file://` + a raw argv path is not a valid
// file URL on Windows (backslashes, and a missing third slash before the drive
// letter), so the old comparison was always false there and main() never ran —
// the script exited 0 having done nothing, on every Windows run.
const isEntry = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`prd-lint failed: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
