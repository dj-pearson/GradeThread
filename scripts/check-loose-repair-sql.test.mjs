// US-2832: the guard that stops the next prod repair going unrecorded.
//
// This file is picked up by vitest.scripts.config.mjs (`scripts/**/*.test.mjs`),
// which runs in `npm run verify` and in CI's `test:scripts` step. No workflow or
// verify.mjs change is needed for it to gate.
//
// It asserts three separate things, and the second and third are the ones that
// matter. Running the sabotage cases proves the RULE works. Running against the
// real PENDING_MIGRATIONS.md proves the corpus is clean. Sabotaging the REAL
// document proves the guard fires on it rather than only on fixtures it was
// written to pass - which is the precise way `held-migration-gate.mjs` sat green
// for weeks while the document it read had drifted out of its grammar.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CORPUS,
  SELF_TEST_CASES,
  SELF_TEST_KNOWN,
  auditFiles,
  auditText,
  fencedBlocks,
  knownMigrationVersions,
  mutatingStatements,
  versionsIn,
} from "./check-loose-repair-sql.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PENDING = path.join(REPO, "PENDING_MIGRATIONS.md");

describe("check-loose-repair-sql: the rule", () => {
  it("carries every sabotage case the CLI self-test runs", () => {
    // A deleted case would otherwise shrink coverage silently, and the suite
    // would still be green.
    expect(SELF_TEST_CASES.length).toBeGreaterThanOrEqual(14);
    const kinds = new Set(SELF_TEST_CASES.flatMap(([, , want]) => want));
    expect([...kinds].sort()).toEqual(["loose-sql", "no-heading", "unresolved-version"]);
  });

  for (const [label, markdown, want] of SELF_TEST_CASES) {
    it(label, () => {
      const got = auditText(markdown, { file: "case.md", known: SELF_TEST_KNOWN })
        .map((f) => f.kind)
        .sort();
      expect(got).toEqual([...want].sort());
    });
  }

  it("parses a version out of the NNNNN_name.sql heading form", () => {
    // `\b\d{5}\b` does NOT, because an underscore is a word character. The first
    // cut of this guard used it and reported two correctly-attributed sections
    // of the live document as loose repairs.
    expect(versionsIn("## APPLIED: 00601_cancellation_requested_notification.sql (US-2560)")).toContain("00601");
    expect(versionsIn("## APPLIED 2026-08-20: 00627 - sweep bookkeeping")).toContain("00627");
    expect(versionsIn("## Repair 20260820")).toEqual([]);
  });

  it("reads a fence with no language tag", () => {
    // The live 00727 section opens with a bare ```; a ```sql-only scan misses it.
    const blocks = fencedBlocks("## h\n\n```\nALTER TABLE public.x ADD COLUMN y int;\n```\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("");
    expect(mutatingStatements(blocks[0].body)).toEqual(["alter table"]);
  });
});

describe("check-loose-repair-sql: the real corpus", () => {
  it("has schema-mutating blocks for the rule to bite on", () => {
    // Anti-vacuous. A clean report from an empty corpus reads identically to a
    // clean report from a corpus the guard actually inspected.
    const { blocks, scanned } = auditFiles(DEFAULT_CORPUS);
    expect(scanned).toBeGreaterThanOrEqual(2);
    expect(blocks).toBeGreaterThanOrEqual(4);
  });

  it("attributes every one of them to a migration file that exists", () => {
    const { findings } = auditFiles(DEFAULT_CORPUS);
    const rendered = findings.map((f) => `${f.where} [${f.kind}] ${f.heading ?? ""}`);
    expect(rendered).toEqual([]);
  });

  it("goes RED when a real heading loses its migration number", () => {
    // Sabotage the document itself, not a fixture. Strip the version out of the
    // heading above the first mutating block and the guard must report it.
    const text = readFileSync(PENDING, "utf8");
    const known = knownMigrationVersions();
    expect(auditText(text, { file: "PENDING_MIGRATIONS.md", known })).toEqual([]);

    const lines = text.split(/\r?\n/);
    const first = fencedBlocks(text).find((b) => mutatingStatements(b.body).length > 0);
    expect(first, "PENDING_MIGRATIONS.md has no mutating fenced block to sabotage").toBeTruthy();
    let headingIdx = -1;
    for (let i = first.startLine - 2; i >= 0; i--) {
      if (/^#{1,6}\s/.test(lines[i])) {
        headingIdx = i;
        break;
      }
    }
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    lines[headingIdx] = lines[headingIdx].replace(/\d{5}/g, "NNNNN");
    const sabotaged = auditText(lines.join("\n"), { file: "PENDING_MIGRATIONS.md", known });
    expect(sabotaged.map((f) => f.kind)).toContain("loose-sql");
  });

  it("goes RED when a real heading cites a migration that does not exist", () => {
    const text = readFileSync(PENDING, "utf8");
    const known = knownMigrationVersions();
    const lines = text.split(/\r?\n/);
    const first = fencedBlocks(text).find((b) => mutatingStatements(b.body).length > 0);
    let headingIdx = -1;
    for (let i = first.startLine - 2; i >= 0; i--) {
      if (/^#{1,6}\s/.test(lines[i])) {
        headingIdx = i;
        break;
      }
    }
    lines[headingIdx] = lines[headingIdx].replace(/\d{5}/g, "09999");
    const sabotaged = auditText(lines.join("\n"), { file: "PENDING_MIGRATIONS.md", known });
    expect(sabotaged.map((f) => f.kind)).toContain("unresolved-version");
    expect(known.has("09999")).toBe(false);
  });

  it("knows the migration set it resolves against", () => {
    const known = knownMigrationVersions();
    expect(known.size).toBeGreaterThan(600);
    // 00660 is this story's own migration: the durable record of the
    // listings.draft_id repair that used to exist only as pasted SQL.
    expect(known.has("00660")).toBe(true);
    expect(known.has("00134")).toBe(true);
  });
});
