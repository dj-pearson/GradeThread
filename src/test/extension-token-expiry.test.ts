// US-3296: the extension's account token expires after 30 days and nothing
// renewed it.
//
// mintExtensionToken issues 30 days. The only place it was ever handed over was
// /connect-extension, from a button a seller presses once. Nothing re-minted it:
// no refresh on expiry, no re-handoff on sign-in, no warning as the end
// approached. So every connected seller silently dropped to the ANONYMOUS
// entitlements about a month after connecting, and every Lister action failed
// from then on. US-3295 gave that failure better words; it did not stop it
// happening, and the seller who found it was on Business being told to buy a
// plan.
//
// WHY IT HID FOR SO LONG. An expired token authenticates nothing, so the server
// answers it exactly as it answers a browser that has never connected. From the
// web app the two were the same fact. Everything below is about keeping them
// two facts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { listerBlockCause } from "@/lib/lister-extension";
import {
  HANDOFF_CHECK_INTERVAL_MS,
  needsFreshToken,
  shouldCheckNow,
  tokenSnapshotFrom,
} from "@/lib/extension-token-handoff";
import { buildSteps, connectionDetail } from "@/components/flipdesk/cross-post-setup";
import type { ExtensionSetupState } from "@/hooks/use-extension-setup";

const code = (p: string) => readFileSync(p, "utf8");

const DAY = 24 * 60 * 60 * 1000;

function setupState(over: Partial<ExtensionSetupState> = {}): ExtensionSetupState {
  return {
    installed: true,
    reachable: true,
    signedIn: true,
    tokenStatus: "active",
    tokenExpiresAt: new Date(Date.now() + 20 * DAY).toISOString(),
    sellerEnabled: true,
    tosAccepted: true,
    channels: [],
    version: "1.1.0",
    unavailable: null,
    ...over,
  };
}

// ── AC5 ──────────────────────────────────────────────────────────────────
describe("a token minted 31 days ago", () => {
  // The extension reports its own token state, because only the extension can:
  // it wrote down the expiry when it stored the token, and the server's answer
  // to an expired token is byte-identical to its answer to no token at all.
  const pongExpired = async () => ({
    ok: true,
    tokenStatus: "expired",
    tokenExpiresAt: new Date(Date.now() - DAY).toISOString(),
    // Anonymous, because that is genuinely what the server said. The account is
    // on Business and paying; the server cannot see that through a dead token.
    capabilities: { authenticated: false, sellerEnabled: false, lister: false },
  });

  it("resolves to reconnect, not to a plan upgrade", async () => {
    // An older extension build reports only `needsUpgrade` — the exact wire
    // shape that put a Business seller in front of /pricing.
    const cause = await listerBlockCause({ needsUpgrade: true }, pongExpired);
    expect(cause).toBe("reconnect");
    expect(cause).not.toBe("plan");
  });

  it("resolves to reconnect, not to connect", async () => {
    // And not "signin" either. The seller DID connect; being told to connect
    // reads as though the product forgot them. Same refusal, same wire flags,
    // same anonymous capabilities — the ONLY thing separating the two answers
    // is the token state the extension keeps for itself, which is exactly the
    // fact nothing carried before this story.
    const refusal = { needsUpgrade: true };
    const never = await listerBlockCause(refusal, async () => ({
      ok: true,
      tokenStatus: "none",
      capabilities: { authenticated: false, sellerEnabled: false, lister: false },
    }));
    const lapsed = await listerBlockCause(refusal, pongExpired);

    expect(never).toBe("signin");
    expect(lapsed).toBe("reconnect");
    expect(lapsed).not.toBe(never);
  });

  it("is believed outright from a build that says so itself", async () => {
    let asked = 0;
    const cause = await listerBlockCause({ needsReconnect: true, needsSignIn: true }, async () => {
      asked++;
      return {};
    });
    expect(cause).toBe("reconnect");
    expect(asked).toBe(0);
  });

  it("shows the seller a reconnect step with the date it died", () => {
    const s = setupState({
      signedIn: false,
      sellerEnabled: false,
      tokenStatus: "expired",
      tokenExpiresAt: new Date(Date.UTC(2026, 7, 10)).toISOString(),
    });
    const step = buildSteps(s).find((x) => x.key === "signin")!;
    expect(step.title).toContain("Reconnect");
    expect(step.body).toContain("run out");
    expect(step.detail).toContain("Expired");
    // The plan step must not become the story. An expired token says nothing
    // whatsoever about what the account pays for.
    const plan = buildSteps(s).find((x) => x.key === "plan")!;
    expect(plan.state).not.toBe("blocked");
  });
});

// ── never-connected and expired stay two things ──────────────────────────
describe("connect and reconnect are different instructions", () => {
  it("an install that never connected still says connect", async () => {
    const cause = await listerBlockCause({ needsUpgrade: true }, async () => ({
      ok: true,
      tokenStatus: "none",
      capabilities: { authenticated: false },
    }));
    expect(cause).toBe("signin");

    const step = buildSteps(setupState({ signedIn: false, tokenStatus: "none", tokenExpiresAt: null }))
      .find((x) => x.key === "signin")!;
    expect(step.title).toBe("Connect it to this account");
    expect(step.detail).toBeUndefined();
  });

  it("a connected free account is still a plan problem", async () => {
    const cause = await listerBlockCause({ needsUpgrade: true }, async () => ({
      ok: true,
      tokenStatus: "active",
      capabilities: { authenticated: true, sellerEnabled: false },
    }));
    expect(cause).toBe("plan");
  });

  it("a silent or broken extension is still never read as unpaid", async () => {
    // US-3295's asymmetry, preserved. Sending a connected Free seller to Connect
    // costs a click; sending a Business seller to /pricing tells them the
    // product does not know what they pay for.
    expect(await listerBlockCause({ needsUpgrade: true }, async () => ({}))).toBe("signin");
    expect(
      await listerBlockCause({ needsUpgrade: true }, async () => {
        throw new Error("port closed");
      }),
    ).toBe("signin");
  });
});

// ── AC4: the card shows when the connection runs out ─────────────────────
describe("the Marketplaces setup card shows the expiry", () => {
  it("names the date while the connection is healthy", () => {
    const detail = connectionDetail(
      setupState({ tokenExpiresAt: new Date(Date.UTC(2026, 9, 3)).toISOString() }),
    );
    expect(detail).toMatch(/Connected until/);
    expect(detail).toMatch(/2026/);
  });

  it("says a renewal is coming when it is close", () => {
    const detail = connectionDetail(setupState({ tokenStatus: "expiring" }));
    expect(detail).toMatch(/^Expires /);
    expect(detail).toContain("renews itself");
  });

  it("says nothing rather than guessing", () => {
    // An older extension build reports no expiry at all. A made-up date on this
    // card would be worse than none: the failure being fixed is a surface that
    // was confidently wrong about the connection.
    expect(connectionDetail(setupState({ tokenStatus: null, tokenExpiresAt: null }))).toBeUndefined();
    expect(connectionDetail(setupState({ tokenStatus: "active", tokenExpiresAt: null }))).toBeUndefined();
    expect(connectionDetail(setupState({ tokenExpiresAt: "not-a-date" }))).toBeUndefined();
    expect(connectionDetail(setupState({ reachable: false }))).toBeUndefined();
    expect(connectionDetail(setupState({ tokenStatus: "none" }))).toBeUndefined();
  });
});

// ── AC1: the web app re-hands without anyone pressing anything ────────────
describe("the automatic re-handoff", () => {
  it("replaces anything that is not comfortably live", () => {
    expect(needsFreshToken({ status: "active", expiresAt: null })).toBe(false);
    expect(needsFreshToken({ status: "expiring", expiresAt: null })).toBe(true);
    expect(needsFreshToken({ status: "expired", expiresAt: null })).toBe(true);
    expect(needsFreshToken({ status: "none", expiresAt: null })).toBe(true);
    // An older build that cannot say. Unknown must read as "replace it" — an
    // install that has never reported an expiry is exactly the install that has
    // been quietly anonymous for a month.
    expect(needsFreshToken({ status: null, expiresAt: null })).toBe(true);
  });

  it("reads only the values the extension actually sent", () => {
    expect(tokenSnapshotFrom({ tokenStatus: "expiring", tokenExpiresAt: "2026-10-01T00:00:00Z" }))
      .toEqual({ status: "expiring", expiresAt: "2026-10-01T00:00:00Z" });
    expect(tokenSnapshotFrom({ tokenStatus: "banana" })).toEqual({ status: null, expiresAt: null });
    expect(tokenSnapshotFrom(null)).toEqual({ status: null, expiresAt: null });
    expect(tokenSnapshotFrom({ tokenExpiresAt: 17 as unknown as string }))
      .toEqual({ status: null, expiresAt: null });
  });

  it("checks often enough that a token cannot lapse between two checks", () => {
    // Six hours, against a seven-day renewal window. The margin is what makes
    // "on sign-in" enough for anyone who opens the app at all.
    expect(HANDOFF_CHECK_INTERVAL_MS).toBeLessThan(7 * DAY);
    const now = Date.now();
    expect(shouldCheckNow(null, now)).toBe(true);
    expect(shouldCheckNow(now - 1000, now)).toBe(false);
    expect(shouldCheckNow(now - HANDOFF_CHECK_INTERVAL_MS - 1, now)).toBe(true);
    // A clock that moved backwards must not lock the check out.
    expect(shouldCheckNow(now + 5 * DAY, now)).toBe(true);
    expect(shouldCheckNow(Number.NaN, now)).toBe(true);
  });

  it("is mounted where a signed-in seller will actually hit it", () => {
    const layout = code("src/layouts/dashboard-layout.tsx");
    expect(layout).toContain("useExtensionTokenHandoff()");
    // NOT RootLayout: the check needs useAuth, and pulling Supabase back onto
    // the marketing pages is the thing that was carefully undone when the
    // billing dialogs moved out of there.
    expect(code("src/layouts/root-layout.tsx")).not.toContain("useExtensionTokenHandoff");
  });
});

// ── AC2: the extension can ask for a renewal itself ──────────────────────
describe("the renewal endpoint the extension calls", () => {
  const EDGE = "services/edge-functions/src/routes/public-grading.ts";

  it("is on the public mount, where an expired token can still knock", () => {
    const src = code(EDGE);
    expect(src).toContain('publicGradingRoutes.post("/extension-token/renew"');
    // The point of the mount: every authed mount 401s an expired token before a
    // handler runs, and that is the request that most needs to succeed.
    expect(src).toContain("decideExtensionTokenRenewal(seen)");
  });

  it("is what the extension actually calls, on every wake it gets", () => {
    const bg = code("extension-unified/background.js");
    expect(bg).toContain("grading/public/extension-token/renew");
    expect(bg).toContain("renewTokenIfNeeded(");
    expect(bg).toMatch(/onStartup[\s\S]{0,300}renewTokenIfNeeded\(/);
  });

  it("never sets needsUpgrade for an expired token", () => {
    const bg = code("extension-unified/background.js");
    expect(bg).toContain('needsUpgrade: block === "plan"');
    expect(bg).toContain('needsReconnect: block === "reconnect"');
  });
});

describe("the composer routes reconnect to reconnecting", () => {
  const KIT = "src/components/flipdesk/listing-kit.tsx";

  it("names the connection expiring, and links to Connect rather than Pricing", () => {
    const src = code(KIT);
    expect(src).toContain("Your GradeThread connection expired");
    expect(src).toContain("Reconnect the extension");
    expect(src).toContain("Nothing is wrong with your plan.");
  });

  it("keeps the other two causes exactly where they were", () => {
    const src = code(KIT);
    expect(src).toContain("not connected to your GradeThread account");
    expect(src).toContain("Cross-listing needs an active paid FlipDesk plan.");
    expect(src).toContain('to="/pricing"');
  });
});
