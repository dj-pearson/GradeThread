// Every Ralph topic log must be reachable from BOTH places that point at them.
//
// WHY THIS EXISTS. The topic logs were split out of ralph-learnings.md so the
// always-read file would stay cheap. The split works only if a loop that needs
// the detail can still find it in one hop — otherwise the knowledge is not
// "moved", it is buried.
//
// It had already rotted once. The pointer section in ralph-learnings.md listed
// `learnings/ios.md`, `learnings/brand-kb.md` and `learnings/email-marketing.md`.
// Those paths never existed: the files landed as `ralph-*-log.md` siblings in
// 70-agent/. So for months the section promising a one-hop route handed the
// reader three dead ends, and nothing went red — prose has no compiler. Found
// 2026-08-09 while splitting four more sections out under US-2445.
//
// Two lists, both hand-written, are exactly the shape ralph-learnings.md's own
// "a hand-written list is a list that goes stale" section warns about. This
// derives the truth from the filesystem instead and fails when either copy
// falls behind.
//
// Note the asymmetry: vault-lint already proves a [[wiki-link]] resolves, so
// ralph-learnings.md's half is half-guarded — a link to a note that does not
// exist is caught. What NEITHER checks is the other direction, a log nobody
// links, and that is the direction the rot went. scripts/ralph/CLAUDE.md is not
// a vault note at all, so its list has never been checked in either direction.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Every topic log on disk, derived — never listed by hand. */
function topicLogs(): string[] {
  return readdirSync(resolve(root, "vault/70-agent"))
    .filter((f) => f.startsWith("ralph-") && f.endsWith("-log.md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

describe("Ralph topic logs stay reachable", () => {
  it("finds the logs at all", () => {
    // Guards the guard: a discovery that matched nothing would pass every
    // assertion below while proving nothing, which is how a check quietly
    // becomes decorative.
    expect(topicLogs().length).toBeGreaterThanOrEqual(4);
  });

  it("ralph-learnings.md links every one of them", () => {
    const doc = read("vault/70-agent/ralph-learnings.md");
    const missing = topicLogs().filter((n) => !doc.includes(`[[${n}]]`));
    expect(missing, `not linked from ralph-learnings.md: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("the Ralph loop prompt names every one of them", () => {
    // The prompt is what an iteration actually reads. A log linked only from
    // the vault is one the loop never learns exists.
    const doc = read("scripts/ralph/CLAUDE.md");
    const missing = topicLogs().filter(
      (n) => !doc.includes(`vault/70-agent/${n}.md`),
    );
    expect(missing, `not named in scripts/ralph/CLAUDE.md: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("neither pointer names a log that does not exist", () => {
    // The failure that actually happened, stated as an assertion. Paths are
    // read out of both documents and checked against the filesystem, so a
    // rename breaks the build instead of silently stranding a reader.
    const known = new Set(topicLogs());
    const cited = new Set<string>();
    for (const p of ["vault/70-agent/ralph-learnings.md", "scripts/ralph/CLAUDE.md"]) {
      for (const m of read(p).matchAll(/(?:70-agent\/|\[\[)(ralph-[a-z0-9-]*-log)/g)) {
        if (m[1]) cited.add(m[1]);
      }
      for (const m of read(p).matchAll(/`?learnings\/([a-z-]+)\.md`?/g)) {
        if (m[1]) cited.add(`learnings/${m[1]}`);
      }
    }
    const dangling = [...cited].filter((n) => !known.has(n)).sort();
    expect(dangling, `pointer to a topic log that does not exist: ${dangling.join(", ")}`)
      .toEqual([]);
  });
});
