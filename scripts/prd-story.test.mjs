// Coverage for the generic prd.json editor (Node env — vitest.scripts.config.mjs).
// Fixtures are inline prd objects; nothing here touches the real prd.json.
import { describe, expect, it } from "vitest";
import {
  addCriteria,
  addNote,
  appendNote,
  BACKLOGS,
  createStory,
  markDone,
  parseArgs,
  parseIdNum,
  resolveBacklog,
} from "./prd-story.mjs";
// The operator queue's own matcher, imported rather than copied: if the
// convention changes there, the `ac` cases here redden instead of drifting.
import { DECLARED_RE } from "./prd-operator.mjs";

const story = (over = {}) => ({
  id: "US-1",
  title: "t",
  description: "d",
  acceptanceCriteria: ["a"],
  passes: false,
  ...over,
});
const prd = (userStories, nextId = "US-100") => ({ nextId, userStories });

describe("parseIdNum", () => {
  it("accepts both the US- string and the bare number", () => {
    expect(parseIdNum("US-2208")).toBe(2208);
    expect(parseIdNum(2208)).toBe(2208);
  });
});

describe("appendNote", () => {
  it("seeds an empty note without a leading separator", () => {
    expect(appendNote("", "first")).toBe("first");
    expect(appendNote(undefined, "first")).toBe("first");
  });
  it("appends as a new segment rather than overwriting", () => {
    // Segment ORDER is load-bearing: prd-lint resolves a DEFERRED marker only
    // via a closing token in the same-or-later segment.
    expect(appendNote("DEFERRED: waiting on eBay", "DONE 2026-07-27")).toBe(
      "DEFERRED: waiting on eBay | DONE 2026-07-27",
    );
  });
  it("is a no-op for an empty addition", () => {
    expect(appendNote("kept", "  ")).toBe("kept");
  });
});

describe("markDone", () => {
  it("flips passes and appends the note", () => {
    const p = prd([story({ id: "US-5", notes: "started" })]);
    markDone(p, ["US-5"], "DONE 2026-07-27.");
    expect(p.userStories[0].passes).toBe(true);
    expect(p.userStories[0].notes).toBe("started | DONE 2026-07-27.");
  });
  it("handles several ids at once", () => {
    const p = prd([story({ id: "US-5" }), story({ id: "US-6" })]);
    const { touched } = markDone(p, ["US-5", "US-6"], "");
    expect(touched).toEqual(["US-5", "US-6"]);
    expect(p.userStories.every((s) => s.passes)).toBe(true);
  });
  it("throws on an unknown id instead of silently doing nothing", () => {
    expect(() => markDone(prd([story()]), ["US-999"], "n")).toThrow(/not found/);
  });
});

describe("addNote", () => {
  it("appends without touching passes", () => {
    const p = prd([story({ id: "US-5", notes: "a" })]);
    addNote(p, "US-5", "b");
    expect(p.userStories[0].notes).toBe("a | b");
    expect(p.userStories[0].passes).toBe(false);
  });
  it("requires a note", () => {
    expect(() => addNote(prd([story()]), "US-1", "")).toThrow(/--note/);
  });
});

describe("createStory", () => {
  const valid = { title: "T", description: "D", acceptanceCriteria: ["AC"] };

  it("takes the id from nextId and bumps it, preserving the string form", () => {
    const p = prd([story()], "US-100");
    const { id } = createStory(p, valid);
    expect(id).toBe("US-100");
    expect(p.nextId).toBe("US-101");
    expect(p.userStories.at(-1)).toMatchObject({ id: "US-100", passes: false, ...valid });
  });

  it("preserves the numeric nextId form when that is what the file uses", () => {
    const p = prd([story()], 100);
    createStory(p, valid);
    expect(p.nextId).toBe(101);
  });

  it("attaches priority and dependsOn only when supplied", () => {
    const p = prd([story()]);
    createStory(p, valid);
    expect(p.userStories.at(-1)).not.toHaveProperty("priority");
    expect(p.userStories.at(-1)).not.toHaveProperty("dependsOn");
    const q = prd([story()]);
    createStory(q, { ...valid, priority: -5, dependsOn: ["US-1"] });
    expect(q.userStories.at(-1)).toMatchObject({ priority: -5, dependsOn: ["US-1"] });
  });

  it("requires the planning fields prd-lint demands on an open story", () => {
    expect(() => createStory(prd([story()]), { description: "d", acceptanceCriteria: ["a"] })).toThrow(/--title/);
    expect(() => createStory(prd([story()]), { title: "t", acceptanceCriteria: ["a"] })).toThrow(/--description/);
    expect(() => createStory(prd([story()]), { title: "t", description: "d", acceptanceCriteria: [] })).toThrow(/--ac/);
  });

  it("refuses to reuse an id when nextId has gone stale", () => {
    // The exact failure the nextId rule exists to prevent: a collision that
    // would otherwise produce two stories sharing one id.
    const p = prd([story({ id: "US-100" })], "US-100");
    expect(() => createStory(p, valid)).toThrow(/already exists/);
  });
});

describe("parseArgs", () => {
  it("splits positionals from flags", () => {
    const { positional, flags } = parseArgs(["done", "US-1", "--note", "hi"]);
    expect(positional).toEqual(["done", "US-1"]);
    expect(flags.note).toBe("hi");
  });
  it("collects repeated flags into an array", () => {
    const { flags } = parseArgs(["new", "--ac", "one", "--ac", "two"]);
    expect(flags.ac).toEqual(["one", "two"]);
  });
  it("treats a valueless trailing flag as a boolean", () => {
    expect(parseArgs(["show", "--json"]).flags.json).toBe(true);
  });
});

// `ac` — append acceptance criteria to an existing story.
//
// It exists for the operator queue. prd-operator.mjs reads criteria beginning
// `OPERATOR:`, so a story whose remaining work needs a person but says so only
// in prose is invisible to it, and the owner plans against a queue that is
// short by however many of those there are. Declaring one meant hand-editing a
// 0.27MB JSON file, which is the friction that kept them undeclared.
describe("ac: declaring work that needs a person", () => {
  const base = () => ({
    nextId: "US-900",
    userStories: [
      { id: "US-100", passes: false, title: "t", description: "d", acceptanceCriteria: ["one"] },
      { id: "US-101", passes: false, title: "t", description: "d" },
    ],
  });

  it("appends without touching what is already there", () => {
    const { prd } = addCriteria(base(), "US-100", ["OPERATOR: run the thing"]);
    const s = prd.userStories.find((x) => x.id === "US-100");
    expect(s.acceptanceCriteria).toEqual(["one", "OPERATOR: run the thing"]);
  });

  it("never rewrites an existing criterion", () => {
    // A story quietly changing what it promised, after the fact, by script.
    // That is a deliberate edit; this command only ever adds.
    const { prd } = addCriteria(base(), "US-100", ["two"]);
    expect(prd.userStories[0].acceptanceCriteria[0]).toBe("one");
  });

  it("is idempotent on an exact duplicate", () => {
    // Re-running a declaration pass must not grow the list every time.
    const first = addCriteria(base(), "US-100", ["OPERATOR: x"]);
    const second = addCriteria(first.prd, "US-100", ["OPERATOR: x"]);
    expect(second.added).toEqual([]);
    expect(second.prd.userStories[0].acceptanceCriteria).toHaveLength(2);
  });

  it("handles a story that has no acceptanceCriteria array yet", () => {
    const { prd } = addCriteria(base(), "US-101", ["OPERATOR: y"]);
    expect(prd.userStories[1].acceptanceCriteria).toEqual(["OPERATOR: y"]);
  });

  it("refuses an unknown story and an empty list", () => {
    expect(() => addCriteria(base(), "US-999", ["x"])).toThrow(/not found/);
    expect(() => addCriteria(base(), "US-100", [])).toThrow(/at least one/);
  });

  it("what it appends is what the operator queue recognises", () => {
    // The point of the command. Asserted against prd-operator's own regex
    // rather than a copy of it, so a change to the convention reddens here.
    const { prd } = addCriteria(base(), "US-100", ["OPERATOR: run the thing"]);
    const declared = prd.userStories[0].acceptanceCriteria.filter((a) => DECLARED_RE.test(a));
    expect(declared).toHaveLength(1);
  });
});

describe("resolveBacklog", () => {
  // The flag exists because `show US-9127` used to answer "story not found"
  // for a story that exists — it lives in prd-connector.json, which this
  // script could not read.

  it("defaults to the main backlog", () => {
    expect(resolveBacklog(undefined)).toBe(BACKLOGS.main);
    // `--backlog` with no value parses as boolean true; that is a bare flag,
    // not a request for a file named "true".
    expect(resolveBacklog(true)).toBe(BACKLOGS.main);
  });

  it("accepts the shorthand", () => {
    expect(resolveBacklog("connector")).toBe(BACKLOGS.connector);
    expect(resolveBacklog("seo")).toBe(BACKLOGS.seo);
    expect(resolveBacklog("main")).toBe(BACKLOGS.main);
  });

  it("accepts the filename, because both are things a person types", () => {
    expect(resolveBacklog("prd-connector.json")).toBe(BACKLOGS.connector);
    expect(resolveBacklog("prd-seo.json")).toBe(BACKLOGS.seo);
    expect(resolveBacklog("prd.json")).toBe(BACKLOGS.main);
  });

  it("trims, because a shell quote leaves whitespace", () => {
    expect(resolveBacklog("  connector  ")).toBe(BACKLOGS.connector);
  });

  it("THROWS on anything else rather than falling back to main", () => {
    // The one failure mode worse than not having the flag: a typo silently
    // editing the main backlog. The message names the options.
    expect(() => resolveBacklog("nope")).toThrow(/unknown --backlog/);
    expect(() => resolveBacklog("nope")).toThrow(/main, connector, seo/);
    expect(() => resolveBacklog("prd.archive.json")).toThrow(/unknown --backlog/);
    expect(() => resolveBacklog("../../etc/passwd")).toThrow(/unknown --backlog/);
  });

  it("every registered backlog is a distinct sibling path", () => {
    const paths = Object.values(BACKLOGS);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(p.startsWith("../")).toBe(true);
      expect(p.includes("/", 3)).toBe(false); // no nesting, no traversal
    }
  });
});
