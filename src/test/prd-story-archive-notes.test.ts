import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Closing a story does not end the need to correct its record.
//
// US-2802's AC5 had to fix US-1283's closure and did it by hand. US-2796 closed
// on 2026-08-23 saying its AC3 was met, and it was met on one of two paths, with
// nowhere to record the other — prd-story.mjs could not write to
// prd.archive.json, so a correction to a finished story lived only in a commit
// message, which is not where the next reader of that story looks.
//
// `--backlog archive` now accepts `note` and `show`, and REFUSES everything
// else. This asserts the refusals by RUNNING the script, not by reading its
// exported constants: the guard lives inside main(), so a test over BACKLOGS and
// NOTE_ONLY_BACKLOGS would pass with the check deleted. That is the shape this
// repo keeps writing guards about.

const SCRIPT = resolve(process.cwd(), "scripts/prd-story.mjs");

/** Run prd-story and capture what a person would see. */
function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("a closed story can still be corrected", () => {
  it("refuses every command but note and show on the archive", () => {
    // Each refusal must NAME why, because "not allowed" sends the next person
    // looking for a workaround rather than for `note`.
    for (const [cmd, extra, because] of [
      ["done", ["US-2796", "--note", "x"], "already closed"],
      ["new", ["--title", "t", "--description", "d", "--ac", "a"], "mint an id"],
      ["ac", ["US-2796", "--ac", "x"], "criteria"],
    ] as const) {
      const { code, out } = run([cmd, ...extra, "--backlog", "archive"]);
      expect(code, `${cmd} should have failed`).not.toBe(0);
      expect(out).toContain("accepts only");
      expect(out.toLowerCase(), `${cmd}'s refusal does not say why`).toContain(because);
    }
  });

  it("a bad --backlog still refuses rather than editing the main one", () => {
    // The pre-existing rule, re-asserted because adding a fourth backlog is
    // exactly when a typo becomes likelier. Silently writing prd.json would be
    // worse than not having the flag.
    const { code, out } = run(["show", "US-2796", "--backlog", "archiv"]);
    expect(code).not.toBe(0);
    expect(out).toContain("unknown --backlog");
  });

  it("show reads the archive without being told to", () => {
    const { code, out } = run(["show", "US-2796"]);
    expect(code).toBe(0);
    expect(out).toContain("US-2796");
  });

  it("the archive round-trips through the serializer, so a note is a one-line diff", () => {
    // The reason writing to a 7.8 MB file is safe at all. If this stops holding,
    // appending one note reformats the whole archive and the diff becomes
    // unreviewable — which is the point at which this feature should be removed
    // rather than tolerated.
    const raw = readFileSync(resolve(process.cwd(), "prd.archive.json"), "utf8");
    const round = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    expect(round).toEqual(raw);
  });
});
