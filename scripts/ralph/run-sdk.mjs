// Ralph loop on the Claude Agent SDK (replaces the `claude --print` shell-out).
//
// The old path (ralph.sh:216) was:
//   timeout 2400s claude --model X --dangerously-skip-permissions --print < CLAUDE.md | tee $TMP
//
// which works, but unattended it is close to blind:
//   • You cannot tell WHY an iteration ended. Finished? Hit the wall-clock kill?
//     Ran out of turns? Refused? Everything collapses into one exit code and a
//     grep for <promise>STORY_DONE</promise> in the transcript.
//   • --dangerously-skip-permissions is all-or-nothing. There is no way to allow
//     the 99% while still refusing `git push` on an unattended loop.
//   • No per-story cost. The loop can run overnight with no idea what it spent.
//   • A killed iteration threw away all its context and started the same story
//     cold next time.
//
// The SDK gives all four back: a structured result message (subtype, stop_reason,
// num_turns, total_cost_usd, usage, permission_denials), a programmatic
// canUseTool gate, and session ids that let a timed-out story resume where it
// stopped instead of restarting from nothing.
//
// Story SELECTION and the passes:true flip stay on this side, exactly as
// ralph.sh had them — the agent never reads or rewrites prd.json (~300 KB).
//
// Usage:  npm run ralph -- 10        (10 iterations; default 10)
// Env:    RALPH_DEFAULT_MODEL (default "opus"), RALPH_HARD_MODEL, RALPH_FORCE_MODEL,
//         RALPH_ITER_TIMEOUT (seconds, default 2400), RALPH_MAX_TURNS,
//         RALPH_MAX_BUDGET_USD, RALPH_NO_RESUME=1
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePriority } from "../lib/prd-priority.mjs";
import { markDone, serialize } from "../prd-story.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
const PRD = path.join(ROOT, "prd.json");
const PROMPT = path.join(HERE, "CLAUDE.md");
const CURRENT_STORY = path.join(HERE, "current-story.json");
const PROGRESS = path.join(HERE, "progress.txt");
const STOP_FLAG = path.join(HERE, "STOP");
const SESSIONS = path.join(HERE, "sessions.json"); // storyId → sessionId, for resume
const COSTS = path.join(HERE, "costs.jsonl");

const maxIterations = Number(process.argv[2]) || 10;
const timeoutMs = (Number(process.env.RALPH_ITER_TIMEOUT) || 2400) * 1000;

const readJson = (p, fallback = {}) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

const git = (...args) => {
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "ignore", timeout: 30_000 });
  } catch {
    /* a failed bookkeeping commit must never stop the loop */
  }
};

// ── Story selection ─────────────────────────────────────────────────────────
/**
 * Highest-priority open story whose dependsOn are all satisfied.
 *
 * "Highest priority" means the LOWEST number — see comparePriority and
 * vault/70-agent/backlog-priority-contract.md. This file used to sort the other
 * way, which is why US-2371 exists.
 *
 * A dep counts as satisfied when it is passes:true OR absent entirely (it was
 * archived to prd.archive.json). Only `dependsOn` is honored — the loose
 * [[US-xxxx]] links in `notes` prose mix "depends on" with "pairs with" and
 * would deadlock the loop. Exported for the test suite.
 */
export function selectStory(prd) {
  const open = prd.userStories.filter((s) => !s.passes);
  const openIds = new Set(open.map((s) => s.id));
  const eligible = open.filter(
    (s) => !(s.dependsOn ?? []).some((d) => openIds.has(d)),
  );
  // Ascending priority, missing sorts last, ties broken on id. The direction and
  // the missing-value rule are the backlog contract, not a local choice, so they
  // live in scripts/lib/prd-priority.mjs and every consumer imports them.
  eligible.sort(comparePriority);
  return { openCount: open.length, story: eligible[0] ?? null, open };
}

/** Which model runs this story: explicit `model` > `hard` > default. */
export function resolveModel(story, env = process.env) {
  if (env.RALPH_FORCE_MODEL) return env.RALPH_FORCE_MODEL;
  if (story.model) return story.model;
  if (story.hard === true) return env.RALPH_HARD_MODEL || "opus";
  return env.RALPH_DEFAULT_MODEL || "opus";
}

// ── The permission gate ─────────────────────────────────────────────────────
// Replaces --dangerously-skip-permissions. `canUseTool` answers every request
// programmatically, so the loop stays fully unattended — but a handful of
// actions that are catastrophic on an unattended loop are refused outright.
//
// The deny message is fed back to the agent, so it can adapt rather than
// silently failing. Denials also land in result.permission_denials, which the
// per-iteration summary prints — a story that keeps hitting the gate is visible
// instead of mysteriously unproductive.
const FORBIDDEN = [
  {
    // Ralph commits locally; PUSHING is a human decision. The Ralph prompt says
    // "do NOT push" — this makes it a wall rather than a request.
    test: (cmd) => /\bgit\s+push\b/.test(cmd),
    why: "Ralph commits locally only. Pushing is a human decision — leave the commit for review.",
  },
  {
    test: (cmd) => /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/.test(cmd),
    why: "Recursive force-delete is refused on the unattended loop. Delete specific paths instead.",
  },
  {
    test: (cmd) => /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[dfx]|checkout\s+--\s)/.test(cmd),
    why: "Destructive git operations are refused on the unattended loop — they can discard a prior iteration's committed work.",
  },
  {
    test: (cmd) => /--no-verify|--no-gpg-sign/.test(cmd),
    why: "Bypassing hooks is refused. If the pre-commit hook fails, fix the cause.",
  },
];

function canUseTool(toolName, input) {
  if (toolName === "Bash" || toolName === "PowerShell") {
    const cmd = String(input?.command ?? "");
    const hit = FORBIDDEN.find((rule) => rule.test(cmd));
    if (hit) return Promise.resolve({ behavior: "deny", message: hit.why });
  }
  // prd.json / prd.archive.json writes are already blocked by the PreToolUse
  // write-guard hook (.claude/hooks/write-guard.mjs), which the SDK loads via
  // settingSources — no need to duplicate that rule here.
  return Promise.resolve({ behavior: "allow" });
}

// ── One iteration ───────────────────────────────────────────────────────────
async function runStory(story, model, resumeSessionId) {
  const prompt = readFileSync(PROMPT, "utf8");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let sessionId = resumeSessionId ?? null;
  let sawStoryDone = false;
  let result = null;

  try {
    const q = query({
      prompt,
      options: {
        model,
        cwd: ROOT,
        abortController: abort,
        // canUseTool is the gate; `bypassPermissions` would skip it entirely
        // and put us back where the shell-out was.
        permissionMode: "default",
        canUseTool,
        // Load the project's CLAUDE.md, .claude/settings.json (write-guard hook,
        // SessionStart context) and settings.local.json. Without this the SDK
        // runs with none of the repo's own rules, which is not what the loop wants.
        settingSources: ["project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        ...(Number(process.env.RALPH_MAX_TURNS)
          ? { maxTurns: Number(process.env.RALPH_MAX_TURNS) }
          : {}),
        ...(Number(process.env.RALPH_MAX_BUDGET_USD)
          ? { maxBudgetUsd: Number(process.env.RALPH_MAX_BUDGET_USD) }
          : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    });

    for await (const msg of q) {
      if (msg.session_id) sessionId = msg.session_id;

      if (msg.type === "assistant") {
        // Stream the agent's prose so the console still reads like the old
        // `tee`. Tool calls stay quiet — they were never in the old output either.
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text.trim())
            process.stdout.write(block.text);
        }
      } else if (msg.type === "result") {
        result = msg;
        // The completion signal is the promise token in the agent's final text.
        if (msg.subtype === "success" && /<promise>STORY_DONE<\/promise>/.test(msg.result ?? ""))
          sawStoryDone = true;
      }
    }
  } catch (err) {
    // An abort surfaces here; anything else is a genuine SDK/transport failure.
    const aborted = abort.signal.aborted;
    console.error(
      `\n  ${aborted ? `TIMEOUT after ${timeoutMs / 1000}s` : "SDK error"}: ${err.message}`,
    );
    return { done: false, sessionId, result: null, aborted };
  } finally {
    clearTimeout(timer);
  }

  return { done: sawStoryDone, sessionId, result, aborted: false };
}

/** Human-readable "why did this iteration end" — the thing the old loop lost. */
function describeOutcome({ done, result, aborted }) {
  if (aborted) return "killed on the iteration timeout (likely a hung build)";
  if (!result) return "ended with no result message (transport failure)";
  if (result.subtype === "error_max_turns") return "hit maxTurns before finishing";
  if (result.subtype === "error_max_budget_usd") return "hit the per-iteration budget cap";
  if (result.subtype !== "success") return `errored: ${result.subtype}`;
  if (!done) return `finished without <promise>STORY_DONE</promise> (stop_reason: ${result.stop_reason ?? "n/a"})`;
  return "completed and self-verified";
}

// ── Loop ────────────────────────────────────────────────────────────────────
// Guarded so the vitest suite can import selectStory/resolveModel without
// launching a real loop.
async function main() {
const sessions = readJson(SESSIONS, {});

for (let i = 1; i <= maxIterations; i++) {
  if (existsSync(STOP_FLAG)) {
    rmSync(STOP_FLAG, { force: true });
    console.log("\nGraceful stop requested — exiting before the next iteration.");
    process.exit(0);
  }

  const prd = readJson(PRD, null);
  if (!prd) {
    console.error("ERROR: prd.json is unreadable — refusing to run.");
    process.exit(1);
  }

  const { openCount, story, open } = selectStory(prd);

  if (openCount === 0) {
    console.log("\nAll stories pass — nothing left to do.\n<promise>COMPLETE</promise>");
    process.exit(0);
  }
  if (!story) {
    // Open stories remain but every one is gated. That is a dependsOn cycle or
    // an unsatisfiable dep — an authoring error, NOT completion. Fail loudly and
    // deliberately do not emit COMPLETE.
    const openIds = new Set(open.map((s) => s.id));
    console.error(
      `\nERROR: ${openCount} open story(ies) remain but ALL are blocked by unmet dependsOn.`,
    );
    for (const s of open) {
      const unmet = (s.dependsOn ?? []).filter((d) => openIds.has(d));
      if (unmet.length)
        console.error(`  ${s.id} (prio ${s.priority}) blocked by: ${unmet.join(", ")}`);
    }
    console.error("Fix dependsOn in prd.json (or complete a blocking story), then re-run.");
    process.exit(1);
  }

  const model = resolveModel(story);
  // Resume only the SAME story — a session carries that story's context and is
  // meaningless for a different one. This is what makes a timed-out iteration
  // cheap to retry instead of a total loss.
  const resumeId =
    process.env.RALPH_NO_RESUME === "1" ? undefined : sessions[story.id];

  console.log(`\n${"=".repeat(63)}`);
  console.log(`  Ralph iteration ${i} of ${maxIterations}`);
  console.log(`${"=".repeat(63)}`);
  console.log(`  Story:  ${story.id} — ${story.title}`);
  console.log(`  Model:  ${model}${resumeId ? "  (resuming prior session)" : ""}`);
  const hints = (story.relevantPaths ?? []).length;
  if (hints) console.log(`  relevantPaths hint: ${hints} path(s)`);

  writeFileSync(CURRENT_STORY, JSON.stringify(story, null, 2) + "\n");

  const outcome = await runStory(story, model, resumeId);
  const { done, sessionId, result } = outcome;

  // ── Accounting: the thing the shell-out could not report ──────────────────
  if (result) {
    const usd = result.total_cost_usd ?? 0;
    const u = result.usage ?? {};
    console.log(
      `\n  ${result.num_turns} turns · $${usd.toFixed(4)} · ` +
        `${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out · ` +
        `${Math.round((result.duration_ms ?? 0) / 1000)}s`,
    );
    if (result.permission_denials?.length)
      console.log(
        `  ${result.permission_denials.length} permission denial(s): ` +
          `${[...new Set(result.permission_denials.map((d) => d.tool_name))].join(", ")}`,
      );
    appendFileSync(
      COSTS,
      JSON.stringify({
        at: new Date().toISOString(),
        story: story.id,
        model,
        subtype: result.subtype,
        done,
        num_turns: result.num_turns,
        total_cost_usd: usd,
        duration_ms: result.duration_ms,
        usage: result.usage,
        denials: result.permission_denials?.length ?? 0,
      }) + "\n",
    );
  }
  console.log(`  Outcome: ${describeOutcome(outcome)}`);

  // Remember the session so a retry of this same story resumes it; drop it once
  // the story is done so the id can't leak into an unrelated future story.
  if (done) delete sessions[story.id];
  else if (sessionId) sessions[story.id] = sessionId;
  writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2) + "\n");

  if (!done) {
    console.log(`  ${story.id} not marked done — will retry next iteration.`);
    continue;
  }

  // ── Mark complete (here, never by the agent) ──────────────────────────────
  try {
    const fresh = readJson(PRD, null);
    markDone(fresh, [story.id], "");
    writeFileSync(PRD, serialize(fresh));
    console.log(`  ${story.id} marked passes:true.`);
  } catch (err) {
    console.error(`  Failed to update prd.json for ${story.id}: ${err.message}`);
    console.error("  Leaving passes:false so the story is retried.");
    continue;
  }

  appendFileSync(
    PROGRESS,
    `## ${story.id}: ${story.title}\n- Status: COMPLETE\n- Timestamp: ${new Date().toISOString()}\n- Cost: $${(result?.total_cost_usd ?? 0).toFixed(4)} over ${result?.num_turns ?? 0} turns\n---\n`,
  );
  git("add", PRD, PROGRESS);
  git("commit", "-m", `chore(${story.id}): mark story complete`);

  const remaining = readJson(PRD, { userStories: [] }).userStories.filter(
    (s) => !s.passes,
  ).length;
  if (remaining === 0) {
    console.log(`\nRalph completed all tasks at iteration ${i}.\n<promise>COMPLETE</promise>`);
    process.exit(0);
  }
}

console.log(`\nRalph reached max iterations (${maxIterations}) with stories still open.`);
console.log(`Per-story cost log: ${COSTS}`);
process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
