// US-2127 AC3: the point of sale and the Terms must not say opposite things
// about the same word.
//
// Five product surfaces tell a customer "credits never expire". The Terms say
// "Unused grading credits do not roll over and are not refundable". Both use
// the word "credits" and they mean different things by it:
//
//   PURCHASED CREDIT PACKS never expire — constants.ts CREDIT_PACKS says so,
//   and migrations 00037 and 00415 say so.
//   The MONTHLY PLAN ALLOWANCE (users.grades_used_this_month) does reset each
//   cycle and genuinely does not roll over.
//
// So the Terms sentence is true of one and false of the other, and the one it
// is false about is the one the customer PAID for. It UNDERSTATES what they
// get, which costs conversion rather than creating exposure — but it is still a
// false statement in the Terms.
//
// ⚠ THIS TEST DOES NOT FIX THE COPY, deliberately. US-2127 AC4 puts the Terms
// and refund pages under counsel review, and rewriting Terms ahead of that
// trades one unreviewed statement for another. What it does is stop the
// contradiction being a sentence in a backlog note: it is a tracked, annotated
// exception that can only SHRINK, it fails when a new surface joins the
// contradiction, and it fails when the exception goes stale — so whoever fixes
// the copy has to remove the entry rather than leave a lie about a lie.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { CREDIT_PACKS } from "@/lib/constants";

const REPO_ROOT = resolve(__dirname, "../..");

/** What a purchased credit pack actually does, per the code that sells it. */
const PURCHASED_CREDITS_EXPIRE = false;

/**
 * Statements that contradict the fact above, with the reason each is still
 * here. MAY ONLY SHRINK. An entry that no longer matches its file fails, so a
 * fix must delete the entry rather than leave it describing something gone.
 */
const KNOWN_CONTRADICTIONS = [
  {
    file: "src/pages/legal/terms.tsx",
    text: "credits do not roll over and are not refundable",
    why:
      'Conflates the monthly plan allowance (which does reset) with purchased ' +
      "credit packs (which never expire). Understates what a paying customer " +
      "gets. NOT edited here: US-2127 AC4 has this page under counsel review, " +
      "and rewriting Terms ahead of that swaps one unreviewed statement for " +
      "another.",
    story: "US-2127",
  },
] as const;

function walk(dir: string, out: string[] = [], ext = /\.tsx?$/): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out, ext);
    } else if (ext.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The OTHER two clients. Added 2026-08-15 (US-2127): this scan walked `src/`
 * only, so it read as coverage of "what we tell a customer about credits" while
 * never executing over two of the three surfaces that say it.
 *
 * Android's paywall carries the never-expire claim at
 * `res/values/strings.xml` and iOS carries it in `Billing/IAPProduct.swift`.
 * Neither could have been flagged, whichever way this story resolves — and if
 * it resolves the other way (credits DO expire), the copy has to change on
 * three clients, not one.
 *
 * Same class of hole as US-1996: a guard that reads as coverage while never
 * running over the surface that drifted.
 */
const CLIENT_ROOTS: Array<{ dir: string; ext: RegExp; label: string }> = [
  { dir: "src", ext: /\.tsx?$/, label: "web" },
  { dir: "android/app/src/main/res", ext: /\.xml$/, label: "android" },
  { dir: "ios/GradeThread", ext: /\.(swift|xcstrings)$/, label: "ios" },
];

function collectFiles(): Array<{ path: string; src: string; label: string }> {
  const out: Array<{ path: string; src: string; label: string }> = [];
  for (const root of CLIENT_ROOTS) {
    const abs = resolve(REPO_ROOT, root.dir);
    let files: string[];
    try {
      files = walk(abs, [], root.ext);
    } catch {
      // A client directory that is absent is a real change, not something to
      // shrug at: it would silently narrow this scan back to where it started.
      throw new Error(
        `${root.dir} is missing — this guard covers three clients on purpose ` +
          "(US-2127). If a client was removed, delete its CLIENT_ROOTS entry.",
      );
    }
    for (const f of files) {
      out.push({
        path: relative(REPO_ROOT, f).replace(/\\/g, "/"),
        src: readFileSync(f, "utf8"),
        label: root.label,
      });
    }
  }
  return out;
}

const FILES = collectFiles();

/** Wording that tells a customer a credit stops being usable. */
const EXPIRY_CLAIM = /credits?[^.]{0,60}(do not roll over|don't roll over|expire after|will expire)/i;

describe("US-2127: what we say about credit expiry", () => {
  it("purchased credits never expire, per the module that sells them", () => {
    // The anchor. Every assertion below is only meaningful while this holds.
    expect(PURCHASED_CREDITS_EXPIRE).toBe(false);
    expect(CREDIT_PACKS.length).toBeGreaterThan(0);
    const constants = FILES.find((f) => f.path === "src/lib/constants.ts");
    expect(constants?.src).toContain("Credits never expire");
  });

  it("the surfaces that sell credits say so", () => {
    // Derived, not listed: a new purchase surface that omits it is a gap this
    // should notice, and one that contradicts it is caught below.
    const saying = FILES.filter((f) => /credits? never expire|never expire/i.test(f.src));
    expect(saying.length).toBeGreaterThanOrEqual(3);
  });

  it("the scan actually reaches all three clients", () => {
    // Guarding the guard, and it is the whole point of the 2026-08-15 change.
    // Before it, FILES walked `src/` alone: every assertion below passed while
    // two of the three surfaces that make this claim were invisible. A scan
    // that silently narrows is indistinguishable from one that finds nothing,
    // so assert the coverage rather than the result.
    for (const label of ["web", "android", "ios"]) {
      const seen = FILES.filter((f) => f.label === label);
      expect(seen.length, `${label} contributed no files — the scan narrowed`)
        .toBeGreaterThan(0);
    }
  });

  it("every client that sells credits makes the claim", () => {
    // Android's paywall and iOS's IAP list both say it today. If a client ships
    // a credit paywall without it, that is a customer told less than they get —
    // and, if this story resolves the other way, a client left saying something
    // false. Either way it should be visible here rather than in a store review.
    for (const label of ["web", "android", "ios"]) {
      const saying = FILES.filter(
        (f) => f.label === label && /never expire/i.test(f.src),
      );
      expect(
        saying.length,
        `${label} sells credit packs and no file says they never expire`,
      ).toBeGreaterThan(0);
    }
  });

  it("every contradicting statement is a tracked, annotated exception", () => {
    const contradicting = FILES.filter((f) => EXPIRY_CLAIM.test(f.src)).map((f) => f.path);
    const allowed: readonly string[] = KNOWN_CONTRADICTIONS.map((c) => c.file);
    const unlisted = contradicting.filter((p) => !allowed.includes(p));
    expect(
      unlisted,
      "these tell a customer credits stop being usable, which is false of a " +
        "purchased credit pack. Fix the wording, or add an entry to " +
        "KNOWN_CONTRADICTIONS with the reason and the owning story.",
    ).toEqual([]);
  });

  it("no exception outlives the statement it describes", () => {
    // The half that makes the list shrink. When counsel rewrites the sentence,
    // this fails until the entry is deleted — so the register cannot rot into a
    // record of a problem that no longer exists, which is how an allowlist
    // stops meaning anything.
    for (const c of KNOWN_CONTRADICTIONS) {
      const file = FILES.find((f) => f.path === c.file);
      expect(file, `${c.file} is gone — delete its entry`).toBeDefined();
      expect(
        file!.src.includes(c.text),
        `${c.file} no longer contains "${c.text}". If it was fixed, delete the ` +
          "KNOWN_CONTRADICTIONS entry.",
      ).toBe(true);
      expect(c.why.length, `${c.file}: an exception needs a real reason`).toBeGreaterThan(60);
      expect(c.story).toMatch(/^US-\d+$/);
    }
  });
});
