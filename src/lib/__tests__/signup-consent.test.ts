// US-2116 AC4, client half: who gets asked, and how often.
//
// The rules that keep the RECORD honest live on the edge
// (signup-consent-evidence_test.ts). These are about traffic: this fires from
// the SIGNED_IN branch of use-auth.ts, which runs on every sign-in and again on
// every token refresh, for every user on every platform.

import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...a: unknown[]) => edgeFetch(...a) }));
const captureException = vi.fn();
vi.mock("@/lib/sentry", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: vi.fn(),
}));

const { confirmSignupConsentOnce, resetSignupConsentAttempts } = await import(
  "../signup-consent"
);

/** Let the fire-and-forget IIFE settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("confirmSignupConsentOnce", () => {
  beforeEach(() => {
    edgeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
    captureException.mockReset();
    resetSignupConsentAttempts();
  });

  it("calls the confirm endpoint for an email signup", async () => {
    confirmSignupConsentOnce("u1", "email");
    await flush();
    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(edgeFetch.mock.calls[0]?.[0]).toBe("/api/legal/confirm-signup");
  });

  it("does NOT call /api/legal/accept", async () => {
    // The tempting shortcut, and the one the edge module refuses: /accept
    // stamps the CURRENT versions and the users.*_accepted_version columns, so
    // reusing it would record acceptance of a document published after signup
    // and clear a re-acceptance prompt nobody answered. Pinned as an OUTCOME
    // because "we call the right endpoint" is a branch order that reordering
    // passes review, typecheck and every other test.
    confirmSignupConsentOnce("u1", "email");
    await flush();
    const paths = edgeFetch.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/api/legal/accept");
  });

  it("skips OAuth users entirely", async () => {
    // An OAuth signup has no clickwrap row to corroborate — the trigger only
    // writes one when the clickwrap metadata is present — and its consent
    // already goes through /accept, which records IP and user-agent itself. The
    // server refuses these callers, so this is purely about not putting a
    // request on every Google sign-in forever.
    for (const p of ["google", "apple", "azure", undefined]) {
      confirmSignupConsentOnce(`u-${p}`, p);
    }
    await flush();
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  it("fires once per user per page session", async () => {
    // SIGNED_IN re-fires on every token refresh. Without this the endpoint
    // takes a read per refresh, per tab, forever.
    confirmSignupConsentOnce("u1", "email");
    confirmSignupConsentOnce("u1", "email");
    confirmSignupConsentOnce("u1", "email");
    await flush();
    expect(edgeFetch).toHaveBeenCalledTimes(1);
  });

  it("still fires for a DIFFERENT user in the same session", async () => {
    // Shared browsers are real: the dedup is per user, not per page.
    confirmSignupConsentOnce("u1", "email");
    confirmSignupConsentOnce("u2", "email");
    await flush();
    expect(edgeFetch).toHaveBeenCalledTimes(2);
  });

  it("re-arms after a thrown request so the record is not burned", async () => {
    // A network blip must not cost the evidence permanently. The dedup entry is
    // released on throw, so the next sign-in retries; it is NOT released on a
    // non-2xx, because that is the server having answered.
    edgeFetch.mockRejectedValueOnce(new Error("offline"));
    confirmSignupConsentOnce("u1", "email");
    await flush();
    expect(captureException).toHaveBeenCalledTimes(1);

    edgeFetch.mockResolvedValue({ ok: true, status: 200 });
    confirmSignupConsentOnce("u1", "email");
    await flush();
    expect(edgeFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores an empty user id", async () => {
    confirmSignupConsentOnce("", "email");
    await flush();
    expect(edgeFetch).not.toHaveBeenCalled();
  });
});
