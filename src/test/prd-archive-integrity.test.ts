// US-2366: the backlog split stays honest.
//
// prd.json is the ACTIVE backlog and prd.archive.json is the completed history.
// The split exists so the active file stays small — every session loads it, and
// the archive is 4.5 MB. Two things can go wrong, and both are quiet:
//
//   1. completed stories accumulate in prd.json, which is the drift this story
//      was filed for (27 had piled up);
//   2. `nextId` falls behind an id that already exists. CLAUDE.md is explicit
//      that new stories take `prd.json.nextId` and NEVER max(id)+1, precisely
//      because the high-id done stories live in the archive — so a stale nextId
//      hands out an id that is already taken, and the collision surfaces later
//      as two stories with the same name.
//
// The archive itself is deliberately NOT parsed for content here: it is large,
// and this only needs its ids.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Story {
  id: string;
  passes?: boolean;
}
interface Backlog {
  nextId?: string;
  userStories: Story[];
}

const read = (p: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8")) as Backlog;

const prd = read("prd.json");
const archive = read("prd.archive.json");

const num = (id: string) => Number(String(id).replace("US-", ""));

describe("US-2366: prd.json holds only the active backlog", () => {
  it("no completed story is left in the active file", () => {
    const done = prd.userStories.filter((s) => s.passes === true).map((s) => s.id);
    expect(
      done,
      "these are finished and belong in prd.archive.json — run " +
        "`node scripts/archive-passing-stories.mjs`. Every session loads this " +
        "file, so completed stories are a cost paid on every run.",
    ).toEqual([]);
  });

  it("the archive holds only completed stories", () => {
    // The other direction: an OPEN story moved into the archive disappears from
    // the backlog silently, which is worse than a completed one lingering.
    const open = archive.userStories.filter((s) => s.passes !== true).map((s) => s.id);
    expect(open, "these are unfinished and were archived anyway").toEqual([]);
  });

  it("no id appears in both files", () => {
    const inArchive = new Set(archive.userStories.map((s) => s.id));
    const both = prd.userStories.filter((s) => inArchive.has(s.id)).map((s) => s.id);
    expect(
      both,
      "a story in both files means one copy's notes are about to be lost",
    ).toEqual([]);
  });

  it("nextId is ahead of every id that exists anywhere", () => {
    const highest = Math.max(
      ...[...prd.userStories, ...archive.userStories]
        .map((s) => num(s.id))
        .filter(Number.isFinite),
    );
    expect(prd.nextId, "prd.json has no nextId").toBeTruthy();
    expect(
      num(prd.nextId!),
      `nextId ${prd.nextId} would reuse an id that already exists (highest is ` +
        `US-${highest}). This is why CLAUDE.md says never to use max(id)+1 on ` +
        `prd.json alone — the high ids are in the archive.`,
    ).toBeGreaterThan(highest);
  });

  it("both files actually contain stories, so an empty parse cannot pass", () => {
    // Guards the guard: every assertion above is trivially true against an
    // empty array, and a truncated write is exactly how one would appear.
    expect(prd.userStories.length).toBeGreaterThan(50);
    expect(archive.userStories.length).toBeGreaterThan(1000);
  });
});
