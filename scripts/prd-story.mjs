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
//   node scripts/prd-story.mjs done US-1234 [US-1235 …] --note "Done 2026-07-27. …" [--no-archive]
//   node scripts/prd-story.mjs note US-1234 --note "Partial: …"
//   node scripts/prd-story.mjs ac   US-1234 --ac "OPERATOR: run … against prod"
//   node scripts/prd-story.mjs show US-1234
//
// Every command takes [--backlog main|connector|seo] (default main). `show`
// searches all three plus the archive regardless, so you need the flag only
// when WRITING to a side backlog.
//
// `new` takes the id from prd.json.nextId and bumps it — never max(id)+1, since
// the high-id completed stories live in prd.archive.json and that would reuse
// ids. Notes are APPEND-ONLY (" | " segments), because prd-lint's deferral guard
// resolves blockers by segment ORDER; overwriting notes destroys that history.
//
// Pure functions are exported for the vitest suite; the CLI at the bottom only
// runs when this file is the entrypoint.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRD_URL = new URL("../prd.json", import.meta.url);
const ARCHIVE_URL = new URL("../prd.archive.json", import.meta.url);

/**
 * The backlogs this script may edit, and the shorthand each answers to.
 *
 * prd.json is not the only one. prd-connector.json (31 stories) and
 * prd-seo.json (18) are deliberately separate — the connector's own header says
 * it is held out of prd.json "so the Ralph loop can never collide with it" — and
 * until now this script could not read or write either.
 *
 * WHAT THAT COST, on 2026-08-23: `show US-9127` answered "story not found in
 * prd.json or prd.archive.json", for a story that exists. This file already
 * argues, about the archive, that reading as "that story never existed" is the
 * worst possible answer. The same sentence applies to a story sitting in a
 * sibling file. Appending a note to it meant hand-rolling a script with its own
 * round-trip integrity check, which is exactly the ~90 single-use scripts this
 * one replaced.
 *
 * A NAMED SET, not a glob: these are the files whose shape is known to be
 * { userStories: [...] } with 2-space serialisation. A glob would pick up
 * anything named prd-*.json later, including something with a different shape.
 */
export const BACKLOGS = {
  main: "../prd.json",
  connector: "../prd-connector.json",
  seo: "../prd-seo.json",
  // Cross-listing competitiveness programme (US-9201+), 2026-09-01. Same
  // reason as the other two siblings: held out of prd.json so Ralph never
  // collides with it, and registered here so `show`/`note`/`done` can reach it.
  crosslisting: "../prd-crosslisting.json",
  // WRITABLE BY `note` ONLY — see NOTE_ONLY_BACKLOGS below.
  //
  // Closing a story does not end the need to correct its record. US-2802's AC5
  // had to fix US-1283's closure and did it by hand; US-2796 closed today saying
  // AC3 was met and it was met on one of two paths, with nowhere to say so. A
  // correction that lives only in a commit message is a correction the next
  // reader of the story will not find.
  //
  // Checked before allowing this: prd.archive.json round-trips byte-identically
  // through `serialize`, so appending one note produces a one-story diff rather
  // than reformatting 7.8 MB.
  archive: "../prd.archive.json",
};

/**
 * Backlogs that only `note` may write.
 *
 * `new` in the archive would mint an id nothing tracks, and `done` on a story
 * that is already `passes: true` and already archived is a no-op that reads like
 * an action. Both refuse, naming the reason, rather than doing something
 * surprising to the biggest file in the repo.
 */
export const NOTE_ONLY_BACKLOGS = new Set(["archive"]);

/**
 * Resolve a --backlog value to one of the named files.
 *
 * Accepts the shorthand ("connector") or the filename ("prd-connector.json"),
 * because both are things a person reasonably types. Anything else THROWS
 * naming the options — a typo must not silently edit the main backlog, which is
 * the one failure mode that would be worse than not having this flag.
 */
export function resolveBacklog(value) {
  if (value === undefined || value === true) return BACKLOGS.main;
  const raw = String(value).trim();
  if (Object.hasOwn(BACKLOGS, raw)) return BACKLOGS[raw];
  const byFile = Object.values(BACKLOGS).find((p) => p === `../${raw}` || p.endsWith(`/${raw}`));
  if (byFile) return byFile;
  throw new Error(
    `unknown --backlog ${JSON.stringify(raw)} — expected one of: ` +
      Object.keys(BACKLOGS).join(", "),
  );
}

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
 * Append acceptance criteria to an existing story.
 *
 * The reason this exists is the operator queue. `prd-operator.mjs` reads
 * criteria that start with `OPERATOR:`, and a story whose remaining work needs
 * a person but says so only in prose is INVISIBLE to it — so the owner plans
 * against a queue that is short by however many of those there are. Declaring
 * one meant hand-editing a 0.27MB JSON file, which is exactly the friction that
 * kept them undeclared.
 *
 * APPEND ONLY, and refuses an exact duplicate. Rewriting an existing criterion
 * would let a story quietly change what it promised after the fact; that is a
 * deliberate edit, not a scripted one.
 */
export function addCriteria(prd, id, criteria) {
  const story = prd.userStories.find((s) => s.id === id);
  if (!story) throw new Error(`story not found in prd.json: ${id}`);
  if (!criteria.length) throw new Error("at least one --ac is required for `ac`");
  story.acceptanceCriteria = story.acceptanceCriteria ?? [];
  const added = [];
  for (const c of criteria) {
    const text = String(c).trim();
    if (!text) continue;
    if (story.acceptanceCriteria.some((existing) => existing.trim() === text)) continue;
    story.acceptanceCriteria.push(text);
    added.push(text);
  }
  return { prd, touched: [id], added };
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

/**
 * Move every finished story to prd.archive.json, right after closing one.
 *
 * WHY THIS RUNS HERE. Closing and archiving used to be two steps, and the second
 * one was a chore nobody did until CI complained: `prd-archive-integrity` fails
 * the build the moment a `passes:true` story sits in prd.json. With more than
 * one agent closing stories, that guard was red more often than green, and a
 * lane that is usually red teaches people to ignore it. Closing a story is the
 * only moment anyone reliably touches the backlog, so the move belongs there.
 *
 * It SHELLS OUT rather than reimplementing the move. archive-passing-stories.mjs
 * owns every safety check worth having — duplicate-id refusal, count
 * reconciliation, the `nextId` invariant, backups, and a post-write re-read —
 * and a second copy of that logic would be free to drift from the one CI runs.
 *
 * CONCURRENCY, since two agents share this tree: an agent holding a stale
 * prd.json in memory can write a story back after it was archived. That is the
 * clobber CLAUDE.md warns about, and it stays LOUD rather than silent — the next
 * archive run hits the duplicate-id check and refuses, naming the ids. Recover
 * by deleting the restored copy from prd.json; the archive holds the real one.
 *
 * A failure here does NOT fail the close. The story is already written and
 * `passes:true` is the fact that matters; an un-archived story is a tidiness
 * problem that the batch script fixes later.
 */
export function archiveNow() {
  try {
    process.stdout.write(
      execFileSync("node", ["scripts/archive-passing-stories.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      }),
    );
  } catch (err) {
    console.error(`prd-story: closed, but archiving failed — ${err.message}`);
    console.error("prd-story: run `node scripts/archive-passing-stories.mjs` by hand.");
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...ids] = positional;
  let backlogRel;
  let isMain;
  let TARGET_URL;
  let prd;
  const note = typeof flags.note === "string" ? flags.note : undefined;

  try {
    // Inside the try: a bad --backlog is bad INPUT, and this script answers bad
    // input with one line rather than a stack trace.
    backlogRel = resolveBacklog(flags.backlog);
    // A note-only backlog refuses every other command, naming the reason. This
    // is checked BEFORE the file is read, so a mistyped command cannot even open
    // the archive for writing.
    const backlogName = Object.keys(BACKLOGS).find((k) => BACKLOGS[k] === backlogRel);
    if (NOTE_ONLY_BACKLOGS.has(backlogName) && cmd !== "note" && cmd !== "show") {
      throw new Error(
        `--backlog ${backlogName} accepts only \`note\` (and \`show\`). ` +
          `\`${cmd}\` there would ` +
          (cmd === "new"
            ? "mint an id nothing tracks"
            : cmd === "done"
              ? "re-close a story that is already closed and already archived"
              : "edit a finished story's criteria, which is what a new story is for") +
          `. A CORRECTION to a closed story is what \`note\` is for.`,
      );
    }
    isMain = backlogRel === BACKLOGS.main;
    TARGET_URL = new URL(backlogRel, import.meta.url);
    prd = JSON.parse(readFileSync(TARGET_URL, "utf8"));
    if (cmd === "new") {
      const priority = flags.priority ? Number(flags.priority) : undefined;
      const { id } = createStory(prd, {
        title: typeof flags.title === "string" ? flags.title : undefined,
        description: typeof flags.description === "string" ? flags.description : undefined,
        acceptanceCriteria: asArray(flags.ac),
        priority: Number.isFinite(priority) ? priority : undefined,
        dependsOn: asArray(flags.depends),
      });
      writeFileSync(TARGET_URL, serialize(prd));
      console.log(`created ${id} (prd.json.nextId bumped to ${prd.nextId})`);
    } else if (cmd === "done") {
      if (!ids.length) throw new Error("usage: prd-story.mjs done US-#### [US-#### …] --note '…'");
      const { touched } = markDone(prd, ids, note);
      writeFileSync(TARGET_URL, serialize(prd));
      console.log(`passes:true → ${touched.join(", ")}${note ? " (note appended)" : ""}`);
      if (flags["no-archive"]) console.log("--no-archive: left in prd.json");
      // archive-passing-stories.mjs moves rows from prd.json to
      // prd.archive.json and knows about no other pair. Running it after
      // closing a connector or SEO story would report "0 archived" and read as
      // a failure of THIS close, so it is skipped with the reason.
      else if (!isMain) {
        console.log(`closed in ${backlogRel.replace("../", "")}; that backlog has no archive, so nothing was moved`);
      } else archiveNow();
    } else if (cmd === "note") {
      if (ids.length !== 1) throw new Error("usage: prd-story.mjs note US-#### --note '…'");
      addNote(prd, ids[0], note);
      writeFileSync(TARGET_URL, serialize(prd));
      console.log(`note appended → ${ids[0]}`);
    } else if (cmd === "ac") {
      if (ids.length !== 1) throw new Error("usage: prd-story.mjs ac US-#### --ac '…' [--ac '…']");
      const { added } = addCriteria(prd, ids[0], asArray(flags.ac));
      writeFileSync(TARGET_URL, serialize(prd));
      console.log(
        added.length
          ? `${added.length} criterion(a) appended → ${ids[0]}`
          : `nothing appended → ${ids[0]} (already present)`,
      );
    } else if (cmd === "show") {
      let story = prd.userStories.find((s) => s.id === ids[0]);
      // Every backlog, not just the target: someone asking about a story does
      // not necessarily know which file holds it, and "not found" for a story
      // that exists is the answer this file already calls the worst possible
      // one.
      if (!story) {
        for (const [name, rel] of Object.entries(BACKLOGS)) {
          if (rel === backlogRel) continue;
          const other = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
          const hit = other.userStories.find((s) => s.id === ids[0]);
          if (hit) {
            console.log(`// from ${rel.replace("../", "")} (--backlog ${name})`);
            story = hit;
            break;
          }
        }
      }
      // Closing now moves the story to prd.archive.json in the same breath, so
      // `show` on anything already finished would otherwise report it missing —
      // which reads as "that story never existed", the worst possible answer.
      if (!story) {
        const archive = JSON.parse(readFileSync(ARCHIVE_URL, "utf8"));
        story = archive.userStories.find((s) => s.id === ids[0]);
        if (story) console.log("// from prd.archive.json (completed)");
      }
      if (!story) {
        throw new Error(
          `story not found in any backlog (${Object.keys(BACKLOGS).join(", ")}) or prd.archive.json: ${ids[0]}`,
        );
      }
      console.log(JSON.stringify(story, null, 2));
    } else {
      console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(6, 22).join("\n"));
      process.exit(1);
    }
  } catch (err) {
    console.error(`prd-story: ${err.message}`);
    process.exit(1);
  }
}
