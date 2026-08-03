// US-2145: the seller-facing appeal must keep a caller.
//
// THE STATE THIS PREVENTS, which is the state it was found in. Every piece of
// the appeal flow existed and was carefully built: the endpoint verifies
// ownership, rate-limits (an unlimited appeal is a free way to suppress every
// verdict), files the dispute, HIDES the verdict so the seller is not left
// defending something still on display, and reseals the certificate because
// integrity v4 covers the verdict. The admin queue and resolve routes existed
// too, ordered oldest-first because an item under appeal is unsellable and
// waiting is itself a penalty.
//
// And nothing in `src/` called it. A grep returned zero hits. So the operator's
// queue could only ever be empty, and a seller whose genuine item was flagged
// had no way to say so — while every file anyone would read to check suggested
// the feature shipped.
//
// That is the third instance of this shape found on 2026-08-02 alone (the
// waitlist backend with no capture form, the grade-card switch writing columns
// nothing read). In each, the expensive half was built and the cheap half was
// not, and the missing half was the one a USER touches. A route with no caller
// is invisible to type-checking, to lint, and to every test that exercises the
// route directly — so it takes a scan like this one to notice.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.tsx?$/.test(p))
    .map((p) => `src/${p.split("\\").join("/")}`)
    .filter((p) => !p.includes("__tests__") && !p.startsWith("src/test/"));
}

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("the authenticity appeal is reachable by a seller (US-2145)", () => {
  it("something in the app calls the appeal endpoint", () => {
    const callers = sourceFiles().filter((f) =>
      read(f).includes("/api/grade/authenticity-appeal"),
    );
    expect(
      callers.length,
      "No file under src/ posts to /api/grade/authenticity-appeal. The endpoint " +
        "exists, files the dispute, hides the verdict and reseals the " +
        "certificate — and a seller cannot reach any of it. That is the exact " +
        "state US-2145 was opened in: an admin appeals queue that can only ever " +
        "be empty.",
    ).toBeGreaterThan(0);
  });

  it("the dialog is rendered somewhere, not merely defined", () => {
    // A component nobody mounts is the same defect one level up — and it is
    // the shape that produced this story. Importing it is not enough; the JSX
    // has to appear.
    const mounted = sourceFiles().filter(
      (f) =>
        !f.endsWith("authenticity-appeal-dialog.tsx") &&
        read(f).includes("<AuthenticityAppealDialog"),
    );
    expect(mounted.length, "AuthenticityAppealDialog is never rendered").toBeGreaterThan(0);
  });

  it("the seller surface handles the under_appeal state", () => {
    // The server NULLS verdict, confidence, risk and summary while an appeal is
    // open. A surface that renders the normal card regardless would show a row
    // of blanks and read as a bug rather than as "withheld pending review" —
    // which is worse than not shipping the button, because it makes the seller
    // think their appeal broke something.
    const detail = read("src/pages/submission-detail.tsx");
    expect(detail).toContain("under_appeal");
  });

  it("the client's minimum reason length matches the server's", () => {
    // Mirrored on purpose: the client copy tells a seller what a reviewer needs
    // BEFORE they write, and the server enforces it. If they drift, the seller
    // is rejected after typing — which is how someone gives up on an appeal
    // they were entitled to.
    const dialog = read("src/components/grade/authenticity-appeal-dialog.tsx");
    expect(dialog).toMatch(/MIN_REASON\s*=\s*20/);
  });
});
