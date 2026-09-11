// US-3379 AC4: the retry must not be able to write a second waitlist row.
//
// A waitlist is the table where a duplicate is visible to a human - /admin/waitlist
// lists it - so "the endpoint is probably idempotent" is not good enough. Two
// things are proved here and one is proved by reading the server:
//
//   1. (read) POST /api/waitlist lowercases the email and upserts with
//      { onConflict: "email", ignoreDuplicates: true }
//      (services/edge-functions/src/routes/waitlist.ts) against
//      `email text not null unique` (supabase/migrations/00165_waitlist_gating.sql).
//      So the duplicate is refused as ON CONFLICT DO NOTHING by the database,
//      not by an application read-then-write that could race two tabs.
//   2. every retry sends the identical body to the identical path, so the
//      conflict target is the same value each time - a retry that varied the
//      email (case, whitespace, a name change between attempts) would defeat
//      point 1 even though the server code never changed.
//   3. the sequence is bounded and fires once per email, so a mounted page
//      cannot sit there POSTing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { edgeFetch } from "@/lib/edge-fetch";
import { captureMessage } from "@/lib/sentry";
import { joinWaitlistOnce } from "@/lib/waitlist-join";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/lib/sentry", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const mockedEdgeFetch = vi.mocked(edgeFetch);
const mockedCaptureMessage = vi.mocked(captureMessage);

let seq = 0;
function freshEmail(): string {
  return `join-${++seq}@example.com`;
}

/** Run past every backoff so a failing sequence has finished. */
async function drain() {
  await vi.advanceTimersByTimeAsync(30_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joinWaitlistOnce retry safety (US-3379 AC4)", () => {
  it("retries a 5xx at most 3 times and sends a byte-identical body each time", async () => {
    mockedEdgeFetch.mockResolvedValue(new Response("{}", { status: 500 }));
    const email = freshEmail();

    joinWaitlistOnce({ email, fullName: "Vee Isitor", userId: "u-1" });
    await drain();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(3);
    const bodies = mockedEdgeFetch.mock.calls.map(([path, opts]) =>
      JSON.stringify([path, opts?.json]),
    );
    // Same conflict target on every attempt: the upsert can only ever match the
    // row it made, never sit beside it.
    expect(new Set(bodies).size).toBe(1);
    expect(mockedEdgeFetch.mock.calls[0]![1]?.json).toEqual({
      email,
      full_name: "Vee Isitor",
      source: "signup-gated",
    });
    expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("normalizes the email so a differently-cased retry cannot miss the unique index", async () => {
    mockedEdgeFetch.mockResolvedValue(new Response("{}", { status: 500 }));
    const email = freshEmail();

    joinWaitlistOnce({ email: `  ${email.toUpperCase()}  `, userId: "u-2" });
    await drain();

    for (const [, opts] of mockedEdgeFetch.mock.calls) {
      expect((opts?.json as { email: string }).email).toBe(email);
    }
  });

  it("fires once per email however many times it is called", async () => {
    mockedEdgeFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const email = freshEmail();

    // The page's effect depends on [email, fullName, userId] and the profile
    // name lands a beat after the user does, so a real visit calls this twice.
    joinWaitlistOnce({ email, fullName: null, userId: "u-3" });
    joinWaitlistOnce({ email, fullName: "Vee Isitor", userId: "u-3" });
    joinWaitlistOnce({ email: email.toUpperCase(), fullName: "Vee", userId: "u-3" });
    await drain();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(1);
  });

  it("stops on a 4xx instead of burning the rate limiter, and still reports", async () => {
    mockedEdgeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "A valid email is required" }), { status: 400 }),
    );

    joinWaitlistOnce({ email: freshEmail(), userId: "u-4" });
    await drain();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(1);
    expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockedCaptureMessage.mock.calls[0]![1]).toMatchObject({
      extra: { status: 400, attempts: 1 },
    });
  });

  it("retries a thrown fetch (offline, or the edge's 'no available server' hang)", async () => {
    mockedEdgeFetch
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(new Response("{}", { status: 200 }));

    joinWaitlistOnce({ email: freshEmail(), userId: "u-5" });
    await drain();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(3);
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports the network error text when every attempt throws", async () => {
    mockedEdgeFetch.mockRejectedValue(new Error("Failed to fetch"));

    joinWaitlistOnce({ email: freshEmail(), userId: "u-6" });
    await drain();

    expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockedCaptureMessage.mock.calls[0]![1]).toMatchObject({
      extra: { status: null, networkError: "Failed to fetch", attempts: 3 },
    });
  });

  it("does nothing at all without an email", async () => {
    joinWaitlistOnce({ email: "   ", userId: "u-7" });
    await drain();

    expect(mockedEdgeFetch).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });
});
