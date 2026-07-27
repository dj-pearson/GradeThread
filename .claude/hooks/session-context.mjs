// SessionStart hook — inject live repo state so a session doesn't start cold.
//
// Every session used to burn turns rediscovering facts that already sit on disk:
// which migrations are HELD, whether EXPECTED_SCHEMA_VERSION drifted from the
// newest migration file, what prd.json.nextId is, whether the Ralph loop is
// mid-story, and whether the temporary work-on-main override is still in force.
// This reads all of that in ~50ms and hands it over as additionalContext.
//
// CONTRACT: this hook must never break a session. Every probe is wrapped; any
// failure degrades to a "(unavailable)" line and the process still exits 0.
// It is READ-ONLY — it must never write to the repo.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const p = (...s) => path.join(ROOT, ...s);

/** Run a probe; never let it throw. Returns `fallback` on any failure. */
function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const git = (...args) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const lines = [];
const warn = (s) => lines.push(`⚠ ${s}`);
const info = (s) => lines.push(`• ${s}`);

// ── 1. Migrations: held-but-unapplied, and version drift ────────────────────
// The US-1108 triple means the newest migration file's NNNNN and
// EXPECTED_SCHEMA_VERSION must match. A mismatch is a real bug in flight, not a
// style nit — the edge boot guard fails the deploy on it.
const held = safe(() => {
  const md = readFileSync(p("PENDING_MIGRATIONS.md"), "utf8");
  // Emoji-agnostic: any "## … HELD: NNNNN_name.sql" heading.
  return [...md.matchAll(/^##.*?HELD:\s*(\d{5})_(\S+?)\.sql/gim)].map(
    (m) => `${m[1]}_${m[2]}`,
  );
}, []);

const newestMigration = safe(() => {
  const files = readdirSync(p("supabase", "migrations"))
    .filter((f) => /^\d{5}_.*\.sql$/.test(f))
    .sort();
  return files.at(-1)?.slice(0, 5) ?? null;
});

const expectedVersion = safe(() => {
  const src = readFileSync(
    p("services", "edge-functions", "src", "lib", "schema-version.ts"),
    "utf8",
  );
  return src.match(/EXPECTED_SCHEMA_VERSION\s*=\s*"(\d{5})"/)?.[1] ?? null;
});

if (newestMigration && expectedVersion) {
  if (newestMigration !== expectedVersion) {
    warn(
      `SCHEMA DRIFT: newest migration is ${newestMigration} but ` +
        `EXPECTED_SCHEMA_VERSION is ${expectedVersion} — the US-1108 triple is ` +
        `broken (bump belongs in the SAME commit as the migration).`,
    );
  } else {
    info(`Migrations at ${newestMigration}, EXPECTED_SCHEMA_VERSION in sync.`);
  }
}

if (held.length) {
  warn(
    `${held.length} migration(s) HELD (not yet applied to prod): ` +
      `${held.join(", ")}. See PENDING_MIGRATIONS.md — some are apply-BEFORE-push.`,
  );
}

// ── 2. PRD: the id to use next, and how much backlog is open ────────────────
// nextId matters because max(id)+1 is WRONG here (done stories live in
// prd.archive.json), and getting it wrong silently reuses ids.
safe(() => {
  const prd = JSON.parse(readFileSync(p("prd.json"), "utf8"));
  const open = prd.userStories.filter((s) => !s.passes).length;
  const done = prd.userStories.length - open;
  info(
    `prd.json: nextId=${prd.nextId}, ${open} open` +
      (done ? `, ${done} passes:true awaiting re-archive` : "") +
      `. Use nextId then bump it — never max(id)+1.`,
  );
});

// ── 3. Ralph loop state ─────────────────────────────────────────────────────
// There is no pid file, so "is it running" is inferred from how recently
// current-story.json was rewritten. Reported as a heuristic, not a fact.
safe(() => {
  const storyPath = p("scripts", "ralph", "current-story.json");
  if (!existsSync(storyPath)) return;
  const ageMin = (Date.now() - statSync(storyPath).mtimeMs) / 60000;
  if (ageMin > 90) return; // stale — loop isn't live, stay quiet
  const story = JSON.parse(readFileSync(storyPath, "utf8"));
  warn(
    `Ralph may be LIVE: current-story.json touched ${Math.round(ageMin)}m ago ` +
      `(${story.id ?? "?"} — ${story.title ?? "?"}). Stop it before rewriting ` +
      `prd.json / prd.archive.json: bash scripts/ralph/stop-ralph.sh`,
  );
  if (existsSync(p("scripts", "ralph", "STOP")))
    info("A graceful-stop flag is already pending (scripts/ralph/STOP).");
});

// ── 4. Is the temporary work-on-main override still in force? ───────────────
safe(() => {
  const claudeMd = readFileSync(p("CLAUDE.md"), "utf8");
  if (/TEMPORARY WORKFLOW OVERRIDE/.test(claudeMd))
    info("Workflow: commit straight to main (pre-production override active).");
});

// ── 5. Git working state ────────────────────────────────────────────────────
safe(() => {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const dirty = git("status", "--porcelain")
    .split("\n")
    .filter(Boolean).length;
  const ahead = safe(
    () => git("rev-list", "--count", "@{upstream}..HEAD"),
    null,
  );
  const parts = [`branch ${branch}`];
  if (dirty) parts.push(`${dirty} uncommitted file(s)`);
  if (ahead && ahead !== "0") parts.push(`${ahead} unpushed commit(s)`);
  info(`Git: ${parts.join(", ")}.`);
});

if (!lines.length) process.exit(0);

const context = [
  "Repo state at session start (from .claude/hooks/session-context.mjs — " +
    "already verified, no need to re-check):",
  ...lines,
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
