// US-3198 AC4: the extension-queue notice is opt-out, and the opt-out has to be
// the same string on both sides of the wire.
//
// The edge reads users.notification_preferences with a bare key
// (EXTENSION_QUEUE_PREF_KEY in lib/extension-queue-stale.ts) and the settings
// screen writes it from NOTIFICATION_TYPES. Nothing links them. Rename either
// and both keep compiling, both keep passing their own suites, and the toggle
// silently gates nothing: notify.ts defaults an unknown category to ON, so a
// seller who turned it off keeps being pushed and has no way to tell.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_TYPES,
} from "@/lib/notification-preferences";

const root = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** The one string. */
const PREF_KEY = "extension_queue_reminders";

describe("US-3198: the queue-stale opt-out is wired end to end", () => {
  it("the edge gates the push on exactly this key", () => {
    expect(read("services/edge-functions/src/lib/extension-queue-stale.ts")).toContain(
      `export const EXTENSION_QUEUE_PREF_KEY = "${PREF_KEY}";`,
    );
  });

  it("the settings screen renders a toggle for it", () => {
    // NOTIFICATION_TYPES is what settings.tsx maps over, so an entry here is
    // the switch. A default with no entry is an opt-out nobody can reach.
    expect(NOTIFICATION_TYPES.some((t) => t.key === PREF_KEY)).toBe(true);
    expect(DEFAULT_NOTIFICATION_PREFERENCES[PREF_KEY]).toBeDefined();
  });

  it("it ships ON, because a notice nobody asked for is not an opt-out", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES[PREF_KEY].push).toBe(true);
  });

  it("it offers the push channel and only the push channel", () => {
    // A channel listed here is a promise the settings screen makes. There is no
    // in-app row behind this notice (the queue tray is the in-app surface) and
    // no email, so listing either would render a switch that controls nothing.
    const meta = NOTIFICATION_TYPES.find((t) => t.key === PREF_KEY)!;
    expect(meta.channels).toEqual(["push"]);
  });

  it("its description promises what it actually sends, and blames nobody", () => {
    // US-2560's rule: the category copy IS the agreement. This one has a second
    // job, because the notice fires over a closed laptop rather than a fault --
    // the sentence must not read as an error report.
    const meta = NOTIFICATION_TYPES.find((t) => t.key === PREF_KEY)!;
    const text = meta.description.toLowerCase();
    expect(text).toContain("waiting");
    expect(text).toContain("extension");
    for (const blame of ["failed", "error", "problem", "you forgot", "you did not"]) {
      expect(text).not.toContain(blame);
    }
  });

  it("it does not ride on delist_reminders, whose copy forbids it", () => {
    // "It promises a reminder about the seller's OWN still-live listings after a
    // sale, and nothing else may be routed here." A queue that has not drained
    // is not that, and folding it in would make a sentence somebody already
    // agreed to retroactively false.
    const delist = NOTIFICATION_TYPES.find((t) => t.key === "delist_reminders")!;
    expect(delist.description).not.toMatch(/queue|extension/i);
    expect(read("services/edge-functions/src/routes/jobs-extension-queue-stale.ts"))
      .not.toContain("delist_reminders");
  });
});
