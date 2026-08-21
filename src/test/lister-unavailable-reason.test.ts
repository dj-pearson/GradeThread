// US-2720 AC2: the notice never states a cause it cannot verify.
//
// The Listing Kit used to just hide the cross-post button, so a seller without
// the extension concluded the feature was never built. It now names the reason —
// which only helps if the reason is right. There are exactly two it can tell
// apart, and they need opposite actions from the seller:
//
//   "disabled"       cross-posting is off for this deployment. Nothing the
//                    seller installs will help.
//   "not-installed"  it is on, and no transport is present. Installing the
//                    extension fixes it.
//
// Telling an unsupported seller to install something, or telling someone with a
// working install that the feature is switched off, is worse than the silence
// this replaced.
//
// cross-post-setup.test.ts covers this with source scans — it asserts the
// function is exported and that its body mentions both strings. That pins the
// shape, not the mapping. The function is importable, so the mapping can just be
// exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function reasonWith({
  flag,
  bridge,
  chromeRuntime,
  extId,
}: {
  flag: string;
  bridge: boolean;
  chromeRuntime?: boolean;
  extId?: string;
}) {
  vi.stubEnv("VITE_LISTER_EXTENSION", flag);
  vi.stubEnv("VITE_LISTER_EXTENSION_ID", extId ?? "");
  if (bridge) document.documentElement.dataset.gtExtBridge = "1";
  else delete document.documentElement.dataset.gtExtBridge;
  if (chromeRuntime) {
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: () => {} },
    };
  } else {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  }
  vi.resetModules();
  const mod = await import("@/lib/lister-extension");
  return {
    reason: mod.listerUnavailableReason(),
    available: mod.isListerAvailable(),
  };
}

describe("US-2720: which cause the notice is allowed to state", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    delete document.documentElement.dataset.gtExtBridge;
    vi.resetModules();
  });

  it("flag off is 'disabled', whatever is installed", () => {
    // The flag losing to a present extension would tell a seller on an
    // unsupported deployment to go and install something.
    return Promise.all([
      reasonWith({ flag: "false", bridge: false }),
      reasonWith({ flag: "false", bridge: true }),
      reasonWith({ flag: "", bridge: true }),
    ]).then((results) => {
      for (const r of results) {
        expect(r.reason).toBe("disabled");
        expect(r.available).toBe(false);
      }
    });
  });

  it("flag on with the bridge present is no reason at all", async () => {
    const r = await reasonWith({ flag: "true", bridge: true });
    expect(r.reason).toBeNull();
    expect(r.available).toBe(true);
  });

  it("flag on with nothing present is 'not-installed'", async () => {
    const r = await reasonWith({ flag: "true", bridge: false });
    expect(r.reason).toBe("not-installed");
    expect(r.available).toBe(false);
  });

  it("the Chromium fallback counts as installed, but only WITH an id", async () => {
    // chrome.runtime can be present because of somebody else's extension, so
    // the configured id is what makes it our transport.
    const withId = await reasonWith({
      flag: "true", bridge: false, chromeRuntime: true, extId: "abcdefghijklmnop",
    });
    expect(withId.reason).toBeNull();

    const noId = await reasonWith({
      flag: "true", bridge: false, chromeRuntime: true, extId: "",
    });
    expect(
      noId.reason,
      "a chrome.runtime from ANOTHER extension was read as our transport",
    ).toBe("not-installed");
  });

  it("the flag is exact-match, so a stale '1' or 'yes' does not enable it", async () => {
    for (const flag of ["1", "yes", "TRUE", "on"]) {
      const r = await reasonWith({ flag, bridge: true });
      expect(r.reason, `${flag} was treated as enabled`).toBe("disabled");
    }
  });

  it("only ever returns one of the two causes, or null", async () => {
    const seen = new Set<string | null>();
    for (const flag of ["true", "false"]) {
      for (const bridge of [true, false]) {
        seen.add((await reasonWith({ flag, bridge })).reason);
      }
    }
    for (const r of seen) {
      expect(["disabled", "not-installed", null]).toContain(r);
    }
  });
});
