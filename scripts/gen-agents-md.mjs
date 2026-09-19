#!/usr/bin/env node
// AGENTS.md is CLAUDE.md, rewritten for a Codex session. Generate it; never
// hand-edit it.
//
// WHY THIS SCRIPT EXISTS. Both files carry the same project knowledge and the
// copy had drifted badly: AGENTS.md was missing whole bullets CLAUDE.md had
// gained, and still told readers the edge deploys from
// `docker-compose.coolify.yml` — which US-2665 measured as false and corrected
// in CLAUDE.md alone. Its own closing note named that line and said there was
// no parity guard between them. A second copy of a fact with nothing holding
// the two together is the failure this repo keeps writing down; the answer is
// one source and a generator, not two files and a habit.
//
// THE SUBSTITUTIONS ARE IDENTITY ONLY, AND THAT DISTINCTION IS THE WHOLE
// DESIGN. A blind s/Claude/Codex/ is what produced the two factual errors the
// previous AGENTS.md shipped with:
//
//   "Claude Vision API (Anthropic)"  ->  "Codex Vision API (Anthropic)"
//   ".claude/skills/grading-engine"  ->  ".Codex/skills/grading-engine"
//
// Neither is a thing. The grading model is Claude whoever is reading the doc,
// and the skills directory is named `.claude/` on disk regardless. So the
// table below rewrites only WHO IS READING — the attribution trailer, the
// agent's own name, its session links — and every product name, API name,
// file path and URL is left exactly as CLAUDE.md wrote it.
//
//   node scripts/gen-agents-md.mjs          # write AGENTS.md
//   node scripts/gen-agents-md.mjs --check  # exit 1 if it is stale

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const SOURCE = "CLAUDE.md";
export const TARGET = "AGENTS.md";

/**
 * Identity rewrites, in order. Each is a literal or an anchored pattern, never
 * a bare /Claude/g — see the header for the two errors that produced.
 */
export const SUBSTITUTIONS = [
  // The attribution block. The trailer name, the session-link key and the
  // PR footer are all about who authored the commit.
  [/Co-Authored-By: Claude <noreply@anthropic\.com>/g, "Co-Authored-By: Codex <noreply@anthropic.com>"],
  [/`Claude-Session:`/g, "`Codex-Session:`"],
  [/🤖 Generated with Claude Code/g, "🤖 Generated with Codex"],
  [/Credit Claude in/g, "Credit Codex in"],
  [/keeps Claude visible/g, "keeps Codex visible"],
  [/no Claude\/AI attribution/g, "no Codex/AI attribution"],
  // The agent's own name, as the product a reader is running. "Claude Code"
  // is always the CLI; "Claude Code on the web" / "a Claude Code web session"
  // are the same product.
  [/\bClaude Code\b/g, "Codex"],
  // What the agent relies on. The PATHS stay `.claude/` because that is their
  // name on disk; only the sentence's subject changes.
  [/Never delete what Claude relies on\./g, "Never delete what Codex relies on."],
  [/Repo `CLAUDE\.md` files/g, "Repo `CLAUDE.md` and `AGENTS.md` files"],
  // The shared vault block names the file it is managed from.
  [/Shared CLAUDE Block\.md/g, "Shared CLAUDE Block.md"],
];

/**
 * Facts that must survive the rewrite verbatim: product names, API names and
 * paths on disk, none of which change because a different agent is reading.
 *
 * CHECKED AGAINST THE SOURCE, not asserted absolutely. Each entry has to be
 * present in CLAUDE.md before its absence from the output means anything --
 * the first version of this list asserted "claude.ai", which CLAUDE.md does
 * not contain, and the check failed on its own first run against a rewrite
 * that was correct. A guard that fires on a fact nobody wrote is a guard
 * somebody switches off.
 */
export const MUST_SURVIVE = [
  "Claude Vision API (Anthropic)",
  ".claude/skills/grading-engine",
  ".claude/skills/migrations",
  ".claude/skills/tenant-isolation",
  "~/.claude",
  "CLAUDE.md",
];

export function renderAgentsMd(source) {
  let out = source;
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  const banner =
    "<!-- GENERATED FROM CLAUDE.md by scripts/gen-agents-md.mjs. Do not hand-edit:\n" +
    "     run `npm run agents:sync` after changing CLAUDE.md. Only the agent's own\n" +
    "     name is rewritten; product names, API names and paths are verbatim. -->\n\n";
  return banner + out;
}

export function checkSurvivors(source, rendered) {
  return MUST_SURVIVE
    .filter((s) => source.includes(s))
    .filter((s) => !rendered.includes(s));
}

function main() {
  const check = process.argv.includes("--check");
  const source = readFileSync(resolve(ROOT, SOURCE), "utf8");
  const rendered = renderAgentsMd(source);

  const missing = checkSurvivors(source, rendered);
  if (missing.length > 0) {
    console.error(
      `[agents-md] a substitution ate a fact that must survive verbatim:\n  ` +
        missing.join("\n  ") +
        `\nNarrow the pattern in SUBSTITUTIONS. A blind s/Claude/Codex/ is what ` +
        `produced "Codex Vision API" and ".Codex/skills/".`,
    );
    process.exit(1);
  }

  const current = (() => {
    try {
      return readFileSync(resolve(ROOT, TARGET), "utf8");
    } catch {
      return null;
    }
  })();

  if (current === rendered) {
    console.log("[agents-md] OK — AGENTS.md is current with CLAUDE.md.");
    return;
  }
  if (check) {
    console.error(
      "[agents-md] AGENTS.md is STALE against CLAUDE.md. Run `npm run agents:sync`.\n" +
        "  Both files carry the same project knowledge for two different agents, " +
        "and the copy drifting is how AGENTS.md spent weeks telling readers the " +
        "edge deploys from docker-compose.coolify.yml after US-2665 measured that false.",
    );
    process.exit(1);
  }
  writeFileSync(resolve(ROOT, TARGET), rendered);
  console.log(`[agents-md] wrote ${TARGET} from ${SOURCE}.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) main();
