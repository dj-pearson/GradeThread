// The one copy action on the referral page: named for what it copies, says
// "Copied" to screen readers too, and never claims success on a failed copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { CopyButton } from "@/components/referral/copy-button";

let root: Root | null = null;
let container: HTMLDivElement;
const writeText = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  writeText.mockReset();
  toastError.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function mount() {
  act(() => {
    root = createRoot(container);
    root.render(<CopyButton value="https://gradethread.com/signup?ref=A" label="referral link" />);
  });
  return container.querySelector("button")!;
}

describe("CopyButton", () => {
  it("is named for what it copies", () => {
    const btn = mount();
    expect(btn.getAttribute("aria-label")).toBe("Copy referral link");
  });

  it("announces Copied after a successful copy", async () => {
    writeText.mockResolvedValue(undefined);
    const btn = mount();
    await act(async () => {
      btn.click();
    });
    expect(writeText).toHaveBeenCalledWith("https://gradethread.com/signup?ref=A");
    expect(btn.getAttribute("aria-label")).toBe("Copied");
    expect(container.querySelector("[aria-live=polite]")!.textContent).toBe("Copied");
  });

  it("shows no success state when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const btn = mount();
    await act(async () => {
      btn.click();
    });
    expect(btn.getAttribute("aria-label")).toBe("Copy referral link");
    expect(container.querySelector("[aria-live=polite]")!.textContent).toBe("");
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
