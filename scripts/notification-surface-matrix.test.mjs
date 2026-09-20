// US-3356: a notification category must not reach fewer surfaces than the ones
// beside it without somebody having decided that.
//
// WHY A REGISTRY RATHER THAN A BARE RULE. Every gap below is real, and not all
// of them are bugs: one client raises a category locally, and one preference
// key is deliberately browser-only because the thing it wakes IS a browser
// extension. A bare rule would fail on all of them and get suppressed. So each
// gap is named with the reason it stays, and — like knownNoise in
// check-ui-antipatterns.mjs — an entry that stops matching ALSO fails, so the
// list can only shrink.
//
// THE MEASURED CONSEQUENCE, so nobody reads the Android list as cosmetic. A
// payload naming a category Android does not declare is NOT dropped:
// PushCategory.of returns null, PushMessage.channel falls back to
// PushChannel.UPDATES, and actions comes back empty. UPDATES is the
// low-importance channel that PushCategory.kt's own comment says a seller mutes
// when they want payout chatter gone. So a payment dispute and a case DEADLINE
// currently arrive on the channel most likely to be muted, with no inline
// action, on Android only.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  androidCategories,
  catalogPrefKeys,
  categoryGaps,
  emittedCategories,
  iosCategories,
  prefKeyByType,
  webPrefKeys,
  webPushOnly,
} from "./notification-surface-matrix.mjs";

/** Edge-sent categories a client does not declare, and why that stands today. */
const KNOWN_CLIENT_GAPS = {
  android: {
    "cancellation.requested": "US-3356: Android declares 12 of the 14 shapes the edge sends and " +
      "the 7 it misses are the whole post-sale case family. Fixing it is an Android change " +
      "(PushCategory.kt plus its channel and action mapping) and is out of this story's scope; " +
      "what this story owes is that the gap is visible rather than silent.",
    "case.deadline": "Same Android gap. This is the sharpest of the seven: a case deadline is a " +
      "clock, and it currently lands on the low-importance UPDATES channel.",
    "case.opened": "Same Android gap.",
    "dispute.opened": "Same Android gap. A payment dispute on the channel a seller mutes first.",
    "inquiry.opened": "Same Android gap.",
    "offer.responded": "Same Android gap. offer.received IS declared, so a seller gets the offer " +
      "on SELLING and the reply on UPDATES.",
    "return.opened": "Same Android gap.",
  },
  ios: {},
};

/** Categories a client declares that the edge never sends. */
const CLIENT_ONLY = {
  "grade.ready": "RAISED LOCALLY, not a hole: ios/GradeThread/Background/NewGradeNotifier.swift " +
    "sets it on a notification the app schedules itself after a background refresh.",
  "aging.digest": "Declared by both clients and sent by nothing. Kept because the routing for it " +
    "already exists in NotificationDelegate; if no digest push is ever built, the declaration " +
    "should come out rather than this entry growing a second reason.",
  "message.received": "Same shape as aging.digest: routed by both clients, sent by nothing.",
  "payout.posted": "Same shape as aging.digest. payout.CLEARED is the one the edge sends.",
  "support.reply": "Same shape as aging.digest.",
};

/** Preference keys that legitimately reach browser web push only. */
const WEB_PUSH_ONLY = {
  extension_queue_reminders:
    "US-3198/US-3356: the thing it wakes is the browser extension, which exists only in a " +
    "desktop browser. An iOS or Android category for it would describe work the phone cannot " +
    "do, and an in-app row would outlive the condition — the notice is a standing state, not " +
    "an event, so the next run says it again if it is still true.",
};

const emitted = emittedCategories();
const ios = iosCategories();
const android = androidCategories();
const keys = webPrefKeys();
const byType = prefKeyByType();
const catalog = catalogPrefKeys();

describe("US-3356: notification surface coverage", () => {
  it("parsed every source (guards the guard)", () => {
    // Each assertion below reads as a pass on an empty parse, and four of the
    // five sources are in languages this file cannot type-check.
    expect(emitted.length, "no push categories parsed from transactional-push.ts")
      .toBeGreaterThanOrEqual(14);
    expect(ios.length, "no categories parsed from NotificationCategories.swift")
      .toBeGreaterThanOrEqual(19);
    expect(android.length, "no categories parsed from PushCategory.kt")
      .toBeGreaterThanOrEqual(12);
    expect(keys.length, "no pref keys parsed from notification-preferences.ts")
      .toBeGreaterThanOrEqual(18);
    expect(Object.keys(byType).length, "no PREF_KEY map parsed from notify.ts")
      .toBeGreaterThanOrEqual(28);
    expect(catalog.size, "no catalog entries parsed").toBeGreaterThanOrEqual(10);
  });

  it("every category the edge sends is declared by iOS, or registered", () => {
    const gaps = categoryGaps({ emitted, ios, android });
    expect(
      gaps.ios.filter((c) => !(c in KNOWN_CLIENT_GAPS.ios)).sort(),
      "the edge stamps this category on a push and iOS does not declare it",
    ).toEqual([]);
  });

  it("every category the edge sends is declared by Android, or registered", () => {
    const gaps = categoryGaps({ emitted, ios, android });
    expect(
      gaps.android.filter((c) => !(c in KNOWN_CLIENT_GAPS.android)).sort(),
      "the edge stamps this category on a push and Android does not declare it. It will " +
        "still arrive, on the low-importance UPDATES channel with no inline action.",
    ).toEqual([]);
  });

  it("every category a client declares is sent, or registered", () => {
    const declared = [...new Set([...ios, ...android])].sort();
    expect(
      declared.filter((c) => !emitted.includes(c) && !(c in CLIENT_ONLY)),
      "a client declares a category nothing sends. Register it with why, or delete it.",
    ).toEqual([]);
  });

  it("every push-capable preference key reaches more than the browser, or is registered", () => {
    expect(
      webPushOnly({ keys, byType, catalog }).filter((k) => !(k in WEB_PUSH_ONLY)),
      "this preference key can push, but no notification_type gates on it, so there is no " +
        "in-app row and the admin catalog cannot list it. It reaches browser web push alone.",
    ).toEqual([]);
  });

  it("the admin catalog says what it lists", () => {
    // AC4. An operator reading a list assumes it is the list, and this one is
    // built from notification_type values, so a preference-key-only category is
    // absent from it with nothing on screen saying so.
    const page = readFileSync(
      resolve(import.meta.dirname, "..", "src/pages/admin/notifications.tsx"),
      "utf8",
    );
    expect(
      page,
      "src/pages/admin/notifications.tsx no longer tells the operator that it " +
        "lists enum-backed events only, so a preference-key-only category is " +
        "invisible there with nothing on screen admitting it",
    ).toMatch(/Enum-backed events only/);
  });

  it("every registry entry still matches something, so the lists can only shrink", () => {
    const gaps = categoryGaps({ emitted, ios, android });
    expect(
      Object.keys(KNOWN_CLIENT_GAPS.android).filter((c) => !gaps.android.includes(c)).sort(),
      "an Android gap entry no longer matches: the category is declared now, or is no longer " +
        "sent. Delete the entry.",
    ).toEqual([]);
    expect(
      Object.keys(KNOWN_CLIENT_GAPS.ios).filter((c) => !gaps.ios.includes(c)).sort(),
      "an iOS gap entry no longer matches; delete it",
    ).toEqual([]);
    const declared = new Set([...ios, ...android]);
    expect(
      Object.keys(CLIENT_ONLY).filter((c) => !declared.has(c) || emitted.includes(c)).sort(),
      "a CLIENT_ONLY entry no longer matches; delete it",
    ).toEqual([]);
    const only = new Set(webPushOnly({ keys, byType, catalog }));
    expect(
      Object.keys(WEB_PUSH_ONLY).filter((k) => !only.has(k)).sort(),
      "a WEB_PUSH_ONLY entry no longer matches; delete it",
    ).toEqual([]);
  });
});
