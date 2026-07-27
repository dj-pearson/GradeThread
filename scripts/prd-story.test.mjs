// Coverage for the generic prd.json editor (Node env — vitest.scripts.config.mjs).
// Fixtures are inline prd objects; nothing here touches the real prd.json.
import { describe, expect, it } from "vitest";
import { addNote, appendNote, createStory, markDone, parseArgs, parseIdNum } from "./prd-story.mjs";

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
