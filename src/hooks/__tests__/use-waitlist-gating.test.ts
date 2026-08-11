// US-2449: the gate read fails CLOSED, which is the opposite of the server's
// fail-open and deliberately so.
//
// Server side, a DB blip must never lock the product out, so access-gate.ts
// defaults to "gate inactive". Marketing side, a network blip must never make a
// live product advertise a waitlist, so this defaults to "do not show the form".
// Both defaults point at the same sentence: the product is open. Getting either
// one backwards is a user-visible lie, which is why both have their own test.

import { describe, it, expect, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch }));

import { readWaitlistGating } from "../use-waitlist-gating";

const ok = (body: unknown) => ({ ok: true, json: async () => body });

describe("readWaitlistGating", () => {

  it("is true only when the server says the gate is on", async () => {
    edgeFetch.mockResolvedValue(ok({ gatingActive: true }));
    await expect(readWaitlistGating()).resolves.toBe(true);
  });

  it("is false when the gate is off", async () => {
    edgeFetch.mockResolvedValue(ok({ gatingActive: false }));
    await expect(readWaitlistGating()).resolves.toBe(false);
  });

  it("reads the anonymous status path, never the authenticated /me one", async () => {
    edgeFetch.mockResolvedValue(ok({ gatingActive: false }));
    await readWaitlistGating();
    const calls = edgeFetch.mock.calls;
    const [path, opts] = calls[calls.length - 1] as [string, Record<string, unknown>];
    expect(path).toBe("/api/waitlist/status");
    // Without this the landing page would attach a bearer it does not have and
    // the request would be treated as a session probe.
    expect(opts.unauthenticated).toBe(true);
  });

  it("fails closed when the request throws", async () => {
    edgeFetch.mockImplementation(async () => {
      throw new Error("offline");
    });
    // Settled explicitly, and this file has NO beforeEach — both deliberate.
    //
    // Bisected under vitest 4.1.8: add any `beforeEach` to this describe and
    // this case fails with the mock's own "offline" error rather than an
    // assertion, even though readWaitlistGating demonstrably catches it (the
    // identical case passes in a file without the hook). mockReset and
    // mockClear behave the same, so it is the hook and not the reset. I could
    // not explain the mechanism, so what is written here is what was measured
    // rather than a story about `.resolves` that I first assumed and that the
    // next bisect disproved. Naming the settled branch means a real regression
    // still reports as a diff, not as a rethrow.
    const settled = await readWaitlistGating().then(
      (v) => ({ outcome: "resolved", value: v }),
      (e) => ({ outcome: "rejected", value: String(e) }),
    );
    expect(settled).toEqual({ outcome: "resolved", value: false });
  });

  it("fails closed on a non-ok response", async () => {
    edgeFetch.mockResolvedValue({ ok: false, json: async () => ({ gatingActive: true }) });
    await expect(readWaitlistGating()).resolves.toBe(false);
  });

  it("fails closed on a truthy-but-not-true body, so a stray string cannot open it", async () => {
    edgeFetch.mockResolvedValue(ok({ gatingActive: "yes" }));
    await expect(readWaitlistGating()).resolves.toBe(false);
  });
});
