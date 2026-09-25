// A 429 is two different things: the monthly quota (actions_remaining 0) and
// the per-minute rate limiter. Only the first may say "Monthly AI limit".
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ error: vi.fn(), toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: h.error } }));
vi.mock("@/lib/toast-error", () => ({ toastError: h.toastError }));

const { aiErrorToast } = await import("@/hooks/use-ai-extract");

const err = (extra: Record<string, unknown>) =>
  Object.assign(new Error("slow down"), { status: 429 }, extra);

beforeEach(() => {
  h.error.mockReset();
  h.toastError.mockReset();
});

describe("aiErrorToast on 429", () => {
  it("says monthly limit only when no actions remain", () => {
    aiErrorToast(err({ actions_remaining: 0 }));
    expect(h.toastError).toHaveBeenCalledWith(expect.anything(), "Monthly AI limit reached.");
  });

  it("says try again, with the wait, for a rate limit", () => {
    aiErrorToast(err({ actions_remaining: 12, retryAfter: 30 }));
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith("Too many AI requests. Try again in 30 seconds.");
  });
});
