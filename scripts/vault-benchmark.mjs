#!/usr/bin/env node
// US-2064: measure whether the vault actually made retrieval cheaper and better.
//
// This epic was sold on "fewer tokens, better answers". That is an empirical
// claim about a 200-file corpus, not a certainty, so it gets measured — and the
// story's acceptance criteria explicitly permit a negative result.
//
// METHOD, and its limits stated up front.
//
// We cannot replay an agent session, so we measure a PROXY: the bytes of
// documentation a reader must open to answer a question with confidence.
//
//   PRE  = every file matching the question's search terms in the pre-vault
//          tree. All of them count, because when two files match you must read
//          enough of BOTH to learn which is current — that disambiguation is
//          the duplicate tax this epic set out to remove.
//   POST = INDEX.md (paid once per question, the navigation entry cost) plus
//          the note(s) the index points at.
//
// The same search terms run against both trees. The proxy OVERSTATES both sides
// — a real agent greps and reads excerpts rather than whole files — but it
// overstates them in the same way, so the RATIO is meaningful even though the
// absolute byte counts are not.
//
// It does NOT measure answer correctness. That is judged by hand per task and
// recorded in the note, because several pre-vault answers were confidently
// wrong rather than merely expensive, and no byte count captures that.
//
// Usage: node scripts/vault-benchmark.mjs [--pre <sha>]

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRE_DEFAULT = "25a5c64e"; // parent of US-2048, the first real migration

// Twelve questions an agent actually asks, spread across the domains the epic
// touched. `terms` is what a reasonable agent would grep for — identical on both
// sides. `answer` names where the truth lives now, for the correctness column.
export const TASKS = [
  { id: "deploy-order", domain: "ops", terms: ["deploy order", "migrations.*edge.*frontend"], answer: "vault/10-ops/deploy.md" },
  { id: "rotate-encryption-key", domain: "ops", terms: ["EDGE_ENCRYPTION_KEY"], answer: "vault/10-ops/key-rotation.md" },
  { id: "rounding-lockstep", domain: "grading", terms: ["roundToTenth", "weighted overall"], answer: "vault/20-domain/weighted-overall-lockstep.md" },
  { id: "email-provider", domain: "ops", terms: ["RESEND_API_KEY", "SMTP_HOST"], answer: "vault/10-ops/env-reference.md" },
  { id: "poshmark-why-extension", domain: "decisions", terms: ["Poshmark", "Rithum"], answer: "vault/60-decisions/adr-poshmark-via-extension.md" },
  { id: "ebay-aspect-limit", domain: "platform", terms: ["65 char", "aspect.*too long", "25002"], answer: "vault/30-platform/ebay-aspect-value-limit.md" },
  { id: "flipdesk-pro-price", domain: "pricing", terms: ["FlipDesk.*Pro", "priceMonthlyCents"], answer: "vault/50-business/pricing.md" },
  { id: "add-public-page", domain: "seo", terms: ["PUBLIC_ROUTES", "entry-server"], answer: "vault/40-growth/seo-public-route-registry.md" },
  { id: "ai-crawler-policy", domain: "seo", terms: ["CCBot", "AI_TRAINING_CRAWLERS"], answer: "vault/40-growth/ai-crawler-policy.md" },
  { id: "incident-first-60", domain: "ops", terms: ["first 60 minutes", "SEV-1"], answer: "vault/10-ops/incident-response.md" },
  { id: "handbag-no-rn", domain: "brands", terms: ["RN.*handbag", "Textile Act"], answer: "vault/20-domain/brands/brand-kb-negative-findings.md" },
  { id: "operator-table-rls", domain: "security", terms: ["SERVICE_ROLE_ONLY"], answer: "vault/20-domain/service-role-tables.md" },
];

// Documentation only. Code always had to be read and is unchanged by this epic,
// so counting it would dilute both sides with the same constant.
const DOC = /\.(md)$/i;
const EXCLUDE = /^(node_modules|dist|prd\.json|prd\.archive\.json)/;

function gitGrepFiles(root, ref, term) {
  const r = spawnSync("git", ["grep", "-l", "-i", "-E", term, ref], { cwd: root, encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout.split("\n")
    .map((l) => l.replace(`${ref}:`, "").trim())
    .filter((p) => p && DOC.test(p) && !EXCLUDE.test(p));
}

function fileBytes(root, ref, path) {
  const r = spawnSync("git", ["cat-file", "-s", `${ref}:${path}`], { cwd: root, encoding: "utf8", shell: false });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

export function measure(root, ref, task, { extraAlways = [] } = {}) {
  const hits = new Set();
  for (const t of task.terms) for (const f of gitGrepFiles(root, ref, t)) hits.add(f);
  for (const f of extraAlways) hits.add(f);
  let bytes = 0;
  for (const f of hits) bytes += fileBytes(root, ref, f);
  return { files: hits.size, bytes, paths: [...hits].sort() };
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const preIdx = argv.indexOf("--pre");
  const pre = preIdx >= 0 ? argv[preIdx + 1] : PRE_DEFAULT;
  const post = "HEAD";

  const rows = [];
  for (const task of TASKS) {
    const a = measure(root, pre, task);
    // POST pays the index entry cost once per question, then reads the note(s).
    const b = measure(root, post, task, { extraAlways: ["vault/00-index/INDEX.md"] });
    // The NAVIGATED path — what the vault skill actually instructs: read the
    // index, follow the link, stop. Measured separately because the grep number
    // above answers a different question (see the note on both workflows).
    const nav = { files: 2, bytes: fileBytes(root, post, "vault/00-index/INDEX.md") + fileBytes(root, post, task.answer) };
    rows.push({ task, pre: a, post: b, nav });
  }

  process.stdout.write(`\nvault benchmark — pre ${pre} vs post ${post}\n`);
  process.stdout.write("KB of documentation a reader must open to answer the question.\n\n");
  process.stdout.write(
    "task".padEnd(24) + "pre grep".padStart(10) + "post grep".padStart(11) +
    "navigated".padStart(11) + "nav vs pre".padStart(12) + "\n",
  );
  let preT = 0, postT = 0, navT = 0;
  for (const { task, pre: a, post: b, nav } of rows) {
    preT += a.bytes; postT += b.bytes; navT += nav.bytes;
    const d = a.bytes ? `${Math.round(((nav.bytes - a.bytes) / a.bytes) * 100)}%` : "n/a";
    process.stdout.write(
      task.id.padEnd(24) +
      (a.bytes / 1024).toFixed(1).padStart(10) +
      (b.bytes / 1024).toFixed(1).padStart(11) +
      (nav.bytes / 1024).toFixed(1).padStart(11) +
      d.padStart(12) + "\n",
    );
  }
  const dGrep = preT ? Math.round(((postT - preT) / preT) * 100) : 0;
  const dNav = preT ? Math.round(((navT - preT) / preT) * 100) : 0;
  process.stdout.write("\nTOTAL (KB)\n");
  process.stdout.write(`  pre, blind grep     ${(preT / 1024).toFixed(1).padStart(7)}\n`);
  process.stdout.write(`  post, blind grep    ${(postT / 1024).toFixed(1).padStart(7)}   ${dGrep > 0 ? "+" : ""}${dGrep}%  <- WORSE: the vault ADDED files, so grep hits more\n`);
  process.stdout.write(`  post, NAVIGATED     ${(navT / 1024).toFixed(1).padStart(7)}   ${dNav > 0 ? "+" : ""}${dNav}%  <- index + note, the workflow the skill instructs\n`);
  process.stdout.write("\nCorrectness is NOT measured here — judged by hand per task, see the note.\n");
  return 0;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) process.exit(main());
