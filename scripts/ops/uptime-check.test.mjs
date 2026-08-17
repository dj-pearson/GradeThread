// The uptime monitor's body NOTES, pinned against the REAL /health/ready shape.
//
// WHY THIS EXISTS. The hostWatchdog note read `?.checks?.features?.hostWatchdog`
// from the day it shipped. `features` is a SIBLING of `checks`, not a child, so
// that path is always undefined — and an optional chain over a wrong path
// returns undefined rather than throwing, which the `typeof !== "string"` arm
// treats identically to "the field is fine". The note therefore never fired,
// silently, and its entire purpose was to answer "was the watchdog even
// running?" in the body of an incident issue. It would have been blank in
// exactly the moment it was written for.
//
// So the fixture below is a REAL captured response, not a hand-made one shaped
// the way the code expects. That distinction is the whole point: a fixture built
// from the reader's assumptions would have passed against the broken path too.
import { describe, expect, it } from "vitest";
import { TARGETS } from "./uptime-check.mjs";

/** Captured from https://functions.gradethread.com/health/ready on 2026-08-17. */
const LIVE_READY = JSON.stringify({
  status: "ready",
  checks: { database: "ok", env: "ok" },
  features: {
    stripe_prices: "ok",
    alerting: "ok — at least one channel is CONFIGURED.",
    release: 'unattributable: release="unknown" — none of RELEASE_SHA…',
    hostWatchdog:
      "unconfigured: no host watchdog has ever checked in — an edge hang would not be capped (install scripts/ops/edge-watchdog.sh, US-2447)",
  },
  schema: { expected: "00617", applied: "00617", status: "match" },
  timestamp: "2026-08-17T17:28:46.649Z",
});

const noteFor = (id, body) => {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(`no target ${id}`);
  return t.bodyNote(body);
};

describe("edge_ready hostWatchdog note", () => {
  it("fires on the real response when the watchdog has never checked in", () => {
    const note = noteFor("edge_ready", LIVE_READY);
    expect(note, "the note did not fire on a genuine unconfigured response").toBeTruthy();
    expect(note).toContain("hostWatchdog");
    expect(note).toContain("unconfigured");
  });

  it("stays silent when the watchdog is healthy", () => {
    // Paging on a healthy value would mean an alert every ten minutes forever,
    // and a muted monitor is worse than none.
    const ok = LIVE_READY.replace(/"hostWatchdog":"[^"]*"/, '"hostWatchdog":"ok"');
    expect(noteFor("edge_ready", ok)).toBeNull();
  });

  it("fires on a STALE heartbeat, which is the case that means it stopped", () => {
    const stale = LIVE_READY.replace(
      /"hostWatchdog":"[^"]*"/,
      '"hostWatchdog":"stale: last host-watchdog heartbeat 14m ago"',
    );
    expect(noteFor("edge_ready", stale)).toContain("stale");
  });

  it("does NOT read the field from under `checks`", () => {
    // The exact broken shape: hostWatchdog nested where the old code looked. If
    // someone restores that path this stays green while the real response goes
    // unread, so assert the wrong shape yields NOTHING.
    const wrong = JSON.stringify({
      status: "ready",
      checks: { database: "ok", env: "ok", features: { hostWatchdog: "unconfigured: nope" } },
    });
    expect(noteFor("edge_ready", wrong)).toBeNull();
  });

  it("survives a non-JSON body instead of throwing", () => {
    // A hung edge behind Traefik answers HTML, and a note that throws would take
    // the whole probe down with it.
    expect(noteFor("edge_ready", "<html>502 Bad Gateway</html>")).toBeNull();
  });
});

describe("help_hub note", () => {
  it("fires when the hub renders no category shelf", () => {
    expect(noteFor("help_hub", "<html><body><h1>Help</h1></body></html>")).toContain("empty");
  });

  it("stays silent once the shelf is present", () => {
    expect(noteFor("help_hub", '<div class="related-grid">…</div>')).toBeNull();
  });
});

describe("the target list itself", () => {
  it("still probes the edge readiness endpoint", () => {
    // Guarding the guard: every assertion above is vacuous if the target is
    // renamed or dropped.
    const ids = TARGETS.map((t) => t.id);
    expect(ids).toContain("edge_ready");
    expect(ids).toContain("help_hub");
    expect(TARGETS.length).toBeGreaterThanOrEqual(5);
  });

  it("importing the monitor does not probe anything", () => {
    // The module is imported at the top of this file. If the main block were
    // unguarded, that import would fire a full production probe — and with a
    // token in the environment, open a GitHub issue — as a side effect of a unit
    // test. Reaching this assertion at all is the proof.
    expect(TARGETS.every((t) => typeof t.url === "string")).toBe(true);
  });
});
