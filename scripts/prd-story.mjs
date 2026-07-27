// One generic prd.json editor, replacing ~90 single-use scripts.
//
// The pattern this retires: every closed story got its own throwaway file
// (update-prd-ios-us169.mjs … us199.mjs, append-progress-us189.mjs,
// tick-review-boxes-*.mjs), each one re-implementing read → mutate → write with
// a hardcoded id and a hardcoded note. Same three operations every time, so they
// live here once and take arguments.
//
// Usage:
//   node scripts/prd-story.mjs new  --title "…" --description "…" \
//                                   --ac "…" --ac "…" [--priority N] [--depends US-1]
//   node scripts/prd-story.mjs done US-1234 [US-1235 …] --note "Done 2026-07-27. …"
//   node scripts/prd-story.mjs note US-1234 --note "Partial: …"
//   node scripts/prd-story.mjs show US-1234
//
// `new` takes the id from prd.json.nextId and bumps it — never max(id)+1, since
// the high-id completed stories live in prd.archive.json and that would reuse
// ids. Notes are APPEND-ONLY (" | " segments), because prd-lint's deferral guard
// resolves blockers by segment ORDER; overwriting notes destroys that history.
//
// Pure functions are exported for the vitest suite; the CLI at the bottom only
// runs when this file is the entrypoint.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRD_URL = new URL("../prd.json", import.meta.url);

/** prd.json is written 2-space + trailing newline; keep diffs to real changes. */
export const serialize = (prd) => JSON.stringify(prd, null, 2) + "\n";

/** "US-2208" | 2208 → 2208. NaN when unparseable. */
export const parseIdNum = (id) =>
  typeof id === "number" ? id : Number.parseInt(String(id).replace(/^US-/, ""), 10);

/**
 * Append a note segment. Notes are append-only history, not a field to replace:
 * prd-lint decides whether a "DEFERRED"/"BLOCKED" marker was later resolved by
 * looking at which " | " segment it sits in relative to the closing token.
 */
export function appendNote(existing, addition) {
  const prev = typeof existing === "string" ? existing.trim() : "";
  const next = String(addition ?? "").trim();
  if (!next) return prev;
  return prev ? `${prev} | ${next}` : next;
}

/**
 * Flip stories to passes:true and append their completion note.
 * Throws on an unknown id — a silent no-op here reads as "recorded" when the
 * story was never touched, which is exactly the failure the one-off scripts had.
 */
export function markDone(prd, ids, note) {
  const byId = new Map(prd.userStories.map((s) => [s.id, s]));
  const touched = [];
  for (const id of ids) {
    const story = byId.get(id);
    if (!story) throw new Error(`story not found in prd.json: ${id}`);
    story.passes = true;
    if (note) story.notes = appendNote(story.notes, note);
    touched.push(id);
  }
  return { prd, touched };
}

/** Append a note without changing `passes` — for partial or negative results. */
export function addNote(prd, id, note) {
  const story = prd.userStories.find((s) => s.id === id);
  if (!story) throw new Error(`story not found in prd.json: ${id}`);
  if (!note) throw new Error("--note is required for `note`");
  story.notes = appendNote(story.notes, note);
  return { prd, touched: [id] };
}

/**
 * Create a story at prd.json.nextId and bump nextId past it.
 *
 * description + acceptanceCriteria are required because prd-lint requires them
 * on every `passes:false` story — the actionable backlog Ralph selects from.
 * Failing here beats failing in CI with a half-written story already committed.
 */
export function createStory(prd, { title, description, acceptanceCriteria, priority, dependsOn }) {
  if (!title) throw new Error("--title is required");
  if (!description) throw new Error("--description is required");
  if (!acceptanceCriteria?.length)
    throw new Error("at least one --ac (acceptance criterion) is required");

  const nextNum = parseIdNum(prd.nextId);
  if (!Number.isFinite(nextNum)) throw new Error(`prd.json.nextId is unusable: ${prd.nextId}`);

  const id = `US-${nextNum}`;
  if (prd.userStories.some((s) => s.id === id))
    throw new Error(`nextId ${id} already exists in prd.json — nextId is stale, fix it first`);

  const story = { id, passes: false, title, description, acceptanceCriteria };
  if (priority !== undefined) story.priority = priority;
  if (dependsOn?.length) story.dependsOn = dependsOn;

  prd.userStories.push(story);
  // Match whatever form nextId already used — the linter accepts both.
  prd.nextId = typeof prd.nextId === "number" ? nextNum + 1 : `US-${nextNum + 1}`;
  return { prd, id };
}

/** Minimal flag parser: repeatable flags collect into arrays. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const value = argv[i + 1]?.startsWith("--") || i + 1 >= argv.length ? true : argv[++i];
    if (key in flags) flags[key] = [].concat(flags[key], value);
    else flags[key] = value;
  }
  return { positional, flags };
}

const asArray = (v) => (v === undefined ? [] : [].concat(v).filter((x) => x !== true));

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...ids] = positional;
  const prd = JSON.parse(readFileSync(PRD_URL, "utf8"));
  const note = typeof flags.note === "string" ? flags.note : undefined;

  try {
    if (cmd === "new") {
      const priority = flags.priority ? Number(flags.priority) : undefined;
      const { id } = createStory(prd, {
        title: typeof flags.title === "string" ? flags.title : undefined,
        description: typeof flags.description === "string" ? flags.description : undefined,
        acceptanceCriteria: asArray(flags.ac),
        priority: Number.isFinite(priority) ? priority : undefined,
        dependsOn: asArray(flags.depends),
      });
      writeFileSync(PRD_URL, serialize(prd));
      console.log(`created ${id} (prd.json.nextId bumped to ${prd.nextId})`);
    } else if (cmd === "done") {
      if (!ids.length) throw new Error("usage: prd-story.mjs done US-#### [US-#### …] --note '…'");
      const { touched } = markDone(prd, ids, note);
      writeFileSync(PRD_URL, serialize(prd));
      console.log(`passes:true → ${touched.join(", ")}${note ? " (note appended)" : ""}`);
    } else if (cmd === "note") {
      if (ids.length !== 1) throw new Error("usage: prd-story.mjs note US-#### --note '…'");
      addNote(prd, ids[0], note);
      writeFileSync(PRD_URL, serialize(prd));
      console.log(`note appended → ${ids[0]}`);
    } else if (cmd === "show") {
      const story = prd.userStories.find((s) => s.id === ids[0]);
      if (!story) throw new Error(`story not found in prd.json: ${ids[0]}`);
      console.log(JSON.stringify(story, null, 2));
    } else {
      console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(6, 18).join("\n"));
      process.exit(1);
    }
  } catch (err) {
    console.error(`prd-story: ${err.message}`);
    process.exit(1);
  }
}
