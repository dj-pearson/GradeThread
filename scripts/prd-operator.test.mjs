// The operator queue's SATISFIED marker.
//
// WHY THE MARKER EXISTS. The queue lists what a person still has to do, and it
// reads ACCEPTANCE CRITERIA. Notes already record that a step was done, but the
// criterion text does not change — so a finished operator item kept reappearing
// at the top of "START HERE" with five other stories named as waiting on it.
// A list with finished items on it stops being read, which is the same failure
// that let a CI lane sit red for three weeks.
//
// It requires a DATE on purpose: "SATISFIED" alone is a claim, "SATISFIED
// 2026-08-17" is a claim with a when. And satisfied items are COUNTED rather
// than dropped — an item that vanishes without trace is indistinguishable from
// one nobody ever wrote down.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collect,
  DECLARED_RE,
  groupBySession,
  SATISFIED_RE,
  SESSION_KINDS,
} from "./prd-operator.mjs";

const story = (id, acs) => ({
  id,
  passes: false,
  title: `story ${id}`,
  acceptanceCriteria: acs,
  notes: "",
});

describe("SATISFIED marker", () => {
  it("requires a date, so a bare claim still counts as work", () => {
    expect(SATISFIED_RE.test("OPERATOR: do the thing — SATISFIED 2026-08-17: proof")).toBe(true);
    expect(SATISFIED_RE.test("OPERATOR: do the thing — SATISFIED")).toBe(false);
    expect(SATISFIED_RE.test("OPERATOR: do the thing — satisfied soon")).toBe(false);
  });

  it("drops the satisfied item from the queue and counts it", () => {
    const r = collect([
      story("US-1", [
        "OPERATOR: still to do",
        "OPERATOR: already done — SATISFIED 2026-08-17: measured",
      ]),
    ]);
    expect(r.satisfied).toBe(1);
    expect(r.declared).toHaveLength(1);
    expect(r.declared[0].items).toEqual(["OPERATOR: still to do"]);
  });

  it("a story whose ONLY operator item is satisfied leaves the declared list", () => {
    // The case that matters: the story stops being an operator row at all
    // rather than showing up with an empty item list.
    const r = collect([
      story("US-2", ["OPERATOR: done — SATISFIED 2026-08-17: proof"]),
    ]);
    expect(r.satisfied).toBe(1);
    expect(r.declared.find((d) => d.id === "US-2")).toBeUndefined();
  });

  it("does not touch an unsatisfied queue", () => {
    const r = collect([story("US-3", ["OPERATOR: rotate the key"])]);
    expect(r.satisfied).toBe(0);
    expect(r.declared[0].items).toHaveLength(1);
  });

  it("still recognises the criterion as declared operator work", () => {
    // The marker is a suffix, not a replacement: the text must keep its
    // OPERATOR: prefix so a reader (and any other consumer) still sees what it
    // was, and so removing the marker restores it to the queue.
    const ac = "OPERATOR: read the health line — SATISFIED 2026-08-17: proof";
    expect(DECLARED_RE.test(ac)).toBe(true);
  });

  it("a satisfied story is not silently reclassified as undeclared", () => {
    // Without care, filtering the ACs to empty would fall through to the
    // prose-scanning branch and re-list the story from a note sentence — the
    // same row back under a weaker heading.
    const s = story("US-4", ["OPERATOR: done — SATISFIED 2026-08-17: proof"]);
    s.notes = "This is operator work and cannot be done from here.";
    const r = collect([s]);
    expect(r.declared.find((d) => d.id === "US-4")).toBeUndefined();
    expect(r.undeclared.find((d) => d.id === "US-4")).toBeUndefined();
  });
});

describe("the marker is documented where it is used", () => {
  it("prd-operator.mjs explains the convention", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/prd-operator.mjs"), "utf8");
    expect(src).toContain("SATISFIED_RE");
    // The count must be reported, not just computed.
    expect(src).toMatch(/marked SATISFIED with a date/);
  });
});

// ── --sessions: grouping the queue into sittings ──────────────────────
//
// The queue already RANKS by how many stories name each item, which answers
// "what is most worth doing". It does not answer "what can I do in one sitting",
// and that is what governs throughput: 82 items are not 82 errands, they are a
// handful of sessions. The invariant below is the one that matters — a grouping
// that silently loses an item is worse than no grouping, because the queue's
// whole purpose is that nothing gets forgotten again.
describe("groupBySession", () => {
  const decl = (id, text) => ({ id, priority: 5, title: id, items: [text] });
  const undecl = (id, text) => ({ id, priority: 5, title: id, evidence: [text] });

  const total = (groups) => [...groups.values()].reduce((n, rows) => n + rows.length, 0);

  it("keeps every item, including ones it cannot classify", () => {
    const declared = [
      decl("US-1", "run section 12 of prod-diagnostics against prod"),
      decl("US-2", "set GIT_SHA in Coolify"),
      decl("US-3", "xyzzy, a phrase matching nothing at all"),
    ];
    const undeclared = [undecl("US-4", "drive it with a screen reader")];
    const groups = groupBySession(declared, undeclared);
    expect(total(groups)).toBe(4);
    const ids = [...groups.values()].flat().map((r) => r.id).sort();
    expect(ids).toEqual(["US-1", "US-2", "US-3", "US-4"]);
  });

  it("puts an unmatched item in unclassified rather than dropping it", () => {
    const groups = groupBySession([decl("US-9", "xyzzy plugh")], []);
    expect(groups.get("unclassified").map((r) => r.id)).toEqual(["US-9"]);
  });

  it("gives each item exactly one home", () => {
    // This text matches BOTH the sql and the config patterns. An item in two
    // sessions gets done twice or zero times, so first-match-wins is the rule
    // and SESSION_KINDS order is the tie-break.
    const groups = groupBySession(
      [decl("US-5", "run a SELECT in the Coolify console against prod")],
      [],
    );
    const homes = [...groups.entries()].filter(([, rows]) => rows.some((r) => r.id === "US-5"));
    expect(homes).toHaveLength(1);
    expect(homes[0][0]).toBe("sql");
  });

  it("orders the sessions so each one's result survives the next", () => {
    // Config before deploy: the settings only take effect on a rebuild. Deploy
    // before the device/verification work: a drill run against an unidentifiable
    // build answers nothing. The order is the advice, so it is pinned.
    const keys = SESSION_KINDS.map((k) => k.key);
    expect(keys.indexOf("config")).toBeLessThan(keys.indexOf("deploy"));
    expect(keys.indexOf("sql")).toBeLessThan(keys.indexOf("config"));
    expect(keys.indexOf("deploy")).toBeLessThan(keys.indexOf("device"));
  });

  it("every session states what it is and how to start it", () => {
    for (const k of SESSION_KINDS) {
      expect(k.title.length, `${k.key}: needs a title`).toBeGreaterThan(10);
      expect(k.hint.length, `${k.key}: a session without a hint is just a label`)
        .toBeGreaterThan(40);
    }
  });
});

describe("session patterns are real regexes, not text that looks like one", () => {
  // WHY THIS EXISTS, and it is a trap this repo already documents. These
  // patterns were extended through an inline shell heredoc, which ATE a
  // backslash: every `\\b` was written to the file as U+0008, a real backspace
  // control character. The source still LOOKED right in an editor and in grep,
  // `node -c` passed, the module imported fine — and a regex whose source
  // reads /(counsel|...)/i returned false for the string "counsel".
  //
  // CLAUDE.md forbids invisible characters in source for exactly this reason.
  // A guard that reads the file is the only thing that sees them.
  it("no session pattern contains a control character", () => {
    for (const kind of SESSION_KINDS) {
      const bad = [...kind.match.source].filter((c) => c.charCodeAt(0) < 32);
      expect(
        bad.map((c) => c.charCodeAt(0)),
        `${kind.key}: control character in the pattern — a backslash was eaten somewhere`,
      ).toEqual([]);
    }
  });

  it("every pattern actually matches a phrase it is supposed to match", () => {
    // A pattern that matches nothing is indistinguishable from a missing one,
    // and that is precisely the state the backspace bug produced.
    const probes = {
      sql: "run the query against prod",
      config: "set it in the Coolify dashboard",
      deploy: "after deploy, confirm it answers 200",
      thirdparty: "App Store Connect",
      command: "node scripts/seed-help-articles.mjs",
      device: "needs a screen reader",
      counsel: "counsel has to write it",
      sourcing: "source licensed reference imagery",
      host: "full-disk encryption on the box",
    };
    for (const kind of SESSION_KINDS) {
      const probe = probes[kind.key];
      expect(probe, `no probe for session kind ${kind.key} — add one`).toBeTruthy();
      expect(kind.match.test(probe), `${kind.key} does not match its own probe`).toBe(true);
    }
  });

  it("the sittings are numbered in the order they are listed", () => {
    // The array order IS the running order, so a title numbered out of sequence
    // tells the operator to do them in an order the tool will not print.
    const numbers = SESSION_KINDS.map((k) => Number(String(k.title).match(/^(\\d+)\\./)?.[1]));
    expect(numbers, "every session title starts with its number").not.toContain(undefined);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});
