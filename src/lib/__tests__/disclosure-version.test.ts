// US-2117 AC1: the disclosure-copy version, and the thing that makes it worth
// recording.
//
// subscription_agreements.disclosure_version is a pointer on an IMMUTABLE
// compliance row. Its whole value is that it resolves to the words a subscriber
// actually saw. A hand-maintained version constant does not do that — it drifts
// the first time someone edits a sentence and does not think about the number,
// and a pointer aimed at the wrong words is a FALSE record, which is worse than
// the null column it replaced.
//
// So this test does not check that a version exists. It re-derives the copy from
// the source and refuses to let the two disagree.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DISCLOSURE_ARCHIVE,
  DISCLOSURE_VERSION,
  KNOWN_DISCLOSURE_VERSIONS,
} from "../auto-renewal-copy";

const REPO_ROOT = resolve(__dirname, "../../..");
const COPY_SRC = readFileSync(
  resolve(REPO_ROOT, "src/lib/auto-renewal-copy.ts"),
  "utf8",
);
const EDGE_VERSIONS_SRC = readFileSync(
  resolve(REPO_ROOT, "services/edge-functions/src/lib/disclosure-versions.ts"),
  "utf8",
);

/** The archived copy for a version, or a loud failure. Never a silent empty. */
function archived(version: string): readonly string[] {
  const entry = DISCLOSURE_ARCHIVE[version];
  if (!entry) throw new Error(`DISCLOSURE_ARCHIVE has no entry for "${version}"`);
  return entry;
}

/**
 * Every sentence disclosureSentences() can emit, as written in the source.
 *
 * Read off the source rather than by calling the function, because calling it
 * only reaches the branches the caller thought to exercise — and the branch
 * nobody thought of is exactly the one whose wording would change unnoticed.
 */
function templatesInSource(): string[] {
  const fnStart = COPY_SRC.indexOf("export function disclosureSentences");
  expect(fnStart, "disclosureSentences was renamed or removed").toBeGreaterThan(-1);
  const body = COPY_SRC.slice(fnStart);
  const out: string[] = [];
  // Each push carries exactly one string or template literal. Template literals
  // contain ${...} but never a nested backtick, so this stays unambiguous.
  const re = /sentences\.push\(\s*(`[^`]*`|"[^"]*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const literal = m[1];
    if (literal) out.push(literal.slice(1, -1));
  }
  return out;
}

describe("US-2117: the disclosure version tracks the disclosure", () => {
  it("the current version resolves to an archive entry", () => {
    expect(Object.keys(DISCLOSURE_ARCHIVE)).toContain(DISCLOSURE_VERSION);
  });

  it("the scan finds sentences at all (an empty scan would pass everything)", () => {
    expect(templatesInSource().length).toBeGreaterThanOrEqual(5);
  });

  it("every sentence in the source matches the archived version, exactly", () => {
    // THE LOAD-BEARING ASSERTION. Change a word in disclosureSentences without
    // bumping DISCLOSURE_VERSION and appending a new archive entry, and this
    // goes red. Order is compared too: the archive is meant to be readable as
    // the copy, and a reordered list reads as different copy.
    expect(
      templatesInSource(),
      "The disclosure wording changed. Bump DISCLOSURE_VERSION and APPEND a new " +
        "DISCLOSURE_ARCHIVE entry — never edit an existing one, because a past " +
        "subscriber's agreement row points at it and rewriting it rewrites what " +
        "we claim they were shown.",
    ).toEqual([...archived(DISCLOSURE_VERSION)]);
  });

  it("no archived version is empty", () => {
    // An entry that exists but says nothing would satisfy the pointer while
    // resolving to no copy — the failure this whole file exists to prevent.
    for (const [version, sentences] of Object.entries(DISCLOSURE_ARCHIVE)) {
      expect(sentences.length, `archive entry ${version} is empty`).toBeGreaterThan(0);
      for (const s of sentences) expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it("KNOWN_DISCLOSURE_VERSIONS is derived from the archive, not written twice", () => {
    expect([...KNOWN_DISCLOSURE_VERSIONS].sort()).toEqual(
      Object.keys(DISCLOSURE_ARCHIVE).sort(),
    );
  });
});

describe("US-2117: the edge can resolve every version the web can render", () => {
  // The edge holds version IDS only — the wording lives here, once. But it
  // REFUSES to record a version it does not recognise, so a copy bump that
  // forgets the edge would silently strip the pointer off every agreement
  // written until someone noticed. This is the guard that stops that, and it
  // points the right way: the copy changes on the web side.
  it("every archived version is listed in the edge mirror", () => {
    for (const version of Object.keys(DISCLOSURE_ARCHIVE)) {
      expect(
        EDGE_VERSIONS_SRC,
        `services/edge-functions/src/lib/disclosure-versions.ts does not list ` +
          `"${version}". Add it to KNOWN_DISCLOSURE_VERSIONS in the SAME commit ` +
          `that adds the archive entry, or agreements made against this copy will ` +
          `be recorded with no disclosure pointer.`,
      ).toContain(`"${version}"`);
    }
  });

  it("the mirror is a set of ids and not a second copy of the wording", () => {
    // If the sentences ever get duplicated into the edge, they will drift — the
    // failure US-1995 documents, where two copies each had their own green suite.
    for (const sentence of archived(DISCLOSURE_VERSION)) {
      const distinctive = sentence.replace(/\$\{[^}]*\}/g, "").trim();
      if (distinctive.length < 12) continue;
      expect(
        EDGE_VERSIONS_SRC.includes(distinctive),
        `the edge mirror contains disclosure wording ("${distinctive}"). It must ` +
          `hold version ids only — two copies of the copy will drift.`,
      ).toBe(false);
    }
  });
});

describe("US-2117: the version is actually sent at purchase", () => {
  const HOOKS_SRC = readFileSync(
    resolve(REPO_ROOT, "src/hooks/use-billing-summary.ts"),
    "utf8",
  );

  it("both subscribe hooks report the version", () => {
    // Sent from the hooks rather than from each surface, so a new purchase
    // surface cannot forget. That only holds if BOTH hooks do it.
    const flipdesk = HOOKS_SRC.slice(HOOKS_SRC.indexOf("useFlipdeskSubscribe"));
    const buyer = HOOKS_SRC.slice(HOOKS_SRC.indexOf("useBuyerSubscribe"));
    expect(flipdesk).toContain("disclosureVersion: DISCLOSURE_VERSION");
    expect(buyer).toContain("disclosureVersion: DISCLOSURE_VERSION");
  });

  it("the version sent is the imported constant, not a literal", () => {
    // A literal would be a second place the version lives, and the one that
    // never gets bumped. Pin the import so it stays derived.
    expect(HOOKS_SRC).toMatch(
      /import\s*\{\s*DISCLOSURE_VERSION\s*\}\s*from\s*"@\/lib\/auto-renewal-copy"/,
    );
    expect(HOOKS_SRC).not.toContain(`disclosureVersion: "`);
  });
});
