// US-3144 — the "listings still live" push, across the four places it lives.
//
// The push category is a bare string that has to be identical in the edge, on
// iOS, on Android and in the notification-preferences catalog. Nothing links
// them: a Deno service, a Swift enum, a Kotlin enum and a TypeScript constant.
// Change one and the others keep compiling, keep passing their own tests, and
// the push is delivered and routed nowhere. There is no runtime error to find,
// because a category the client does not recognise is a tap that does nothing.
//
// So the strings are pinned here, together, in the one suite that can read all
// four trees.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_TYPES,
} from "@/lib/notification-preferences";

const root = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** The one string. Every assertion below is about keeping it one string. */
const CATEGORY = "delist.needed";

describe("US-3144: the push category is the same string everywhere", () => {
  it("the edge stamps it", () => {
    expect(read("services/edge-functions/src/lib/transactional-push.ts")).toContain(
      `category: "${CATEGORY}"`,
    );
  });

  it("iOS declares it and routes it", () => {
    const categories = read("ios/GradeThread/Notifications/NotificationCategories.swift");
    expect(categories).toContain(`case delistNeeded     = "${CATEGORY}"`);
    // Declaring it is not enough — an undeclared-but-received category defaults
    // to "show it" and then taps into nothing.
    const delegate = read("ios/GradeThread/Notifications/NotificationDelegate.swift");
    expect(delegate).toContain("NotificationCategoryID.delistNeeded.rawValue");
    expect(delegate).toContain("case pendingDelists(itemId: String?)");
  });

  it("Android declares it and routes it", () => {
    const push = read(
      "android/app/src/main/java/com/gradethread/app/platform/push/PushCategory.kt",
    );
    expect(push).toContain(`DELIST_NEEDED("${CATEGORY}")`);
    expect(push).toContain("PushCategory.DELIST_NEEDED -> DeepLinkRoute.PendingDelists");
    const route = read(
      "android/app/src/main/java/com/gradethread/app/platform/deeplink/DeepLinkRoute.kt",
    );
    expect(route).toContain("data class PendingDelists(val itemId: String?)");
  });

  it("both clients read the item from the same payload key", () => {
    // `inventory_item_id` is the key both platforms ALREADY parse for every
    // other item-scoped push. Sending the item under any other name would need
    // new parsing on two platforms to reach the same screen.
    expect(read("services/edge-functions/src/lib/transactional-push.ts")).toContain(
      "inventory_item_id: opts.itemId",
    );
    expect(read("ios/GradeThread/Notifications/NotificationDelegate.swift")).toContain(
      'userInfo["inventory_item_id"]',
    );
    expect(
      read("android/app/src/main/java/com/gradethread/app/platform/push/PushCategory.kt"),
    ).toContain('data["inventory_item_id"]');
  });
});

describe("US-3144: the preference category is complete and honest", () => {
  it("delist_reminders has a default, a toggle and an event", () => {
    // All three, or the toggle exists and gates nothing (or the reverse: the
    // notification is gated by a key no screen can turn off).
    expect(DEFAULT_NOTIFICATION_PREFERENCES.delist_reminders).toBeDefined();
    expect(NOTIFICATION_TYPES.some((t) => t.key === "delist_reminders")).toBe(true);
    const event = NOTIFICATION_EVENT_CATALOG.find((e) => e.type === "delist_needed");
    expect(event?.prefKey).toBe("delist_reminders");
  });

  it("the frontend gate matches the edge gate", () => {
    // The frontend catalog is what the admin event list and the settings screen
    // describe; PREF_KEY in notify.ts is what actually decides delivery. Two
    // answers here means the settings screen tells a seller something the
    // server does not do.
    const notify = read("services/edge-functions/src/lib/notify.ts");
    expect(notify).toContain('delist_needed: "delist_reminders"');
  });

  it("its copy promises a task, because that is what it delivers", () => {
    // The category description is the agreement. This one asks the seller to go
    // and end listings, so its sentence has to say so — routing it under a
    // category whose copy promises news would make that sentence false.
    const meta = NOTIFICATION_TYPES.find((t) => t.key === "delist_reminders");
    expect(meta?.description.toLowerCase()).toContain("ending");
    // Email is deliberate: it is the channel that still reaches a seller whose
    // desktop is shut, which is the exact case this category exists for.
    expect(meta?.channels).toContain("email");
    expect(meta?.channels).toContain("push");
  });

  it("the DB enum value ships with it", () => {
    // notifyUser INSERTS this value. Without the enum the insert fails 22P02
    // and the notice is silently lost.
    const migration = read("supabase/migrations/00765_delist_needed_notification.sql");
    expect(migration).toContain(
      "ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'delist_needed';",
    );
  });
});

describe("US-3144: the phone can reach the listing it is told about", () => {
  it("iOS offers the marketplace link, and only when there is one", () => {
    const view = read("ios/GradeThread/Marketplaces/MarketplacesView.swift");
    // The whole point of the story on the phone: before this, the row named a
    // listing and gave no way to open it.
    expect(view).toContain("Link(\"End it on \\(label)\", destination: url)");
    // Guarded. A draft row was never published and a URL-less row was listed by
    // hand, so a link on either sends the seller somewhere that may not exist.
    expect(view).toContain("if let urlString = row.listingUrl, let url = URL(string: urlString)");
  });

  it("Android offers the same link under the same guard", () => {
    const screen = read(
      "android/app/src/main/java/com/gradethread/app/marketplaces/MarketplacesScreen.kt",
    );
    expect(screen).toContain("row.listingUrl?.takeIf { it.isNotBlank() }?.let { url ->");
    expect(screen).toContain("actions.openExternal(url)");
  });

  it("both narrow to the item the push named, and both offer a way out", () => {
    // A seller who sells three things in an afternoon gets three of these. A
    // list that ignores which one the push was about makes the tap useless —
    // and a filter the seller cannot see is a list that looks wrong.
    const view = read("ios/GradeThread/Marketplaces/MarketplacesView.swift");
    expect(view).toContain("visiblePendingDelists");
    expect(view).toContain("Show all \\(pendingDelists.count) listings");

    const vm = read(
      "android/app/src/main/java/com/gradethread/app/marketplaces/MarketplacesViewModel.kt",
    );
    expect(vm).toContain("val visiblePendingDelists: List<PendingDelist>");
    expect(vm).toContain("fun clearPendingDelistFocus()");
    const strings = read("android/app/src/main/res/values/strings.xml");
    expect(strings).toContain("marketplaces_delist_show_all");
    // Translated in the same commit, like every other string in this screen.
    expect(read("android/app/src/main/res/values-es/strings.xml")).toContain(
      "marketplaces_delist_show_all",
    );
  });
});
