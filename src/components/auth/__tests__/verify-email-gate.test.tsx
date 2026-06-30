// US-1431: the resend button uses a ticking cooldown (not a permanent lock) and
// surfaces a GoTrue 429 distinctly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resendConfirmationEmail } from "@/lib/auth";
import { toast } from "sonner";
import { AUTH_RATE_LIMIT_MESSAGE } from "@/lib/auth-error";
import { VerifyEmailGate } from "@/components/auth/verify-email-gate";

vi.mock("@/lib/auth", () => ({
  resendConfirmationEmail: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// React 19 requires this flag for act() to flush effects in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mockedResend = vi.mocked(resendConfirmationEmail);
const mockedToast = vi.mocked(toast);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(VerifyEmailGate, { email: "user@example.com" }));
  });
}

function resendButton(): HTMLButtonElement {
  // The first button in the card is the resend control.
  return container!.querySelector("button") as HTMLButtonElement;
}

async function clickResend() {
  await act(async () => {
    resendButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedResend.mockReset();
  mockedToast.success.mockReset();
  mockedToast.error.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("VerifyEmailGate resend cooldown (US-1431)", () => {
  it("starts a ticking cooldown after a successful resend, then re-enables", async () => {
    mockedResend.mockResolvedValue(undefined as never);
    render();

    expect(resendButton().textContent).toContain("Resend confirmation email");
    expect(resendButton().disabled).toBe(false);

    await clickResend();

    // AC1/AC2: disabled with the remaining seconds in the label.
    expect(mockedResend).toHaveBeenCalledWith("user@example.com");
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toContain("Resend in 45s");

    // Ticks down each second.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(resendButton().textContent).toContain("Resend in 44s");

    // AC1: after the full cooldown elapses the button re-enables (not a
    // permanent lock). Advance one second at a time so React flushes the effect
    // that re-schedules the next tick between each timer firing.
    for (let i = 0; i < 45; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resendButton().disabled).toBe(false);
    expect(resendButton().textContent).toContain("Resend confirmation email");
  });

  it("surfaces a 429 distinctly and starts the cooldown (AC3)", async () => {
    mockedResend.mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    render();

    await clickResend();

    expect(mockedToast.error).toHaveBeenCalledWith(AUTH_RATE_LIMIT_MESSAGE);
    expect(mockedToast.success).not.toHaveBeenCalled();
    // The cooldown still starts so the user stops hammering the rate limit.
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toContain("Resend in 45s");
  });
});
