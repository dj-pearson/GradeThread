#!/usr/bin/env node
// US-2050 / US-3402: police the `.agents/` agent-skill tree.
//
// Two skills exist twice on purpose:
//   .claude/skills/<name>/   the copy Claude Code actually loads
//   .agents/skills/<name>/   the cross-framework "agent skills" convention
//
// Both were written by the same VENDOR installer in one commit (a8657af9).
// Nothing in this repo reads `.agents/`; they were kept anyway because an agent
// tool OUTSIDE this repo may read that directory, and deleting 40 duplicated
// vendor files to risk silently breaking such a tool is a bad trade.
//
// Neither vendor copy is AUTHORED here: vendor skills are replaced wholesale on
// update. So the risk is not editing-drift, it is updating one tree and
// forgetting the other, leaving two versions of the same instructions with
// nothing to say which is current. This guard is therefore not "one is
// generated from the other", it is "update both or neither, and CI notices".
//
// -- US-3402, 2026-09-11 ----------------------------------------------------
// FIRST-PARTY skills (durable-jobs, grading-engine, migrations,
// tenant-isolation, vault) live ONLY under .claude/skills/. They were mirrored
// into .agents/ by a Codex-onboarding commit (f7d750e8d) and sat there for
// three days while this guard reported them on every run.
//
// Two of the five had already drifted by the time anyone looked:
//   * migrations/SKILL.md was the pre-US-3395 text, still naming
//     apply-prod-migrations.sh as step 1 of the prod-apply runbook and still
//     carrying a warning that US-3395 had just made false.
//   * grading-engine/SKILL.md was missing US-3320's ILLEGIBLE_LABEL_CONFIDENCE_CAP
//     entirely, so the mirror described a grading contract with one fewer
//     confidence cap than the real one.
//
// The copies were deleted. What that fixed is the drift; what it did NOT fix is
// the reason nobody acted on a guard that was already red, so three things
// changed here:
//
//   1. The first-party list is DERIVED from .claude/skills at runtime instead
//      of hard-coded, so a skill added tomorrow is covered without anyone
//      remembering this file exists.
//      A skill added tomorrow is covered on its first commit.
//   2. The whole of `.agents/` is walked. The old check enumerated DIRECTORIES
//      directly under .agents/skills, so three shapes produced zero findings,
//      which reads exactly like a clean tree: a loose file
//      (`.agents/skills/migrations.md`), anything under `.agents/` outside
//      `skills/`, and a first-party file dropped inside a vendor tree. A copy
//      nested one level down (`skills/bundle/migrations/`) WAS reported, but
//      only as an unknown directory name, never as "this is the migrations
//      skill" -- which is the half that tells you a stale contract is in reach.
//   3. Each finding now carries the command that fixes IT. The old summary line
//      told every failure to "copy the newer over the older", which is the right
//      remedy for vendor drift and exactly the wrong one for a first-party
//      mirror: following it would have made a second home permanent.
//
// LINE ENDINGS: the comparison is on LF-normalized bytes. Every blob in both
// trees is LF, and core.autocrlf=true means a Windows checkout gets CRLF, so a
// raw-byte compare is fine today. It stops being fine the moment one side is
// rewritten by a tool that emits LF (which is how .claude/skills/migrations and
// .claude/skills/grading-engine came to sit LF in a CRLF working tree). That
// would fail here and pass in CI while the two files said the same thing, which
// is the false-alarm-on-a-guard-you-need-to-believe failure .gitattributes
// documents five times. A stray \r is reported, but as a WARNING: it is a
// checkout artifact, not a different instruction.
//
// Usage: node scripts/skills-sync.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIRRORED_SKILLS = ["supabase", "supabase-postgres-best-practices"];
export const PRIMARY = ".claude/skills";
export const MIRROR = ".agents/skills";
export const MIRROR_ROOT = ".agents";

export function listFiles(root, dir, out = [], base = dir) {
  let entries;
  try { entries = readdirSync(resolve(root, dir), { withFileTypes: true }); } catch { return null; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) listFiles(root, rel, out, base);
    else out.push(relative(base, rel).replace(/\\/g, "/"));
  }
  return out;
}

/** Directory names directly under `dir`, sorted. `null` if `dir` is absent. */
export function listDirs(root, dir, { readdir = readdirSync } = {}) {
  try {
    return readdir(resolve(root, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * The skills that must have exactly ONE home. Derived from what is actually in
 * .claude/skills so that a skill added later is covered on its first commit,
 * rather than on the day someone remembers to edit a list in this file.
 */
export function firstPartySkills(root, io = {}) {
  return (listDirs(root, PRIMARY, io) ?? []).filter((n) => !MIRRORED_SKILLS.includes(n));
}

/** Drop CR before LF. A \r is a checkout artifact, never a different instruction. */
export function normalizeEol(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

/**
 * Compare one vendor skill across the two trees.
 * Returns { errors, warnings }: content drift is an error, a difference that
 * disappears under LF-normalization is a warning.
 */
export function compareTrees(root, skill, { list = listFiles, read = readFileSync } = {}) {
  const errors = [];
  const warnings = [];
  const a = list(root, `${PRIMARY}/${skill}`);
  const b = list(root, `${MIRROR}/${skill}`);

  if (a === null) return { errors: [`${PRIMARY}/${skill} is missing`], warnings };
  if (b === null) {
    return {
      errors: [`${MIRROR}/${skill} is missing: restore it or drop the skill from MIRRORED_SKILLS`],
      warnings,
    };
  }

  const setA = new Set(a);
  const setB = new Set(b);
  for (const f of a) if (!setB.has(f)) errors.push(`${skill}: only in ${PRIMARY}: ${f}`);
  for (const f of b) if (!setA.has(f)) errors.push(`${skill}: only in ${MIRROR}: ${f}`);

  for (const f of a) {
    if (!setB.has(f)) continue;
    const ba = read(resolve(root, `${PRIMARY}/${skill}/${f}`));
    const bb = read(resolve(root, `${MIRROR}/${skill}/${f}`));
    if (ba.equals(bb)) continue;
    if (normalizeEol(ba).equals(normalizeEol(bb))) {
      warnings.push(
        `${skill}: ${f} differs only in line endings, not content. ` +
          `That is a checkout artifact (core.autocrlf), not drift. Rewrite one ` +
          `side with the other's bytes only if something compares them raw.`,
      );
      continue;
    }
    errors.push(
      `${skill}: content differs: ${f}. ` +
        `Re-run the vendor installer, or copy the newer tree over the older: ` +
        `cp -r ${PRIMARY}/${skill}/. ${MIRROR}/${skill}/`,
    );
  }
  return { errors, warnings };
}

/** Every file under `dir`, relative to it, POSIX separators, sorted. */
export function walkFiles(root, dir, { readdir = readdirSync } = {}) {
  const out = [];
  const rec = (sub) => {
    let entries;
    try { entries = readdir(resolve(root, dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) rec(rel);
      else out.push(rel);
    }
  };
  rec("");
  return out.sort();
}

/**
 * The shortest prefix of `rel` that is NOT allowed under `.agents/`, or null if
 * the whole path is a legitimate vendor-mirror file. Reporting the prefix keeps
 * one finding per offending directory and lets the remedy name a real path.
 */
export function strayRoot(rel) {
  const seg = rel.split("/");
  if (seg[0] !== "skills") return seg[0];
  if (seg.length < 3) return rel; // a loose file directly under skills/
  if (!MIRRORED_SKILLS.includes(seg[1])) return `skills/${seg[1]}`;
  return null;
}

/**
 * Everything under `.agents/` that is not part of a vendor mirror tree.
 * Walks the whole root. The previous version enumerated DIRECTORIES directly
 * under `.agents/skills`, so a loose file sitting beside the vendor trees, or
 * anything under `.agents/` outside `skills/`, produced no finding at all,
 * which reads exactly like a clean tree.
 */
export function auditMirrorRoot(root, { walk = walkFiles, firstParty = null, ...io } = {}) {
  const owned = firstParty ?? firstPartySkills(root, io);
  const errors = [];
  const strays = new Map(); // stray root -> { count, skill }

  for (const rel of walk(root, MIRROR_ROOT, io)) {
    const key = strayRoot(rel);
    if (key === null) continue;
    const cur = strays.get(key) ?? { count: 0, skill: null };
    cur.count += 1;
    cur.skill ??= rel.split("/").find((s) => owned.includes(s)) ?? null;
    strays.set(key, cur);
  }

  for (const [key, { count, skill }] of [...strays.entries()].sort()) {
    if (skill) {
      errors.push(
        `${MIRROR_ROOT}/${key} holds a copy of the first-party skill "${skill}" (${count} file(s)). ` +
          `First-party skills live ONLY in ${PRIMARY}: nothing reads ${MIRROR_ROOT}/, and a ` +
          `second copy rots (US-3402 found two of five already stale). ` +
          `Delete it: rm -rf ${MIRROR_ROOT}/${key}`,
      );
    } else {
      errors.push(
        `${MIRROR_ROOT}/${key} is not part of a vendor mirror (${count} file(s)). ` +
          `${MIRROR_ROOT}/ may contain nothing but ${MIRRORED_SKILLS.map((s) => `skills/${s}/`).join(" and ")}. ` +
          `Delete it, or add the skill to MIRRORED_SKILLS if a vendor installer owns it.`,
      );
    }
  }
  return errors;
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = [];
  const warnings = [];
  let files = 0;
  for (const skill of MIRRORED_SKILLS) {
    const r = compareTrees(root, skill);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    files += (listFiles(root, `${PRIMARY}/${skill}`) ?? []).length;
  }
  errors.push(...auditMirrorRoot(root));

  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  for (const e of errors) process.stdout.write(`  x ${e}\n`);
  process.stdout.write(
    errors.length
      ? `  x skills-sync: ${errors.length} problem(s). Each line above names the command that fixes it.\n`
      : `  + skills-sync: ${MIRRORED_SKILLS.length} vendor skills identical across ${PRIMARY} and ${MIRROR} ` +
        `(${files} files), and ${MIRROR_ROOT}/ holds nothing else.\n`,
  );
  return errors.length ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) process.exit(main());
