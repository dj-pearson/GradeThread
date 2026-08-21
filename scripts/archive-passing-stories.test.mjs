// archive-passing-stories.mjs runs on EVERY story close now (prd-story.mjs
// `done` and the Ralph loop both call it), so its refusals are load-bearing
// rather than a batch-time formality. These tests execute the real script in a
// temp directory instead of scanning its source — a guard that reads code
// passes just as happily against code that no longer works.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./archive-passing-stories.mjs", import.meta.url));

let dir;

/** Run the real script in `dir`. Returns { ok, out } rather than throwing. */
function run(...args) {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const write = (name, value) =>
  writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + "\n");
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const ids = (json) => json.userStories.map((s) => s.id);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "prd-archive-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("archive-passing-stories", () => {
  it("moves finished stories out and leaves the open backlog alone", () => {
    write("prd.json", {
      nextId: "US-500",
      userStories: [
        { id: "US-1", passes: true, title: "closed" },
        { id: "US-2", passes: false, title: "open" },
        { id: "US-3", title: "no passes field at all" },
      ],
    });
    write("prd.archive.json", { userStories: [{ id: "US-0", passes: true }] });

    expect(run().ok).toBe(true);
    // A missing `passes` is not the same claim as `passes: false`, but neither
    // is a finished story — an unfinished story must never leave the backlog.
    expect(ids(read("prd.json"))).toEqual(["US-2", "US-3"]);
    expect(ids(read("prd.archive.json"))).toEqual(["US-0", "US-1"]);
  });

  it("keeps nextId untouched, because new ids come from it and not from max(id)", () => {
    write("prd.json", {
      nextId: "US-500",
      userStories: [{ id: "US-499", passes: true }],
    });
    write("prd.archive.json", { userStories: [] });

    expect(run().ok).toBe(true);
    // The archived story now holds the highest id in the project. If nextId
    // ever drifted to follow the backlog, the next story filed would reuse it.
    expect(read("prd.json").nextId).toBe("US-500");
  });

  it("is a no-op when nothing is finished, so closing back-to-back is free", () => {
    write("prd.json", { nextId: "US-9", userStories: [{ id: "US-1", passes: false }] });
    write("prd.archive.json", { userStories: [] });

    const first = run();
    expect(first.ok).toBe(true);
    expect(first.out).toContain("nothing to archive");
    expect(ids(read("prd.json"))).toEqual(["US-1"]);
  });

  it("REFUSES a duplicate id instead of overwriting the archived copy", () => {
    // This is the concurrency failure the inline archiving can produce: an agent
    // holding a stale prd.json writes a story back after it was archived. It has
    // to be loud — the two copies have different notes and only a person can say
    // which is real.
    write("prd.json", { nextId: "US-9", userStories: [{ id: "US-1", passes: true, notes: "b" }] });
    write("prd.archive.json", { userStories: [{ id: "US-1", passes: true, notes: "a" }] });

    const res = run();
    expect(res.ok).toBe(false);
    expect(res.out).toContain("US-1");
    // Neither file was touched, so nothing has to be reconstructed.
    expect(read("prd.archive.json").userStories[0].notes).toBe("a");
    expect(ids(read("prd.json"))).toEqual(["US-1"]);
  });

  it("refuses a file that is not a backlog rather than treating it as empty", () => {
    write("prd.json", { nextId: "US-9", stories: [] });
    write("prd.archive.json", { userStories: [] });

    const res = run();
    expect(res.ok).toBe(false);
    expect(res.out).toContain("no userStories array");
  });

  it("--dry-run reports the move and writes nothing", () => {
    write("prd.json", { nextId: "US-9", userStories: [{ id: "US-1", passes: true }] });
    write("prd.archive.json", { userStories: [] });

    const res = run("--dry-run");
    expect(res.ok).toBe(true);
    expect(res.out).toContain("nothing written");
    expect(ids(read("prd.json"))).toEqual(["US-1"]);
    expect(ids(read("prd.archive.json"))).toEqual([]);
  });
});
