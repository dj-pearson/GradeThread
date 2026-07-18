#!/usr/bin/env node
// US-2043: integrity linter for the knowledge vault (vault/**/*.md).
//
// The vault replaces "203 markdown files and hope" with one navigable surface.
// That only works if three invariants hold, and none of them survive on
// discipline alone:
//
//   1. Every note is SCHEMA-VALID          — so tooling can reason about it.
//   2. Every wikilink RESOLVES             — a dangling link is a dead end, and
//                                            the repo already had 7 files full
//                                            of them before the vault existed.
//   3. Every note is REACHABLE from INDEX  — this is the load-bearing one. There
//                                            is no vector search here by design
//                                            (see vault/60-decisions/adr-0001),
//                                            so a note nothing links to is a
//                                            note an agent will never find. It
//                                            is not "slightly harder to search";
//                                            it is invisible.
//
// The schema itself lives in vault/CONTRACT.md and is documented ONLY there.
// This file enforces it; it does not redefine it.
//
// Usage:
//   node scripts/vault-lint.mjs            # lint, exit 1 on any error
//   node scripts/vault-lint.mjs --fix      # + repair what is mechanically safe
//   node scripts/vault-lint.mjs --quiet    # summary line only
//
// --fix is deliberately timid. It reorders frontmatter keys and stamps a
// MISSING `reviewed` date. It will never invent a summary, never resolve a
// dangling link, and never touch an EXISTING `reviewed` date — bumping that
// date asserts "I re-read the code and this is still true", which no script can
// verify on your behalf. See the re-review section of vault/CONTRACT.md.
//
// Drift detection (code newer than `reviewed`) is US-2044 and lands separately;
// this file is the parser and rule engine it builds on.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NOTE_TYPES = ["runbook", "contract", "reference", "decision", "learning", "moc"];
export const NOTE_STATUSES = ["current", "accepted", "superseded", "archived"];
export const SOURCE_OF_TRUTH = ["code", "vault"];
export const REQUIRED_FIELDS = ["title", "type", "status", "source_of_truth", "code_refs", "reviewed"];
// Canonical frontmatter order, used by --fix. Unknown keys keep their relative
// order and sort after these.
export const FIELD_ORDER = [...REQUIRED_FIELDS, "tags", "summary"];
export const ROOT_NOTE = "INDEX";
export const INDEX_LINE_CAP = 400;

// ── Parsing ─────────────────────────────────────────────────────────────────

// Minimal YAML for the subset CONTRACT.md permits: scalars, inline empty lists,
// inline [a, b] lists, and block "- item" lists. Deliberately not a real YAML
// parser — the schema is small and fixed, and a dependency here would be the
// only one in scripts/.
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { fm: null, body: raw, raw: null };
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (v === "" || v === "[]") fm[key] = [];
      else if (/^\[.*\]$/.test(v)) {
        fm[key] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      } else fm[key] = unquote(v);
      continue;
    }
    const item = line.match(/^[ \t]+-[ \t]+(.*)$/);
    if (item && key) {
      if (!Array.isArray(fm[key])) fm[key] = [];
      fm[key].push(unquote(item[1].trim()));
    }
  }
  return { fm, body: raw.slice(m[0].length), raw: m[1] };
}

function unquote(s) {
  return s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

// Wikilinks inside code are SYNTAX EXAMPLES, not links. vault/CONTRACT.md
// documents the link format, so it necessarily contains [[note|alias]] samples;
// without this the file that defines the format would be the file that fails
// the lint. Fenced blocks first, then inline spans.
export function stripCode(body) {
  return body.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "").replace(/`[^`\n]*`/g, "");
}

// Handles [[note]], [[note|alias]], [[note#heading]] and [[note#heading|alias]].
export function extractWikilinks(body) {
  const out = [];
  for (const m of stripCode(body).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split(/[|#]/)[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// ── Rules ───────────────────────────────────────────────────────────────────

export function validateFrontmatter(fm, { path, today, exists = existsSync }) {
  const errors = [];
  if (!fm) return [`${path}: no frontmatter (see vault/CONTRACT.md)`];

  for (const f of REQUIRED_FIELDS) {
    if (!(f in fm)) errors.push(`${path}: missing required field '${f}'`);
  }
  if (fm.type && !NOTE_TYPES.includes(fm.type)) {
    errors.push(`${path}: type '${fm.type}' is not one of ${NOTE_TYPES.join(", ")}`);
  }
  if (fm.status && !NOTE_STATUSES.includes(fm.status)) {
    errors.push(`${path}: status '${fm.status}' is not one of ${NOTE_STATUSES.join(", ")}`);
  }
  if (fm.source_of_truth && !SOURCE_OF_TRUTH.includes(fm.source_of_truth)) {
    errors.push(`${path}: source_of_truth must be 'code' or 'vault', got '${fm.source_of_truth}'`);
  }
  if ("reviewed" in fm) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fm.reviewed))) {
      errors.push(`${path}: reviewed '${fm.reviewed}' is not an ISO date (YYYY-MM-DD)`);
    } else if (String(fm.reviewed) > today) {
      errors.push(`${path}: reviewed '${fm.reviewed}' is in the future`);
    }
  }
  const refs = Array.isArray(fm.code_refs) ? fm.code_refs : [];
  // A `code` note asserts "the code wins on conflict" — without code_refs there
  // is nothing to compare against, so US-2044's drift guard would silently skip
  // it. That is worse than a note with no claim at all.
  if (fm.source_of_truth === "code" && refs.length === 0) {
    errors.push(`${path}: source_of_truth 'code' requires at least one code_ref to drift-check against`);
  }
  for (const p of refs) {
    if (!exists(p)) errors.push(`${path}: code_ref does not exist -> ${p}`);
  }
  return errors;
}

// Breadth-first from INDEX over resolvable links.
export function reachableFrom(notes, root = ROOT_NOTE) {
  const seen = new Set();
  if (!notes.has(root)) return seen;
  const queue = [root];
  seen.add(root);
  while (queue.length) {
    const note = notes.get(queue.shift());
    for (const target of note.links) {
      if (notes.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

// notes: Map<name, {path, fm, body, links}>
export function lintVault(notes, { today, exists = existsSync, indexLines = 0 } = {}) {
  const errors = [];
  const warnings = [];

  if (!notes.has(ROOT_NOTE)) {
    errors.push(`vault/00-index/${ROOT_NOTE}.md is missing — it is the entry point every note must be reachable from`);
  }

  const byName = new Map();
  for (const [name, n] of notes) {
    errors.push(...validateFrontmatter(n.fm, { path: n.path, today, exists }));
    if (byName.has(name)) {
      errors.push(`${n.path}: duplicate note name '${name}' (also ${byName.get(name)}) — wikilinks would be ambiguous`);
    } else byName.set(name, n.path);
  }

  for (const [, n] of notes) {
    for (const target of n.links) {
      if (!notes.has(target)) errors.push(`${n.path}: dangling wikilink [[${target}]]`);
    }
  }

  const reached = reachableFrom(notes);
  for (const [name, n] of notes) {
    if (!reached.has(name)) {
      errors.push(`${n.path}: ORPHAN — not reachable from ${ROOT_NOTE} by any link path, so no agent will find it`);
    }
  }

  if (indexLines > INDEX_LINE_CAP) {
    errors.push(
      `vault/00-index/${ROOT_NOTE}.md is ${indexLines} lines, over the ${INDEX_LINE_CAP}-line cap. ` +
      `Split into per-folder MOCs — the cap is the retrieval budget, not a style rule.`,
    );
  }

  // Not errors: a stub is transitional, an archived note is meant to be stale.
  for (const [, n] of notes) {
    if (n.fm?.status === "archived" && n.fm?.source_of_truth === "code") {
      warnings.push(`${n.path}: archived note with source_of_truth 'code' — archives are exempt from drift, consider 'vault'`);
    }
    if (!n.fm?.summary) {
      warnings.push(`${n.path}: no summary — the generated index will fall back to the first sentence`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── --fix (mechanically safe repairs only) ──────────────────────────────────

export function canonicalizeFrontmatter(fm) {
  const known = FIELD_ORDER.filter((k) => k in fm);
  const rest = Object.keys(fm).filter((k) => !FIELD_ORDER.includes(k));
  const lines = [];
  for (const k of [...known, ...rest]) {
    const v = fm[k];
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else if (k === "tags") lines.push(`${k}: [${v.join(", ")}]`);
      else lines.push(`${k}:`, ...v.map((item) => `  - ${item}`));
    } else {
      lines.push(/[:#]/.test(String(v)) ? `${k}: "${v}"` : `${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

// Returns {changed, text, applied[]}. Never touches an existing `reviewed`.
export function fixNote(raw, { today }) {
  const { fm, body } = parseFrontmatter(raw);
  if (!fm) return { changed: false, text: raw, applied: [] };
  const applied = [];
  if (!("reviewed" in fm)) {
    fm.reviewed = today;
    applied.push("stamped missing reviewed date");
  }
  if (!("code_refs" in fm)) {
    fm.code_refs = [];
    applied.push("added empty code_refs");
  }
  if (!("tags" in fm)) fm.tags = [];
  const rebuilt = `---\n${canonicalizeFrontmatter(fm)}\n---\n${body}`;
  if (rebuilt !== raw && applied.length === 0) applied.push("reordered frontmatter keys");
  return { changed: rebuilt !== raw, text: rebuilt, applied };
}

// ── Loading ─────────────────────────────────────────────────────────────────

export function loadNotes(root, { glob = globSync, read = readFileSync } = {}) {
  const notes = new Map();
  const files = glob("vault/**/*.md", { cwd: root }).map((f) => String(f).replace(/\\/g, "/"));
  for (const rel of files.sort()) {
    const raw = read(resolve(root, rel), "utf8");
    const { fm, body } = parseFrontmatter(raw);
    notes.set(basename(rel, ".md"), { path: rel, fm, body, links: extractWikilinks(body), raw });
  }
  return notes;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const today = new Date().toISOString().slice(0, 10);
  const quiet = flags.has("--quiet");

  const notes = loadNotes(root);
  if (notes.size === 0) {
    process.stdout.write("  ✗ vault-lint: no notes found under vault/\n");
    return 1;
  }

  if (flags.has("--fix")) {
    for (const [, n] of notes) {
      const { changed, text, applied } = fixNote(n.raw, { today });
      if (changed) {
        writeFileSync(resolve(root, n.path), text, "utf8");
        if (!quiet) process.stdout.write(`  ~ ${n.path}: ${applied.join("; ")}\n`);
      }
    }
    return main(argv.filter((a) => a !== "--fix"));
  }

  const idx = notes.get(ROOT_NOTE);
  const indexLines = idx ? idx.raw.split(/\r?\n/).length : 0;
  const { ok, errors, warnings } = lintVault(notes, { today, indexLines });

  if (!quiet) {
    for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  }
  process.stdout.write(
    ok
      ? `  ✓ vault-lint: ${notes.size} notes, links resolve, no orphans (index ${indexLines}/${INDEX_LINE_CAP} lines)${warnings.length ? `, ${warnings.length} warning(s)` : ""}\n`
      : `  ✗ vault-lint: ${errors.length} error(s) across ${notes.size} notes\n`,
  );
  return ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) process.exit(main());
