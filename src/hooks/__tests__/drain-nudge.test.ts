// US-3143 — the web's "drain now" nudge, both halves.
//
// Since US-3141 a sale queues the sibling's delist by itself and the extension's
// 5-minute alarm runs it. The nudge only changes WHEN, which is precisely why it
// needs testing: every way of getting it wrong still ends with the listing
// delisted eventually, so nothing fails loudly.
//
// Two rules live here. planDrainNudge decides WHETHER to send, and it is the one
// that keeps a tab left open all day from re-asking on every refetch and window
// focus. requestDrainNow decides what leaving the page looks like, and it must
// degrade to silence for every reason a seller is not at fault for.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planDrainNudge } from "../use-pending-delists";
import { requestDrainNow, resetDrainNudgeThrottle } from "@/lib/lister-extension";

describe("planDrainNudge", () => {
  it("sends when work first appears", () => {
    expect(planDrainNudge(3, false)).toEqual({ send: true, nudged: true });
  });

  it("does not send again while the work is still there", () => {
    // The refetch case. The extension is already draining; asking twice buys
    // nothing and is what turns an open tab into a poller.
    expect(planDrainNudge(3, true)).toEqual({ send: false, nudged: true });
    expect(planDrainNudge(1, true)).toEqual({ send: false, nudged: true });
  });

  it("re-arms once the queue empties, and sends again on the next arrival", () => {
    const drained = planDrainNudge(0, true);
    expect(drained).toEqual({ send: false, nudged: false });
    // A second sale later in the same session must still get its nudge.
    expect(planDrainNudge(2, drained.nudged)).toEqual({ send: true, nudged: true });
  });

  it("treats an unloaded query as neither work nor an empty queue", () => {
    // The subtle one. null is 'we do not know yet', and it must NOT clear the
    // latch: a refetch renders undefined data for a tick, and clearing there
    // would make the very next result look like work newly arriving.
    expect(planDrainNudge(null, true)).toEqual({ send: false, nudged: true });
    expect(planDrainNudge(null, false)).toEqual({ send: false, nudged: false });
  });
});

describe("requestDrainNow", () => {
  let sent: unknown[] = [];

  /**
   * Stand in for the installed extension on the Chromium transport.
   *
   * The postMessage bridge is the other transport and is NOT used here: jsdom
   * leaves `event.source` null on a same-window postMessage, so sendViaBridge's
   * `event.source !== window` guard drops its own reply and the send sits out
   * its full 130-second timeout. That is a jsdom limitation, not a bug in the
   * bridge — but it makes the runtime path the only one testable in this repo.
   */
  function installExtension(reply: unknown): void {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: (_id: string, message: unknown, cb: (r: unknown) => void) => {
          sent.push(message);
          cb(reply);
        },
      },
    };
  }

  beforeEach(() => {
    sent = [];
    resetDrainNudgeThrottle();
    vi.stubEnv("VITE_LISTER_EXTENSION", "true");
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "test-extension-id");
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.unstubAllEnvs();
  });

  it("reports a real drain, and sends a message carrying nothing but its type", async () => {
    installExtension({ ok: true, drained: true, state: "ok" });
    const res = await requestDrainNow();
    expect(res).toEqual({ drained: true, state: "ok" });

    // The property the extension's whole acceptance of this message rests on.
    // A listing id, a URL or a platform in here would make gradethread.com a
    // page that can steer the browser.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "GT_DRAIN_NOW" });
  });

  it("passes the extension's refusal through instead of inventing success", async () => {
    // A lapsed FlipDesk plan. The seller sees no error (nothing reads this), but
    // reporting it as `drained` would make any future caller believe the
    // listing was handled.
    installExtension({ ok: true, drained: false, state: "not-allowed" });
    expect(await requestDrainNow()).toEqual({ drained: false, state: "not-allowed" });
  });

  it("an empty queue is not a drain", async () => {
    installExtension({ ok: true, drained: false, state: "empty" });
    expect(await requestDrainNow()).toEqual({ drained: false, state: "empty" });
  });

  it("throttles a second ask, without sending it", async () => {
    installExtension({ ok: true, drained: true, state: "ok" });
    await requestDrainNow();
    const second = await requestDrainNow();
    expect(second).toEqual({ drained: false, state: "throttled" });
    // Not merely refused: it never left the page.
    expect(sent).toHaveLength(1);
  });

  it("is silent when the extension is not installed", async () => {
    // No bridge marker, no chrome.runtime. This is the majority case and it
    // must cost nothing and say nothing: the queue still drains at browser
    // start on whatever machine has the extension.
    expect(await requestDrainNow()).toEqual({ drained: false, state: "unavailable" });
    expect(sent).toHaveLength(0);
  });

  it("is silent when the deployment has the feature switched off", async () => {
    vi.stubEnv("VITE_LISTER_EXTENSION", "false");
    installExtension({ ok: true, drained: true, state: "ok" });
    expect(await requestDrainNow()).toEqual({ drained: false, state: "unavailable" });
    expect(sent).toHaveLength(0);
  });

  it("treats an older extension that does not know the message as unavailable", async () => {
    // A build predating this story answers the unknown type with ok:false. That
    // is not an error the seller caused, so it degrades like a missing install.
    installExtension({ ok: false, error: "Unknown message." });
    expect(await requestDrainNow()).toEqual({ drained: false, state: "unavailable" });
  });
});
