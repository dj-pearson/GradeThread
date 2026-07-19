#!/usr/bin/env node
// US-2047: the canonical way to move a document into the vault.
//
// Every Phase 3 migration story (US-2051 → US-2057) goes through this one tool,
// so ~78 file moves are mechanical and reversible instead of 78 hand-edits with
// 78 chances to forget a reference.
//
// A move is four things, and doing only the first is how a "consolidation" ends
// up making things worse:
//
//   1. git mv     — so history follows the content instead of appearing to be a
//                   delete plus an unrelated new file.
//   2. frontmatter — injected on arrival; a note without it fails vault-lint.
//   3. a stub     — left at the old path so existing links do not 404.
//   4. references — rewritten repo-wide, and REPORTED where they cannot be.
//
// Step 4 is the one that matters most. The repo already contains dangling
// [[US-716]]-style links from an earlier reorganisation that skipped it.
//
// Stubs are strictly pointers. A stub containing prose is a second source of
// truth, which is the exact disease this epic treats — so the stub body is
// generated, never authored, and vault-lint caps it at 5 lines.
//
// Usage:
//   node scripts/vault-move.mjs <source.md> <vault/NN-folder/note.md> [options]
//
//   --dry-run          print the full plan, touch nothing
//   --type <t>         runbook|contract|reference|decision|learning|moc
//   --sot <code|vault> source_of_truth (default: vault)
//   --code-ref <path>  repeatable; required when --sot code
//   --title <t>        default: first H1, else the filename
//   --summary <s>      default: first prose sentence
//   --tags a,b,c
//   --no-stub          move without a stub (only when nothing can reference it)
//   --absorb <path>    repeatable. A second document MERGED into this same note:
//                      it is deleted and stubbed to the note, but not moved. Use
//                      when two files covered one topic (US-2048's env pair,
//                      US-2049's three doubled runbooks). Absorbed content must
//                      be grafted into the note by hand FIRST — the tool cannot
//                      know which copy is right, and guessing would launder a
//                      contradiction into a confident answer.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STUBS_PATH = "vault/00-index/STUBS.md";
export const STUB_MAX_LINES = 5;
// Opt-out marker: a file containing this is never reference-rewritten.
export const NO_REWRITE_MARKER = "vault-move:no-rewrite";

// ── Derivation ──────────────────────────────────────────────────────────────

export function deriveTitle(body, fallbackPath) {
  const h1 = body.split(/\r?\n/).find((l) => /^#\s+\S/.test(l));
  if (h1) return h1.replace(/^#\s+/, "").trim();
  return basename(fallbackPath, ".md").replace(/[-_]/g, " ");
}

export function deriveSummary(body) {
  const prose = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^[#>|\-*`]/.test(l) && !/^\d+\./.test(l));
  if (!prose) return "";
  return prose.split(/(?<=\.)\s/)[0].replace(/[[\]]/g, "").trim();
}

export function buildFrontmatter({ title, type, status, sot, codeRefs, reviewed, tags, summary }) {
  const lines = ["---", `title: ${/[:#]/.test(title) ? `"${title}"` : title}`, `type: ${type}`, `status: ${status}`, `source_of_truth: ${sot}`];
  if (codeRefs.length) lines.push("code_refs:", ...codeRefs.map((r) => `  - ${r}`));
  else lines.push("code_refs: []");
  lines.push(`reviewed: ${reviewed}`);
  lines.push(`tags: [${tags.join(", ")}]`);
  if (summary) lines.push(`summary: ${/[:#]/.test(summary) ? `"${summary}"` : summary}`);
  lines.push("---", "");
  return lines.join("\n");
}

// Generated, never authored — see the header note on second sources of truth.
export function makeStub(noteName, vaultPath, date) {
  return [
    `Moved to [[${noteName}]] — \`${vaultPath}\``,
    "",
    `_Redirect stub (${date}, US-2047). Delete once nothing references this path; tracked in \`${STUBS_PATH}\`._`,
    "",
  ].join("\n");
}

// ── Reference rewriting ─────────────────────────────────────────────────────

// Deliberately conservative. Rewrites the two forms that are unambiguously a
// path reference — a markdown link target and an inline-code path — and reports
// everything else rather than guessing. A regex loose enough to catch every
// prose mention is also loose enough to corrupt unrelated text across 200 files,
// and a bad rewrite is much harder to notice than a missed one.
export function rewriteRefs(text, oldPath, newPath) {
  let count = 0;
  const esc = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Link TEXT very often repeats the path — `[docs/X.md](docs/X.md)`. Rewriting
  // only the target leaves a link whose visible label names a file that no
  // longer exists, which reads as a broken doc even though the link works.
  let out = text.replace(new RegExp(`\\[\\.?/?${esc}\\]\\(\\.?/?${esc}\\)`, "g"), () => {
    count++;
    return `[${newPath}](${newPath})`;
  });
  out = out.replace(new RegExp(`\\]\\(\\.?/?${esc}\\)`, "g"), () => {
    count++;
    return `](${newPath})`;
  });
  out = out.replace(new RegExp("`\\.?/?" + esc + "`", "g"), () => {
    count++;
    return `\`${newPath}\``;
  });
  return { text: out, count };
}

// Mentions we did NOT rewrite, so a human can judge them.
export function findResidualMentions(text, oldPath, newPath) {
  const esc = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!new RegExp(esc).test(line)) continue;
    if (line.includes(newPath)) continue; // already rewritten on this line
    out.push(line.trim());
  }
  return out;
}

// ── Stub registry ───────────────────────────────────────────────────────────

export function parseStubRegistry(md) {
  const rows = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*\[\[([^\]]+)\]\]\s*\|\s*([\d-]+)\s*\|/);
    if (m) rows.push({ oldPath: m[1], note: m[2], created: m[3] });
  }
  return rows;
}

export function renderStubRegistry(rows) {
  const sorted = [...rows].sort((a, b) => a.oldPath.localeCompare(b.oldPath));
  return [
    "| Old path | Note | Created |",
    "|---|---|---|",
    ...sorted.map((r) => `| \`${r.oldPath}\` | [[${r.note}]] | ${r.created} |`),
  ].join("\n");
}

export function upsertStubRow(rows, row) {
  const next = rows.filter((r) => r.oldPath !== row.oldPath);
  next.push(row);
  return next;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export function planMove(root, source, dest, opts, { read = readFileSync, glob = globSync } = {}) {
  const srcAbs = resolve(root, source);
  if (!existsSync(srcAbs)) throw new Error(`source does not exist: ${source}`);
  if (!dest.startsWith("vault/")) throw new Error(`destination must be under vault/: ${dest}`);
  if (existsSync(resolve(root, dest))) throw new Error(`destination already exists: ${dest}`);
  if (opts.sot === "code" && opts.codeRefs.length === 0) {
    throw new Error("--sot code requires at least one --code-ref (the drift guard has nothing to watch otherwise)");
  }

  const raw = read(srcAbs, "utf8");
  const noteName = basename(dest, ".md");
  const frontmatter = buildFrontmatter({
    title: opts.title ?? deriveTitle(raw, source),
    type: opts.type,
    status: opts.status,
    sot: opts.sot,
    codeRefs: opts.codeRefs,
    reviewed: opts.reviewed,
    tags: opts.tags,
    summary: opts.summary ?? deriveSummary(raw),
  });

  // Scan every tracked text file for references to the old path.
  //
  // `**` does NOT match dot-directories in Node's glob, so .github/ (workflows,
  // security docs) and .claude/ (the skills that instruct agents where to read)
  // are invisible to a plain `**` pass. They are exactly the files whose stale
  // paths cost the most, so they get their own explicit patterns.
  const patterns = [
    "**/*.{md,mjs,js,ts,tsx,json,yml,yaml}",
    ".github/**/*.{md,yml,yaml}",
    ".claude/**/*.{md,json}",
    ".agents/**/*.{md,json}",
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const f of glob(pattern, {
      cwd: root,
      exclude: (p) => /node_modules|[\\/]dist[\\/]|\.git[\\/]/.test(String(p)),
    })) seen.add(String(f).replace(/\\/g, "/"));
  }
  const candidates = [...seen];

  // Absorbed documents are replaced by a stub pointing at THIS note, so
  // references to them must be rewritten exactly as references to the source
  // are. Missing this leaves live links aimed at a stub — technically working,
  // but it defeats the point of the sweep in US-2065 and hides the real target.
  const oldPaths = [source, ...opts.absorb];

  const rewrites = [];
  const residual = [];
  for (const rel of candidates) {
    if (rel === dest || oldPaths.includes(rel)) continue;
    let text;
    try { text = read(resolve(root, rel), "utf8"); } catch { continue; }
    // Some documents record paths as HISTORICAL FACTS — an ADR's Context
    // section describes the repo as it was, so "updating" it makes the file
    // claim the past contained files at their present paths. That happened
    // twice to adr-0001 before this opt-out existed. The tool cannot tell a
    // live reference from a historical one, so the file says which it is.
    if (text.includes(NO_REWRITE_MARKER)) continue;
    if (!oldPaths.some((p) => text.includes(p))) continue;
    let count = 0;
    const left = [];
    for (const old of oldPaths) {
      if (!text.includes(old)) continue;
      const r = rewriteRefs(text, old, dest);
      text = r.text;
      count += r.count;
      left.push(...findResidualMentions(text, old, dest));
    }
    if (count > 0) rewrites.push({ path: rel, count, text });
    if (left.length) residual.push({ path: rel, lines: left });
  }

  return { source, dest, noteName, frontmatter, body: raw, rewrites, residual };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const opts = {
    type: "reference", status: "current", sot: "vault", codeRefs: [], tags: [], absorb: [],
    reviewed: new Date().toISOString().slice(0, 10), dryRun: false, stub: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-stub") opts.stub = false;
    else if (a === "--type") opts.type = argv[++i];
    else if (a === "--status") opts.status = argv[++i];
    else if (a === "--sot") opts.sot = argv[++i];
    else if (a === "--code-ref") opts.codeRefs.push(argv[++i]);
    else if (a === "--title") opts.title = argv[++i];
    else if (a === "--summary") opts.summary = argv[++i];
    else if (a === "--tags") opts.tags = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--absorb") opts.absorb.push(argv[++i]);
    else positional.push(a);
  }
  return { positional, opts };
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { positional, opts } = parseArgs(argv);
  if (positional.length !== 2) {
    process.stdout.write("usage: vault-move.mjs <source.md> <vault/NN-folder/note.md> [--dry-run] [--type t] [--sot code|vault] [--code-ref p]...\n");
    return 2;
  }
  const [source, dest] = positional;

  let plan;
  try {
    plan = planMove(root, source, dest, opts);
  } catch (err) {
    process.stdout.write(`  ✗ vault-move: ${err.message}\n`);
    return 1;
  }

  const totalRefs = plan.rewrites.reduce((n, r) => n + r.count, 0);
  process.stdout.write(`\n${opts.dryRun ? "PLAN (dry run)" : "MOVE"}: ${source} -> ${dest}\n`);
  process.stdout.write(`  note name : [[${plan.noteName}]]\n`);
  process.stdout.write(`  frontmatter:\n${plan.frontmatter.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
  process.stdout.write(`  stub      : ${opts.stub ? `left at ${source}` : "NONE (--no-stub)"}\n`);
  process.stdout.write(`  references: ${totalRefs} rewrite(s) across ${plan.rewrites.length} file(s)\n`);
  for (const r of plan.rewrites) process.stdout.write(`      ${r.path} (${r.count})\n`);
  if (plan.residual.length) {
    process.stdout.write(`  ! ${plan.residual.length} file(s) mention the old path in a form NOT auto-rewritten — review each:\n`);
    for (const r of plan.residual) {
      for (const l of r.lines.slice(0, 3)) process.stdout.write(`      ${r.path}: ${l.slice(0, 100)}\n`);
    }
  }

  if (opts.dryRun) {
    process.stdout.write("\n  (dry run — nothing written)\n");
    return 0;
  }

  // 1. git mv, so history follows the file.
  mkdirSync(dirname(resolve(root, dest)), { recursive: true });
  const mv = spawnSync("git", ["mv", source, dest], { cwd: root, encoding: "utf8", shell: false });
  if (mv.status !== 0) {
    process.stdout.write(`  ✗ vault-move: git mv failed: ${mv.stderr}\n`);
    return 1;
  }

  // 2. frontmatter on arrival.
  writeFileSync(resolve(root, dest), plan.frontmatter + plan.body, "utf8");

  // 3. stub at the old path.
  if (opts.stub) {
    writeFileSync(resolve(root, source), makeStub(plan.noteName, dest, opts.reviewed), "utf8");
    const stubsAbs = resolve(root, STUBS_PATH);
    const md = readFileSync(stubsAbs, "utf8");
    const rows = upsertStubRow(parseStubRegistry(md), { oldPath: source, note: plan.noteName, created: opts.reviewed });
    const s = md.indexOf("<!-- stubs:start -->");
    const e = md.indexOf("<!-- stubs:end -->");
    if (s === -1 || e === -1) {
      process.stdout.write(`  ✗ vault-move: ${STUBS_PATH} is missing its <!-- stubs:start/end --> markers\n`);
      return 1;
    }
    writeFileSync(stubsAbs, md.slice(0, s + "<!-- stubs:start -->".length) + "\n\n" + renderStubRegistry(rows) + "\n\n" + md.slice(e), "utf8");
  }

  // 3b. absorbed documents: replaced by a stub to the SAME note, not moved.
  for (const other of opts.absorb) {
    const otherAbs = resolve(root, other);
    if (!existsSync(otherAbs)) {
      process.stdout.write(`  ✗ vault-move: --absorb target does not exist: ${other}\n`);
      return 1;
    }
    const rm = spawnSync("git", ["rm", "-q", "--cached", other], { cwd: root, encoding: "utf8", shell: false });
    if (rm.status !== 0) process.stdout.write(`  ! could not un-track ${other}: ${rm.stderr.trim()}\n`);
    writeFileSync(otherAbs, makeStub(plan.noteName, dest, opts.reviewed), "utf8");
    const stubsAbs = resolve(root, STUBS_PATH);
    const md = readFileSync(stubsAbs, "utf8");
    const rows = upsertStubRow(parseStubRegistry(md), { oldPath: other, note: plan.noteName, created: opts.reviewed });
    const s2 = md.indexOf("<!-- stubs:start -->");
    const e2 = md.indexOf("<!-- stubs:end -->");
    writeFileSync(stubsAbs, md.slice(0, s2 + "<!-- stubs:start -->".length) + "\n\n" + renderStubRegistry(rows) + "\n\n" + md.slice(e2), "utf8");
    process.stdout.write(`  absorbed  : ${other} -> stub pointing at [[${plan.noteName}]]\n`);
  }

  // 4. references.
  for (const r of plan.rewrites) writeFileSync(resolve(root, r.path), r.text, "utf8");

  process.stdout.write(`\n  ✓ vault-move: moved, stubbed, ${totalRefs} reference(s) rewritten.\n`);
  process.stdout.write("    Next: npm run vault:index && npm run vault:lint\n");
  if (plan.residual.length) process.stdout.write("    Review the residual mentions listed above by hand.\n");
  return 0;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) process.exit(main());
