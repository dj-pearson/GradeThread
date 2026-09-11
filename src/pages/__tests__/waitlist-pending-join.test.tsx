// US-3379: /waitlist-pending fires a background POST that puts the account on
// the waitlist it is telling them they are on. edgeFetch resolves on a non-2xx
// rather than throwing, so the old `void edgeFetch(...).catch(() => {})` wrote
// no row and said nothing to anyone.
//
// ⚠ BOTH HALVES OR NEITHER. Every case here asserts the visitor's experience is
// unchanged AND that the operator signal did or did not fire. Asserting only the
// Sentry call would let a regression that puts an error in front of the visitor
// pass; asserting only the page would restore the original defect exactly.
//
// The reproduction this replaces: with the pre-fix page, the 500 case below
// passed with `expect(captureMessage).not.toHaveBeenCalled()` - one edgeFetch
// call, "You're on the waitlist" rendered, and zero operator signal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { edgeFetch } from "@/lib/edge-fetch";
import { captureMessage } from "@/lib/sentry";
import { toast } from "sonner";
import { WaitlistPendingPage } from "@/pages/waitlist-pending";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/lib/sentry", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ signOut: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

// joinWaitlistOnce memoises per email for the life of the module, which is the
// point of it - so each case needs its own address or the second render is a
// no-op and the test would pass by doing nothing.
let currentEmail = "";
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({
      user: { id: "11111111-2222-3333-4444-555555555555", email: currentEmail },
      profile: { full_name: "Vee Isitor" },
    }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedEdgeFetch = vi.mocked(edgeFetch);
const mockedCaptureMessage = vi.mocked(captureMessage);
const mockedToast = vi.mocked(toast);

let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(): Promise<HTMLDivElement> {
  currentEmail = `visitor-${++seq}@example.com`;
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(h(MemoryRouter, null, h(WaitlistPendingPage)));
  });
  // Past every backoff, so a failed sequence has finished reporting.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  return container;
}

/** What the visitor sees, in every case. Never allowed to differ. */
function assertVisitorUnchanged(el: HTMLDivElement) {
  expect(el.textContent).toContain("You're on the waitlist");
  expect(el.textContent).toContain("Your account is in the queue");
  expect(el.textContent).not.toMatch(/error|failed|sorry|try again/i);
  expect(mockedToast.error).not.toHaveBeenCalled();
  expect(mockedToast.warning).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("WaitlistPendingPage background join (US-3379)", () => {
  it("2xx: the row is written, the visitor sees the queue page, nothing is reported", async () => {
    mockedEdgeFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const el = await render();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(1);
    assertVisitorUnchanged(el);
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("500 every time: the visitor sees the SAME page and the operator gets a Sentry error", async () => {
    mockedEdgeFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    const el = await render();

    // The visitor half - AC2. Identical to the 2xx case above.
    assertVisitorUnchanged(el);

    // The operator half - AC3. One issue, level error, tagged so a Sentry alert
    // rule can route it, and carrying the account UUID rather than the email.
    expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = mockedCaptureMessage.mock.calls[0]!;
    expect(message).toBe("waitlist join lost");
    expect(ctx).toMatchObject({
      level: "error",
      tags: { area: "waitlist.join" },
      extra: {
        userId: "11111111-2222-3333-4444-555555555555",
        source: "signup-gated",
        status: 500,
        attempts: 3,
      },
    });
    // GDPR: the email never reaches Sentry.
    expect(JSON.stringify(ctx)).not.toContain("@example.com");
  });

  it("a transient 503 that recovers: no signal, and the visitor never knew", async () => {
    mockedEdgeFetch
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const el = await render();

    expect(mockedEdgeFetch).toHaveBeenCalledTimes(2);
    assertVisitorUnchanged(el);
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });
});
