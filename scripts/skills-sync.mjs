#!/usr/bin/env node
// US-2050: keep the duplicated VENDOR skill trees byte-identical.
//
// The two Supabase skills exist twice:
//   .claude/skills/<name>/   — read by Claude Code
//   .agents/skills/<name>/   — the cross-framework "agent skills" convention
//
// Both were written by the same vendor installer in one commit (a8657af9), and
// nothing in this repo reads `.agents/`. They were left in place deliberately:
// an agent tool OUTSIDE this repo may read that directory, and deleting 40
// duplicated vendor files to risk silently breaking such a tool is a bad trade.
//
// Neither copy is AUTHORED here — vendor skills are replaced wholesale on
// update. So the risk is not editing-drift, it is updating one tree and
// forgetting the other, leaving two different versions of the same instructions
// with nothing to say which is current. That is the same failure the knowledge
// vault exists to remove, in the agent-instruction layer.
//
// This guard is therefore not "one is generated from the other" — it is
// "update both or neither, and CI notices". Fix a failure by re-running the
// vendor installer, or copying the newer tree over the older one.
//
// The FIRST-PARTY skills (durable-jobs, grading-engine, migrations,
// tenant-isolation, vault) live only under .claude/skills/ and are NOT mirrored.
// Do not add them here: one home is the correct number.
//
// Usage: node scripts/skills-sync.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIRRORED_SKILLS = ["supabase", "supabase-postgres-best-practices"];
export const PRIMARY = ".claude/skills";
export const MIRROR = ".agents/skills";

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

export function compareTrees(root, skill, { list = listFiles, read = readFileSync } = {}) {
  const errors = [];
  const a = list(root, `${PRIMARY}/${skill}`);
  const b = list(root, `${MIRROR}/${skill}`);

  if (a === null) return [`${PRIMARY}/${skill} is missing`];
  if (b === null) return [`${MIRROR}/${skill} is missing — restore it or drop the skill from MIRRORED_SKILLS`];

  const setA = new Set(a);
  const setB = new Set(b);
  for (const f of a) if (!setB.has(f)) errors.push(`${skill}: only in ${PRIMARY} — ${f}`);
  for (const f of b) if (!setA.has(f)) errors.push(`${skill}: only in ${MIRROR} — ${f}`);

  for (const f of a) {
    if (!setB.has(f)) continue;
    const ba = read(resolve(root, `${PRIMARY}/${skill}/${f}`));
    const bb = read(resolve(root, `${MIRROR}/${skill}/${f}`));
    if (!ba.equals(bb)) errors.push(`${skill}: content differs — ${f}`);
  }
  return errors;
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = [];
  let files = 0;
  for (const skill of MIRRORED_SKILLS) {
    errors.push(...compareTrees(root, skill));
    files += (listFiles(root, `${PRIMARY}/${skill}`) ?? []).length;
  }

  // A first-party skill appearing in the mirror means someone mirrored
  // something that should have exactly one home.
  let mirrored;
  try { mirrored = readdirSync(resolve(root, MIRROR), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { mirrored = []; }
  for (const name of mirrored) {
    if (!MIRRORED_SKILLS.includes(name)) {
      errors.push(`${MIRROR}/${name} is not a known vendor skill. First-party skills belong only in ${PRIMARY}.`);
    }
  }

  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  process.stdout.write(
    errors.length
      ? `  ✗ skills-sync: ${errors.length} difference(s). Update BOTH trees (re-run the vendor installer, or copy the newer over the older).\n`
      : `  ✓ skills-sync: ${MIRRORED_SKILLS.length} vendor skills identical across ${PRIMARY} and ${MIRROR} (${files} files)\n`,
  );
  return errors.length ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) process.exit(main());
