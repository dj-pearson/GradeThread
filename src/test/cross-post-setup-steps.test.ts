import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSteps } from "@/components/flipdesk/cross-post-setup";
import type { ExtensionSetupState } from "@/hooks/use-extension-setup";

// US-2719 AC1 and AC7, CALLED rather than grepped.
//
// The screen tells a seller which of the gates between them and a working
// cross-post is the one that is not met. The existing guards in
// cross-post-setup.test.ts assert that strings like `caps.authenticated === true`
// appear in the hook's source. That pins the SPELLING and not the answer: an
// inverted gate, a step ordered wrongly, or a green badge shown over a plan
// check that will refuse the first send all read identically to a scan.
//
// This is the same correction US-2739 needed. Its AC5 claimed "six cases
// pinned" and the six were asserting against a re-implementation of the code
// they were meant to guard; changing the real function to Math.floor left them
// all green. Extracting the function and calling it was the fix there too.
//
// Rendering is not the alternative: there is no @testing-library/react in this
// repo. buildSteps is where the state lives, so calling it is the honest test —
// what it returns is exactly what the rows display.

function state(over: Partial<ExtensionSetupState> = {}): ExtensionSetupState {
  return {
    installed: false,
    reachable: false,
    signedIn: false,
    sellerEnabled: false,
    tosAccepted: false,
    channels: [],
    version: null,
    unavailable: null,
    ...over,
  };
}

const READY = [
  { platform: "poshmark", label: "Poshmark", canList: true, canDelist: false },
  { platform: "mercari", label: "Mercari", canList: false, canDelist: false },
] as ExtensionSetupState["channels"];

const ALL_DONE = state({
  installed: true,
  reachable: true,
  signedIn: true,
  sellerEnabled: true,
  tosAccepted: true,
  channels: READY,
});

function stateOf(s: ExtensionSetupState, key: string) {
  const step = buildSteps(s).find((x) => x.key === key);
  expect(step, `there is no "${key}" step`).toBeTruthy();
  return step!.state;
}

beforeEach(() => {
  vi.stubEnv("VITE_LISTER_EXTENSION_ID", "apinefjjagmigmobdlbiilhbjebmjkdh");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the setup steps (US-2719)", () => {
  it("are the five gates, in order", () => {
    // FIVE, not the four the story named. Signed-in and paid-plan are separate
    // observable facts, and folding them together would show a green step to a
    // free account whose first send fails with needsUpgrade.
    expect(buildSteps(state()).map((s) => s.key)).toEqual([
      "install",
      "signin",
      "plan",
      "terms",
      "channel",
    ]);
  });

  it("a fresh browser has nothing done", () => {
    expect(buildSteps(state()).every((s) => s.state !== "done")).toBe(true);
  });

  it("everything satisfied marks every step done", () => {
    expect(buildSteps(ALL_DONE).every((s) => s.state === "done")).toBe(true);
  });
});

describe("each gate is read from its own signal (US-2719 AC2/AC3)", () => {
  it("installed is the bridge marker, and it alone", () => {
    expect(stateOf(state({ installed: true }), "install")).toBe("done");
    // Being signed in does not imply the extension is here.
    expect(stateOf(state({ signedIn: true }), "install")).toBe("todo");
  });

  it("signed in does not turn on the plan step", () => {
    // The bug this prevents: one green tick for two different facts, so a free
    // account is told it is ready and the first send fails with needsUpgrade.
    const s = state({ installed: true, signedIn: true });
    expect(stateOf(s, "signin")).toBe("done");
    expect(stateOf(s, "plan")).toBe("blocked");
  });

  it("the plan step is 'todo' before sign-in and 'blocked' after", () => {
    // Before sign-in we do not KNOW the plan, so claiming it is blocked would be
    // inventing a refusal. After, the extension has answered and the answer is no.
    expect(stateOf(state(), "plan")).toBe("todo");
    expect(stateOf(state({ signedIn: true }), "plan")).toBe("blocked");
    expect(stateOf(state({ signedIn: true, sellerEnabled: true }), "plan")).toBe("done");
  });

  it("terms come only from the extension's own answer", () => {
    expect(stateOf(state({ tosAccepted: true }), "terms")).toBe("done");
    // Not implied by anything else. An older build that does not report
    // acceptance must read as not-yet, never as done.
    expect(
      stateOf(
        state({ installed: true, signedIn: true, sellerEnabled: true, channels: READY }),
        "terms",
      ),
    ).toBe("todo");
  });
});

describe("the channel step needs all three, not just a channel (US-2719)", () => {
  it("a ready channel alone is not enough", () => {
    // It is the last step for a reason: a channel this build can fill is
    // useless to an account that has not accepted the terms or has no plan.
    expect(stateOf(state({ channels: READY }), "channel")).toBe("todo");
  });

  it("terms without a plan is not enough, and neither is the reverse", () => {
    expect(stateOf(state({ channels: READY, tosAccepted: true }), "channel")).toBe("todo");
    expect(stateOf(state({ channels: READY, sellerEnabled: true }), "channel")).toBe("todo");
  });

  it("a channel this build cannot LIST does not count", () => {
    // canList is per-build: the platform being accepted is not the same as its
    // selectors being verified in the installed version.
    const unverified = [
      { platform: "mercari", label: "Mercari", canList: false, canDelist: true },
    ] as ExtensionSetupState["channels"];
    expect(
      stateOf(
        state({ channels: unverified, tosAccepted: true, sellerEnabled: true }),
        "channel",
      ),
    ).toBe("todo");
  });

  it("names the channels that are actually ready", () => {
    const step = buildSteps(ALL_DONE).find((s) => s.key === "channel")!;
    expect(step.body).toContain("Poshmark");
    // Mercari's canList is false in this build, so promising it would send the
    // seller to a tab whose send reports "list manually".
    expect(step.body).not.toContain("Mercari");
  });
});

describe("the install CTA (US-2719 AC4)", () => {
  it("offers an action when the store URL resolves", () => {
    expect(buildSteps(state()).find((s) => s.key === "install")!.action).toBeTruthy();
  });

  it("still resolves a store, and never /buyer/settings, with both vars blank", () => {
    // This case used to assert the OPPOSITE half of AC4: with no id configured
    // there was no store URL, so the step had to render a sentence rather than
    // a dead control. US-3110 removed the "no store URL" state — the extension
    // is published, and src/lib/app-links.ts falls back to the real listing
    // instead of to null, so a blank deployment gets a working link rather than
    // a working explanation of why there is no link.
    //
    // The rule AC4 exists for is unchanged and still checked: never fall back
    // to /buyer/settings, which is not where anyone gets an extension.
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "");
    vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "");
    const action = buildSteps(state()).find((s) => s.key === "install")!.action;
    expect(JSON.stringify(action)).toContain("chromewebstore");
    expect(JSON.stringify(action)).not.toContain("/buyer/settings");
  });
});
