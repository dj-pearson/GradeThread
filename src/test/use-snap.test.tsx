import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  edgeFetch: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/edge-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/edge-fetch")>()),
  edgeFetch: mocks.edgeFetch,
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) => select({ user: { id: "u1" } }),
}));

import {
  classifySnapError,
  parseSnapResult,
  useSnap,
  SNAP_TIMEOUT_MS,
  type SnapError,
  type SnapResult,
} from "@/hooks/use-snap";
import { combineSignals } from "@/lib/edge-fetch";
import { readSnapHistory } from "@/lib/snap-history";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GOOD = {
  grade: { overall_score: 7.4, grade_tier: "very_good", confidence: 0.8, factor_scores: { fabric_condition: 7 } },
  value: { lowCents: 1800, medianCents: 3200, highCents: 6400, sampleSize: 12, confidence: 0.6, sufficient: true, currency: "USD" },
  usage: { used: 3, cap: 15, resets_at: "2026-10-01T00:00:00.000Z" },
  garment: { type: "jacket", category: "outerwear" },
  estimate: true,
  disclaimer: "estimate",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("classifySnapError (SNAP-07)", () => {
  it.each([
    [429, "SNAP_LIMIT_REACHED", "limit"],
    [429, "SNAP_IP_LIMIT_REACHED", "limit"],
    [429, undefined, "rate"],
    [503, "FEATURE_DISABLED", "unavailable"],
    [503, "AI_BUDGET_EXCEEDED", "unavailable"],
    [503, "SNAP_UNAVAILABLE", "unavailable"],
    [503, "AI_AT_CAPACITY", "unavailable"],
    [503, undefined, "unavailable"],
    [401, undefined, "auth"],
    [502, undefined, "failed"],
    [400, "SNAP_IMAGE_INVALID", "failed"],
  ] as const)("%i %s -> %s", (status, code, kind) => {
    expect(classifySnapError(status, code)).toBe(kind);
  });
});

describe("parseSnapResult (SNAP-07)", () => {
  it("refuses a body that is not an estimate", () => {
    expect(parseSnapResult({})).toBeNull();
    expect(parseSnapResult(null)).toBeNull();
    expect(parseSnapResult({ grade: { overall_score: "7", grade_tier: "good" } })).toBeNull();
    expect(parseSnapResult({ grade: { overall_score: 7 } })).toBeNull();
  });

  it("coerces value and garment, defaults currency, and treats an open range as insufficient", () => {
    const r = parseSnapResult({
      grade: { overall_score: 6, grade_tier: "good", confidence: 0.7 },
      value: { lowCents: null, medianCents: 2000, highCents: null, sampleSize: 2, sufficient: true },
      garment: "jacket",
    })!;
    expect(r.value?.sufficient).toBe(false);
    expect(r.value?.currency).toBe("USD");
    expect(r.garment).toBeNull();
    expect(r.grade.factor_scores).toEqual({});
  });

  it("keeps a good body intact", () => {
    const r = parseSnapResult(GOOD)!;
    expect(r.grade.overall_score).toBe(7.4);
    expect(r.value?.medianCents).toBe(3200);
    expect(r.usage).toEqual(GOOD.usage);
  });
});

describe("combineSignals (SNAP-07)", () => {
  it("is off by default", () => {
    expect(combineSignals(undefined, undefined)).toBeUndefined();
    const c = new AbortController();
    expect(combineSignals(c.signal, undefined)).toBe(c.signal);
  });

  it("times out as a TimeoutError", async () => {
    const s = combineSignals(undefined, 20)!;
    await new Promise((r) => setTimeout(r, 60));
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe("TimeoutError");
  });

  it("still honors the caller's cancel", () => {
    const c = new AbortController();
    const s = combineSignals(c.signal, 10_000)!;
    c.abort();
    expect(s.aborted).toBe(true);
  });
});

// A tiny harness: render a component that hands the mutation out.
async function runSnap(): Promise<{ data?: SnapResult; error?: SnapError }> {
  let mutateAsync: ReturnType<typeof useSnap>["mutateAsync"] | null = null;
  function Probe() {
    mutateAsync = useSnap().mutateAsync;
    return null;
  }
  const container = document.createElement("div");
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const root = createRoot(container);
  act(() => root.render(h(QueryClientProvider, { client }, h(Probe))));
  let out: { data?: SnapResult; error?: SnapError } = {};
  await act(async () => {
    try {
      out = { data: await mutateAsync!({ imageDataUri: "data:image/jpeg;base64,AAA", brand: "Nike" }) };
    } catch (e) {
      out = { error: e as SnapError };
    }
  });
  act(() => root.unmount());
  return out;
}

describe("useSnap (SNAP-07)", () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    mocks.edgeFetch.mockReset();
    mocks.track.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks for a timeout and no silentGate", async () => {
    mocks.edgeFetch.mockResolvedValue(jsonResponse(200, GOOD));
    await runSnap();
    const opts = mocks.edgeFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.timeoutMs).toBe(SNAP_TIMEOUT_MS);
    expect(opts.silentGate).toBeUndefined();
  });

  it("records history and a completed event on success, with no brand text", async () => {
    mocks.edgeFetch.mockResolvedValue(jsonResponse(200, GOOD));
    const { data } = await runSnap();
    expect(data?.grade.overall_score).toBe(7.4);
    expect(readSnapHistory("u1")).toHaveLength(1);
    expect(mocks.track).toHaveBeenCalledWith("snap.completed", { hasValue: true, sufficient: true, tier: "very_good" });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain("Nike");
  });

  it("a 200 with an unreadable body is an 'invalid' error, not a crash", async () => {
    mocks.edgeFetch.mockResolvedValue(jsonResponse(200, "<html>oops</html>"));
    const { error } = await runSnap();
    expect(error?.kind).toBe("invalid");
    expect(readSnapHistory("u1")).toEqual([]);
  });

  it("carries status, code, action and Retry-After", async () => {
    mocks.edgeFetch.mockResolvedValue(
      jsonResponse(429, { error: "Daily limit", code: "SNAP_IP_LIMIT_REACHED", action: "upgrade" }),
    );
    let { error } = await runSnap();
    expect(error).toMatchObject({ kind: "limit", status: 429, code: "SNAP_IP_LIMIT_REACHED", action: "upgrade" });

    mocks.edgeFetch.mockResolvedValue(jsonResponse(429, { error: "Too many" }, { "Retry-After": "37" }));
    ({ error } = await runSnap());
    expect(error).toMatchObject({ kind: "rate", retryAfterSec: 37 });

    mocks.edgeFetch.mockResolvedValue(jsonResponse(503, { error: "busy", code: "AI_AT_CAPACITY", retry_after: 60 }));
    ({ error } = await runSnap());
    expect(error).toMatchObject({ kind: "unavailable", retryAfterSec: 60 });
    expect(mocks.track).toHaveBeenLastCalledWith("snap.failed", { kind: "unavailable", code: "AI_AT_CAPACITY", status: 503 });
  });

  it("maps a dropped connection, a signed-out session and a timeout", async () => {
    mocks.edgeFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await runSnap()).error?.kind).toBe("network");
    mocks.edgeFetch.mockRejectedValue(new Error("You must be signed in."));
    expect((await runSnap()).error?.kind).toBe("auth");
    mocks.edgeFetch.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const { error } = await runSnap();
    expect(error?.kind).toBe("failed");
    expect(error?.message).toMatch(/taking too long/);
  });
});

describe("the page branches on the error kind", () => {
  it("renders the error card, which knows every kind", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/snap.tsx"), "utf8");
    expect(page).toContain("<SnapErrorCard");
    expect(page).not.toContain('snap.error?.code === "SNAP_LIMIT_REACHED"');
    const card = readFileSync(resolve(process.cwd(), "src/components/snap/snap-error-card.tsx"), "utf8");
    for (const kind of ["limit", "rate", "unavailable", "network", "auth"]) {
      expect(card).toContain(`case "${kind}":`);
    }
    expect(card).toContain("Upgrade for more snaps");
  });
});
