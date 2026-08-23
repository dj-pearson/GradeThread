import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { actionable } from "../../scripts/prd-operator.mjs";

// The inverse of the operator queue: what can be picked up right now.
//
// This query kept getting hand-rolled, in one session after another, and kept
// being wrong in the same two ways. Both are pinned below with the real story
// ids that caused them, because a synthetic fixture would not have found either.

interface Story {
  id: string;
  passes?: boolean;
  title: string;
  priority?: number;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  notes?: string;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("actionable: the naive version and why it is wrong", () => {
  it("lists an open story with no operator step", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Buildable", acceptanceCriteria: ["Do the thing"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-1"]);
  });

  it("drops a story that declares its own operator step", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Needs a person", acceptanceCriteria: ["OPERATOR: click it"] },
    ];
    expect(actionable(stories)).toEqual([]);
  });

  it("drops a closed story", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Done", passes: true, acceptanceCriteria: ["Do the thing"] },
    ];
    expect(actionable(stories)).toEqual([]);
  });

  it("drops a story blocked behind a dependency that needs a person", () => {
    // THE FIRST REASON THE HAND-ROLLED QUERY WAS WRONG. US-2710 through
    // US-2713 each have clean criteria and are each blocked behind US-2709's
    // question to counsel. A story you cannot start is not actionable because
    // its own criteria look tidy.
    const stories: Story[] = [
      { id: "US-2709", title: "Spike", acceptanceCriteria: ["OPERATOR: ask counsel"] },
      { id: "US-2710", title: "Child", acceptanceCriteria: ["Build it"], dependsOn: ["US-2709"] },
    ];
    expect(ids(actionable(stories))).toEqual([]);
  });

  it("follows the dependency chain more than one hop", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Blocked at the root", acceptanceCriteria: ["OPERATOR: do it"] },
      { id: "US-2", title: "Middle", acceptanceCriteria: ["Build"], dependsOn: ["US-1"] },
      { id: "US-3", title: "Leaf", acceptanceCriteria: ["Build"], dependsOn: ["US-2"] },
    ];
    expect(ids(actionable(stories))).toEqual([]);
  });

  it("drops a story whose TITLE carries the operator tag", () => {
    // THE SECOND REASON, and the more expensive one. US-9127, US-1421, US-2380
    // and US-1582 carry [OPERATOR] in the title with no matching criterion —
    // `collect` already reports them as "title tag only, no sentence to quote".
    // Reading only the criteria offered all four as ready to pick up, which
    // sends a session to open a story whose FIRST LINE says a person is needed.
    const stories: Story[] = [
      { id: "US-1", title: "[OPERATOR] Approve the scope", acceptanceCriteria: ["Flip the flag"] },
      { id: "US-2", title: "[PARKED] Waiting on a market", acceptanceCriteria: ["Build"] },
      { id: "US-3", title: "[owner] lowercase counts too", acceptanceCriteria: ["Build"] },
    ];
    expect(actionable(stories)).toEqual([]);
  });

  it("does not treat a tag in the MIDDLE of a title as a blocker", () => {
    // The tag is a prefix convention. A title that merely mentions the word is
    // not a declaration, and over-matching here would hide real work.
    const stories: Story[] = [
      { id: "US-1", title: "Make the OPERATOR queue readable", acceptanceCriteria: ["Build"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-1"]);
  });
});

describe("actionable: dependencies that block nothing", () => {
  it("a CLOSED dependency does not block", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Done", passes: true, acceptanceCriteria: ["OPERATOR: did it"] },
      { id: "US-2", title: "Now free", acceptanceCriteria: ["Build"], dependsOn: ["US-1"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-2"]);
  });

  it("a MISSING dependency does not block", () => {
    // Same treatment namedByCount gives a dangling id. A typo in dependsOn must
    // not silently freeze a story forever.
    const stories: Story[] = [
      { id: "US-2", title: "Free", acceptanceCriteria: ["Build"], dependsOn: ["US-9999"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-2"]);
  });

  it("an open dependency with NO operator step does not block", () => {
    const stories: Story[] = [
      { id: "US-1", title: "Also buildable", acceptanceCriteria: ["Build"] },
      { id: "US-2", title: "Depends on it", acceptanceCriteria: ["Build"], dependsOn: ["US-1"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-1", "US-2"]);
  });

  it("a dependency CYCLE terminates instead of recursing forever", () => {
    const stories: Story[] = [
      { id: "US-1", title: "A", acceptanceCriteria: ["Build"], dependsOn: ["US-2"] },
      { id: "US-2", title: "B", acceptanceCriteria: ["Build"], dependsOn: ["US-1"] },
    ];
    expect(ids(actionable(stories))).toEqual(["US-1", "US-2"]);
  });

  it("a cycle that reaches an operator story still blocks", () => {
    // The cycle must not become an escape hatch out of a real blocker.
    const stories: Story[] = [
      { id: "US-0", title: "Root", acceptanceCriteria: ["OPERATOR: do it"] },
      { id: "US-1", title: "A", acceptanceCriteria: ["Build"], dependsOn: ["US-2"] },
      { id: "US-2", title: "B", acceptanceCriteria: ["Build"], dependsOn: ["US-1", "US-0"] },
    ];
    expect(actionable(stories)).toEqual([]);
  });
});

describe("actionable: against the real backlog", () => {
  it("returns fewer stories than the naive no-operator-criterion count", () => {
    // Guards the guard, and the claim the whole function rests on: if the two
    // ever agree, either every blocker has been resolved or the dependency and
    // title-tag filters have stopped doing anything.
    const prd = JSON.parse(
      readFileSync(resolve(process.cwd(), "prd.json"), "utf8"),
    ) as { userStories: Story[] };
    const open = prd.userStories.filter((s) => !s.passes);
    expect(open.length).toBeGreaterThan(20);

    const naive = open.filter(
      (s) => !(s.acceptanceCriteria ?? []).some((a) => /^\s*OPERATOR\s*:/i.test(a)),
    );
    const real = actionable(prd.userStories);
    expect(real.length).toBeLessThan(naive.length);
    expect(real.length).toBeGreaterThan(0);
  });
});
