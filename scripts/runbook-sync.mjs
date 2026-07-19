#!/usr/bin/env node
// US-2076: guard the SHIPPED copies of ops knowledge against their vault sources.
//
// Ops knowledge exists in four places (vault/10-ops/runbook-copies.md). Two of
// them are TypeScript that ships to users and that no markdown edit reaches:
//
//   src/lib/admin/runbooks.ts                       — in-app runbooks (US-910),
//                                                     read by on-call DURING an
//                                                     incident, deep-linked to
//                                                     the admin controls
//   services/edge-functions/src/lib/integrations-watchdog.ts
//                                                   — KEY_ROTATION_REGISTRY, the
//                                                     rotation schedule as data
//
// Neither is a bug. Putting the playbook where the controls are is the whole
// point of US-910, and the watchdog needs the cadences as data to compute what
// is overdue. Both are deliberately DISTILLED — shorter, reordered, and in the
// watchdog's case restructured entirely — so generating them from the vault
// would either dump a full runbook into a UI that needs six steps, or require
// an "in-app excerpt" field in every note, which is a second copy wearing a
// costume. Two of the seven in-app runbooks (cron-jobs, kill-switches) have no
// vault counterpart at all, so generation is partial by construction.
//
// So: keep them hand-written, and guard them. Each declares the vault note it
// was distilled from and when someone last checked the two still agree; this
// fails when the note has a commit newer than that date.
//
// WHAT THIS CANNOT DO, stated plainly: it detects that the SOURCE MOVED, not
// that the distilled text is now wrong. Same heuristic as the vault's own drift
// guard, accepted for the same reason — a cheap signal that something needs a
// human eye beats no signal, and the alternative (semantic comparison) is not
// available. Bumping `reviewed` asserts a human re-read both. Doing it to
// silence this script is the one failure mode no automation here can catch.
//
// Usage: node scripts/runbook-sync.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNBOOKS_FILE = "src/lib/admin/runbooks.ts";
export const WATCHDOG_FILE = "services/edge-functions/src/lib/integrations-watchdog.ts";

// Pulls { slug, sourceNote, reviewed } out of the RUNBOOKS array. A regex rather
// than an import because this is a .mjs script and the target is TypeScript with
// JSX-free but TS-only syntax; parsing the two fields we need is cheaper and has
// no build step.
export function parseRunbookSources(src) {
  const out = [];
  const re = /slug:\s*"([^"]+)"(?:[\s\S]{0,400}?sourceNote:\s*"([^"]+)")?(?:[\s\S]{0,200}?reviewed:\s*"([^"]+)")?/g;
  for (const m of src.matchAll(re)) {
    // Only treat sourceNote/reviewed as this entry's if they appear before the
    // NEXT slug — otherwise a tagged runbook lends its fields to an untagged one.
    const chunk = src.slice(m.index, src.indexOf('slug: "', m.index + 10) === -1
      ? src.length
      : src.indexOf('slug: "', m.index + 10));
    const note = /sourceNote:\s*"([^"]+)"/.exec(chunk);
    const reviewed = /reviewed:\s*"([^"]+)"/.exec(chunk);
    out.push({ slug: m[1], sourceNote: note?.[1] ?? null, reviewed: reviewed?.[1] ?? null });
  }
  return out;
}

export function checkPairs(pairs, { commitTime, exists }) {
  const errors = [];
  const warnings = [];
  for (const p of pairs) {
    if (!p.sourceNote) {
      warnings.push(`${p.slug}: no sourceNote — untracked against the vault (fine if it has no counterpart)`);
      continue;
    }
    if (!exists(p.sourceNote)) {
      errors.push(`${p.slug}: sourceNote does not exist -> ${p.sourceNote}`);
      continue;
    }
    if (!p.reviewed || !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewed)) {
      errors.push(`${p.slug}: sourceNote is set but reviewed is missing or malformed`);
      continue;
    }
    const iso = commitTime(p.sourceNote);
    if (!iso) continue;
    const day = iso.slice(0, 10);
    if (day > p.reviewed) {
      errors.push(
        `${p.slug}: SHIPPED COPY MAY BE STALE — ${p.sourceNote} changed ${day}, this distillation last checked ${p.reviewed}. ` +
        `Operators read this copy during an incident. Re-read both, then bump 'reviewed'.`,
      );
    }
  }
  return { errors, warnings };
}

function gitCommitTime(root) {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const r = spawnSync("git", ["log", "-1", "--format=%cI", "--", rel], { cwd: root, encoding: "utf8", shell: false });
    const val = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    cache.set(rel, val);
    return val;
  };
}

function isShallow(root) {
  const r = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8", shell: false });
  return r.status === 0 && r.stdout.trim() === "true";
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pairs = parseRunbookSources(readFileSync(resolve(root, RUNBOOKS_FILE), "utf8"));

  // The watchdog registry is one block derived from one note, so it carries a
  // single module-level pair rather than per-entry ones.
  const wd = readFileSync(resolve(root, WATCHDOG_FILE), "utf8");
  const wdNote = /@sourceNote\s+(\S+)/.exec(wd)?.[1] ?? null;
  const wdReviewed = /@reviewed\s+(\d{4}-\d{2}-\d{2})/.exec(wd)?.[1] ?? null;
  pairs.push({ slug: "KEY_ROTATION_REGISTRY", sourceNote: wdNote, reviewed: wdReviewed });

  if (isShallow(root)) {
    process.stdout.write("  ! runbook-sync: shallow clone — staleness check skipped (use fetch-depth: 0)\n");
    return 0;
  }

  const { errors, warnings } = checkPairs(pairs, {
    commitTime: gitCommitTime(root),
    exists: (p) => existsSync(resolve(root, p)),
  });

  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  const tracked = pairs.filter((p) => p.sourceNote).length;
  process.stdout.write(
    errors.length
      ? `  ✗ runbook-sync: ${errors.length} shipped copy/copies may be stale\n`
      : `  ✓ runbook-sync: ${tracked} shipped copies tracked against their vault notes${warnings.length ? `, ${warnings.length} untracked` : ""}\n`,
  );
  return errors.length ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) process.exit(main());
