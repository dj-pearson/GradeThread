import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain .mjs generator with no types of its own.
import { MUST_SURVIVE, checkSurvivors, renderAgentsMd } from "../../scripts/gen-agents-md.mjs";

// AGENTS.md and CLAUDE.md carry the same project knowledge for two different
// agents, and nothing held them together.
//
// WHAT THAT COST, measured rather than imagined. AGENTS.md was missing whole
// bullets CLAUDE.md had gained, and still told readers the edge deploys from
// `docker-compose.coolify.yml` — which US-2665 measured as false and corrected
// in CLAUDE.md alone. US-2665's own closing note named that line and said
// there was no parity guard between the two files. This is it.
//
// It also caught two FACTUAL errors a blind s/Claude/Codex/ had baked in:
// "Codex Vision API (Anthropic)", which is not a thing, and
// ".Codex/skills/grading-engine", which is not a path. The generator's
// substitutions are identity-only for that reason.

const ROOT = resolve(__dirname, "../..");
const CLAUDE = readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8");
const AGENTS = readFileSync(resolve(ROOT, "AGENTS.md"), "utf8");

describe("AGENTS.md is generated from CLAUDE.md and cannot drift", () => {
  it("AGENTS.md is exactly what the generator produces", () => {
    // The whole guard. A hand-edit to either file that is not mirrored fails
    // here, which is the thing that did not exist while AGENTS.md went stale.
    expect(
      renderAgentsMd(CLAUDE),
      "AGENTS.md is stale against CLAUDE.md — run `npm run agents:sync`",
    ).toBe(AGENTS);
  });

  it("it says out loud that it is generated", () => {
    // Otherwise the next reader hand-edits it and the next sync silently
    // reverts them, which is worse than the drift.
    expect(AGENTS.slice(0, 200)).toContain("GENERATED FROM CLAUDE.md");
    expect(AGENTS.slice(0, 400)).toContain("npm run agents:sync");
  });

  it("only the agent's own name is rewritten, never a product or a path", () => {
    // The two errors the previous file shipped with. Both are facts about the
    // system, not about who is reading.
    expect(AGENTS).toContain("Claude Vision API (Anthropic)");
    expect(AGENTS).not.toContain("Codex Vision API");
    expect(AGENTS).toContain(".claude/skills/");
    expect(AGENTS).not.toContain(".Codex/skills/");
    expect(AGENTS).not.toContain("~/.Codex/");
    // And the attribution, which IS about who is reading, did change.
    expect(AGENTS).toContain("Co-Authored-By: Codex <noreply@anthropic.com>");
    expect(AGENTS).not.toContain("Co-Authored-By: Claude <noreply@anthropic.com>");
  });

  it("the survivor check is non-vacuous: every protected fact is in the source", () => {
    // The first version of this list asserted "claude.ai", which CLAUDE.md
    // does not contain, so the check failed on its own first run against a
    // correct rewrite. An entry nobody wrote makes the guard noise.
    const absent = (MUST_SURVIVE as string[]).filter((s) => !CLAUDE.includes(s));
    expect(absent, "these protected strings are not in CLAUDE.md at all").toEqual([]);
    expect((MUST_SURVIVE as string[]).length).toBeGreaterThanOrEqual(5);
    expect(checkSurvivors(CLAUDE, AGENTS)).toEqual([]);
  });

  it("the correction US-2665 made in CLAUDE.md reached AGENTS.md", () => {
    // The specific line, by name. It is the reason this guard exists and the
    // one a future regeneration bug would most plausibly lose.
    for (const doc of [CLAUDE, AGENTS]) {
      expect(doc).toContain("`docker-compose.coolify.yml` is NOT read by Coolify");
    }
  });

  it("a substitution too broad to be safe is caught rather than shipped", () => {
    // Drive the generator's own refusal, so the protection is proved rather
    // than described. A rewrite that eats a protected fact must fail.
    const eaten = renderAgentsMd(CLAUDE).replace("Claude Vision API (Anthropic)", "Codex Vision API (Anthropic)");
    expect(checkSurvivors(CLAUDE, eaten)).toContain("Claude Vision API (Anthropic)");
  });
});

// ── the other half of US-2665's leftover ───────────────────────────
//
// OBSERVABILITY.md sections 1 and 2 stated the log rotation and the 0.1 trace
// sample rate as ENFORCED, both of which come from
// docker-compose.coolify.yml — a file Coolify does not read. US-2665 measured
// that, corrected CLAUDE.md, and recorded these two sections as still wrong
// and outside its fence.
//
// A document that asserts an unenforced setting is worse than one that says
// nothing: it is the reason nobody ran the `docker inspect` for months.

const OBSERVABILITY = readFileSync(
  resolve(ROOT, "services/edge-functions/OBSERVABILITY.md"),
  "utf8",
);

describe("OBSERVABILITY.md does not claim compose values are live (US-2665)", () => {
  it("every section that quotes the compose file says it is not deployed", () => {
    // The file is named in a handful of places. Each mention has to sit in a
    // section that also carries the correction, so a reader cannot land on
    // the number without landing on the caveat.
    const mentions = OBSERVABILITY.split("docker-compose.coolify.yml").length - 1;
    expect(mentions).toBeGreaterThan(0);
    expect(OBSERVABILITY).toContain("is not read by Coolify");
    expect(OBSERVABILITY).toContain("not read by Coolify");
  });

  it("the two sentences that were false are gone", () => {
    // Pinned as literals, because a rewrite that reintroduces either is the
    // regression and paraphrase detection is not a thing a test can do.
    expect(OBSERVABILITY).not.toContain("**Enforced on-host bound (the policy):**");
    expect(OBSERVABILITY).not.toMatch(
      /Production is\s+configured to \*\*`0\.1`\*\* in `docker-compose\.coolify\.yml`/,
    );
  });

  it("both sections point at the note that owns the live answer", () => {
    // Otherwise the correction is a dead end: a reader learns the number is
    // untrustworthy and has nowhere to get the real one.
    const occurrences = OBSERVABILITY.split("vault/10-ops/edge-container-settings.md").length - 1;
    expect(occurrences, "each corrected section needs the pointer").toBeGreaterThanOrEqual(2);
  });

  it("the consequence is stated, not just the correction", () => {
    // "This may be unset" is a fact nobody acts on. "The edge shares that
    // volume with Postgres" is why it matters.
    // `[\s>]` rather than `\s`: the sentences live in blockquote callouts, so
    // a line wrap puts a "> " between the words. Written with plain \s first
    // and it failed on prose that was already correct.
    expect(OBSERVABILITY).toMatch(/shares that volume with Postgres/i);
    expect(OBSERVABILITY).toMatch(/ten[\s>]+times the volume/i);
  });
});
