import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { claimFailureMessage } from "@/lib/claim-failure";

// US-2551. /t/:code offered "Claim this item" to anyone who scanned it and sent
// the POST with no Authorization header when signed out — and the server took
// it. The credential was not holding the tag, it was SEEING the short code: a
// rack in a shop, or a photo of the tag, was enough to move a garment's
// provenance chain to a new pseudonymous owner. Anonymously, repeatedly (the
// code is neither single-use nor expiring), with nothing to trace or reverse.

const TAG_PAGE = "src/pages/tag-scan.tsx";
const CLAIM_PAGE = "src/pages/passport-claim.tsx";
const ROUTE = "services/edge-functions/src/routes/passport.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** The body of one Hono route handler, from its registration to the next one. */
function handler(src: string, registration: string): string {
  const at = src.indexOf(registration);
  expect(at, `route ${registration} is gone`).toBeGreaterThan(-1);
  const next = src.indexOf("passportRoutes.", at + registration.length);
  return src.slice(at, next === -1 ? src.length : next);
}

describe("the tag claim requires an account (US-2551 AC1, AC2)", () => {
  const src = read(ROUTE);
  const tagClaim = handler(src, 'passportRoutes.post("/tag/:code/claim"');

  it("an unauthenticated caller is refused", () => {
    expect(tagClaim).toContain("userIdFromBearer");
    expect(tagClaim).toMatch(/if \(!linkedUserId\)/);
    expect(tagClaim).toContain('code: "AUTH_REQUIRED"');
    expect(tagClaim).toMatch(/401/);
  });

  it("the refusal comes BEFORE the tag lookup, so it cannot probe codes", () => {
    // Otherwise 404-vs-401 tells an anonymous caller which short codes exist,
    // and the codes are short enough that this matters.
    const authAt = tagClaim.indexOf("if (!linkedUserId)");
    const lookupAt = tagClaim.indexOf('.from("passport_tags")');
    expect(authAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(lookupAt);
  });

  it("the transfer is attributed to that account", () => {
    // linkedUserId is non-null by the time it reaches the transfer, which is
    // what makes the move reversible and abuse traceable.
    expect(tagClaim).toContain('source: "tag-claim"');
    expect(tagClaim).toContain("linkedUserId");
    expect(tagClaim).not.toMatch(/linkedUserId: null/);
  });

  it("the TOKEN claim stays anonymous, on purpose", () => {
    // Pinned so nobody 'fixes' the two paths to match. The difference is the
    // credential: a claim token is single-use, expiring, delivered privately and
    // replay-detected. A code printed on a hangtag is none of those.
    const tokenClaim = handler(src, 'passportRoutes.post("/claim"');
    expect(tokenClaim).toContain("userIdFromBearer");
    expect(tokenClaim, "the token path must not grow an auth gate").not.toMatch(
      /if \(!linkedUserId\)[\s\S]{0,200}401/,
    );
    // And the reasoning is written where the next person will look.
    expect(src).toContain("single-use");
  });
});

describe("the page stops offering what it cannot do (US-2551 AC2)", () => {
  const src = read(TAG_PAGE);

  it("signed out, the button signs you in instead of posting", () => {
    expect(src).toContain("Sign in to claim");
    expect(src).toContain("/login?next=");
    expect(src).toContain(
      "encodeURIComponent(`/t/${code ?? \"\"}`)",
    );
  });

  it("it knows whether anyone is signed in", () => {
    expect(src).toContain('from "@/stores/auth-store"');
    expect(src).toMatch(/useAuthStore\(\(s\) => s\.user\)/);
    expect(src).toMatch(/\{user \? \(/);
  });
});

describe("claiming is confirmed before it happens (US-2551 AC3)", () => {
  it("a failed READ retries the read, not a claim", () => {
    // The retry button called claim() whatever had failed, so a dropped
    // connection while merely READING the tag would have fired an irreversible
    // ownership transfer instead of re-reading.
    const src = read(TAG_PAGE);
    expect(src).toContain('retry?: "resolve" | "claim"');
    expect(src).toContain('state.retry === "claim" ? claim : () => void resolveTag()');
  });

  it("the tag page asks first, and says what it does", () => {
    const src = read(TAG_PAGE);
    expect(src).toContain("<AlertDialog");
    expect(src).toContain("Claim this item as its owner?");
    // The three things a buyer needs to know: it is public, it displaces the
    // previous owner, and it does not undo itself.
    expect(src).toContain("public provenance chain");
    expect(src).toContain("cannot be undone");
    // The claim only fires from the confirm action.
    expect(src).toMatch(/<AlertDialogAction onClick=\{claim\}>/);
    expect(src).not.toMatch(/<Button onClick=\{claim\}>Claim this item<\/Button>/);
  });

  it("the claim-link page no longer claims the moment it opens", () => {
    // The token is single-use, so an auto-claim meant that merely OPENING the
    // link burned it — and the real buyer then met "already used".
    const src = read(CLAIM_PAGE);
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*void claim\(\);/);
    expect(src).not.toContain("Guard double-submits in React Strict Mode");
    expect(src).toContain("Claim this item");
    expect(src).toContain("The link works once");
  });
});

describe("the four failures are told apart (US-2551 AC4)", () => {
  it("each status gets the advice that matches it", () => {
    expect(claimFailureMessage(401).message).toContain("signed in");
    expect(claimFailureMessage(403).message).toContain("signed in");
    expect(claimFailureMessage(404).message).toContain("revoked");
    expect(claimFailureMessage(410).message).toContain("already been claimed");
    expect(claimFailureMessage(409).message).toContain("already been claimed");
    expect(claimFailureMessage(429).message).toContain("Wait a minute");
    expect(claimFailureMessage(500).message).toContain("couldn't reach");
    expect(claimFailureMessage(null).message).toContain("couldn't reach");
  });

  it("only the genuinely retryable cases offer a retry", () => {
    // Telling someone to try again is wrong advice when the answer is "sign in"
    // or "this tag will never work" — and it is the advice every failure used
    // to give.
    for (const status of [401, 403, 404, 409, 410]) {
      expect(claimFailureMessage(status).canRetry, String(status)).toBe(false);
    }
    for (const status of [429, 500, 502, 503]) {
      expect(claimFailureMessage(status).canRetry, String(status)).toBe(true);
    }
    expect(claimFailureMessage(null).canRetry).toBe(true);
  });

  it("both pages speak one vocabulary (US-2551 AC5)", () => {
    // Two copies is how the same 410 ends up meaning two different things.
    for (const rel of [TAG_PAGE, CLAIM_PAGE]) {
      expect(read(rel), rel).toContain('from "@/lib/claim-failure"');
      // No page keeps a private copy of the four outcomes.
      expect(read(rel), rel).not.toMatch(
        /message: "(Couldn't|Something went wrong)[^"]*Please try again/,
      );
    }
  });

  it("the status reaches the message, rather than being thrown away", () => {
    // The old catch had no status in scope at all, which is why every failure
    // collapsed into one sentence.
    for (const rel of [TAG_PAGE, CLAIM_PAGE]) {
      const src = read(rel);
      expect(src, rel).toContain("let status: number | null = null;");
      expect(src, rel).toContain("status = res.status;");
      expect(src, rel).toContain("claimFailureMessage(status)");
    }
  });
});
