// Guards the desktop share regression: navigator.share EXISTING is not
// sufficient reason to open the native sheet.
//
// Desktop Chrome/Edge on Windows implement navigator.share, so the original
// `typeof navigator.share === "function"` check routed desktop users into the
// Windows share sheet — a modal offering Mail, printers and nearby-sharing that
// cannot post to X, and which reads as the share button being broken. The gate
// now also requires a coarse PRIMARY pointer, which is true on phones/tablets
// and false on desktop (including touchscreen laptops driven by a mouse).

import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersNativeShare } from "@/lib/share";

/** Install a navigator.share + a matchMedia that reports the given pointer. */
function stubEnv(opts: { hasShare: boolean; coarsePointer: boolean }) {
  if (opts.hasShare) {
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
  } else {
    vi.stubGlobal("navigator", {});
  }
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: q.includes("coarse") && opts.coarsePointer }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("prefersNativeShare", () => {
  it("is FALSE on desktop even though navigator.share exists (the regression)", () => {
    stubEnv({ hasShare: true, coarsePointer: false });
    expect(prefersNativeShare()).toBe(false);
  });

  it("is true on a touch device that supports sharing", () => {
    stubEnv({ hasShare: true, coarsePointer: true });
    expect(prefersNativeShare()).toBe(true);
  });

  it("is false when the API is absent, regardless of pointer", () => {
    stubEnv({ hasShare: false, coarsePointer: true });
    expect(prefersNativeShare()).toBe(false);
  });

  it("does not throw when matchMedia is unavailable (older/SSR-ish runtimes)", () => {
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
    vi.stubGlobal("window", {});
    expect(() => prefersNativeShare()).not.toThrow();
    expect(prefersNativeShare()).toBe(false);
  });
});
