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
import { fileURLToPath } from "node:url";

export const ACCUMULATION_THRESHOLD = 50;
export const LEARNINGS_LINE_WARN = 800;
const REQUIRED_FIELDS = ["id", "title", "description", "acceptanceCriteria", "passes"];
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
const CLOSING_TOKEN = /\b(DONE|CLOSED|SHIPPED|COMPLETED?|RESOLVED|VERIFIED|PROD-VERIFIED)\b/;
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

    const laterClosed = segments
      .slice(idx + 1)
      .some((seg) => CLOSING_TOKEN.test(seg) && !NEGATED_CLOSING.test(seg));
    if (laterClosed) continue;
    hits.push({ id: s.id, marker: m[0].trim() });
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

export function lintPrd({ prd, archiveIds = new Set(), archiveMaxId = 0, learningsLines = 0, opts = {} }) {
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
  for (const s of stories) {
    const id = typeof s?.id === "string" ? s.id : "(no id)";
    for (const f of REQUIRED_FIELDS) {
      if (!(f in s) || s[f] === undefined || s[f] === null) errors.push(`${id}: missing required field "${f}"`);
    }
    if ("acceptanceCriteria" in s && !Array.isArray(s.acceptanceCriteria)) errors.push(`${id}: acceptanceCriteria must be an array`);
    if ("passes" in s && typeof s.passes !== "boolean") errors.push(`${id}: passes must be a boolean`);
  }

  // nextId strictly greater than the max id ANYWHERE
  const maxAnywhere = Math.max(maxActive, archiveMaxId);
  if (typeof prd?.nextId !== "number" || !Number.isInteger(prd.nextId)) {
    errors.push("nextId must be an integer");
  } else if (prd.nextId <= maxAnywhere) {
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

  // US-1996 (WARNING): passes:true with an unresolved blocker marker. See
  // findUnresolvedDeferrals — a later note can legitimately supersede an earlier
  // blocker, so this can never be an error.
  const deferred = findUnresolvedDeferrals(stories);
  if (deferred.length > 0) {
    warnings.push(
      `${deferred.length} story(ies) marked passes:true still carry an unresolved blocker note ` +
        `— verify the behaviour actually ships before trusting the flag ` +
        `(US-1770 was closed this way and its authenticity safety gate has no callers): ` +
        deferred.map((d) => `${d.id} "${d.marker}"`).join(", "),
    );
  }

  // LEARNINGS.md size guard (WARNING — it's read every Ralph iteration)
  if (learningsLines > learningsWarn) {
    warnings.push(`scripts/ralph/LEARNINGS.md is ${learningsLines} lines (> ${learningsWarn}); it is read every Ralph iteration — prune it to keep loop cost down.`);
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
  const learningsPath = resolve(root, "scripts/ralph/LEARNINGS.md");

  const prd = JSON.parse(readFileSync(prdPath, "utf8"));
  const { maxId: archiveMaxId, ids: archiveIds } = await probeArchiveIds(archivePath);
  const learningsLines = countLines(learningsPath);

  const { errors, warnings, ok, stats } = lintPrd({ prd, archiveIds, archiveMaxId, learningsLines });

  process.stdout.write(`prd-lint: ${stats.active} active stories, ${stats.done} passes:true, max id ${stats.maxAnywhere}, nextId ${prd.nextId}\n`);
  for (const w of warnings) process.stdout.write(`\n⚠️  ${w}\n`);
  if (errors.length) {
    process.stdout.write(`\n\x1b[31m${errors.length} error(s):\x1b[0m\n`);
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n\x1b[32mprd-lint OK\x1b[0m${warnings.length ? ` (${warnings.length} warning(s))` : ""}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`prd-lint failed: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
