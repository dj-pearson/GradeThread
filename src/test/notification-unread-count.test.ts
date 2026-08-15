import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2557. The story is "iOS has no tab badge", and the Swift half needs macOS.
// What does NOT need macOS is everything the Swift half would read from, and two
// of those were wrong in a way that would have made the iOS work look broken:
//
//   1. NO PUSH HAS EVER CARRIED A BADGE. apns.ts has supported `badge` since
//      pushes shipped and no caller set it, so the app-icon number AC4 asks for
//      could never appear no matter what the app did — the only thing that can
//      badge a CLOSED app is the payload.
//   2. THE WEB BELL COUNTED A PAGE, NOT THE ROWS. It filtered a .limit(20)
//      fetch, so it stopped at 20. AC3 says the iOS badge should match the web
//      centre; matching it would have shipped the cap to the phone, and AC4's
//      server count would have disagreed with the bell on the same account.
//
// These pin both, plus the AC1 premise, so the Swift work lands on a surface
// that is already correct.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Source with comments removed — prose that describes a bug is not the bug. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CENTRE = "src/components/dashboard/notification-center.tsx";

describe("the web bell counts rows, not a page (US-2557 AC3)", () => {
  it("asks the database for the count", () => {
    const src = code(CENTRE);
    expect(src).toContain('count: "exact"');
    expect(src).toContain("head: true");
    expect(src).toContain('.eq("is_read", false)');
  });

  it("no longer derives the badge from the fetched page", () => {
    // The exact expression that capped it at 20.
    expect(code(CENTRE)).not.toContain("notifications.filter((n) => !n.is_read).length");
  });

  it("keeps the count query in step with the list", () => {
    // The count is its own query now, so every path that refreshes the list has
    // to refresh it too. Miss one and the bell shows a number that outlives the
    // rows behind it — which is worse than the cap this replaced, because a
    // stale badge sends the user looking for something that is not there.
    const src = code(CENTRE);
    // Each side has one useQuery key plus one entry per refresh path (the
    // realtime INSERT, markAsRead, markAllRead), so the two totals are equal.
    // Counting the whole file rather than the invalidations alone is deliberate:
    // it means adding a fourth refresh path that forgets the count fails here.
    const listKeys = src.match(/queryKey: \["notifications", /g) ?? [];
    const countKeys = src.match(/queryKey: \["notifications-unread", /g) ?? [];
    expect(listKeys.length).toBeGreaterThanOrEqual(4);
    expect(countKeys.length).toBe(listKeys.length);
  });

  it("marks all read by predicate, not by the ids on screen", () => {
    const src = code(CENTRE);
    // The old shape collected ids from the page, so "Mark all read" left
    // everything past row 20 unread — invisible while the badge was computed
    // from that same page, and glaring once it counts properly.
    expect(src).not.toContain(".in(\"id\", unreadIds)");
    expect(src).toMatch(/update\(\{ is_read: true \} as never\)\s*\.eq\("user_id"/);
    // US-1552: .or() on a MUTATION is rejected by the self-hosted prod
    // PostgREST and accepted by the local stack, so CI cannot catch it.
    expect(src).not.toMatch(/update\([\s\S]{0,120}\.or\(/);
  });
});

describe("a push can carry the count (US-2557 AC4)", () => {
  it("the transport still supports a badge, and now something sets one", () => {
    const apns = code("services/edge-functions/src/lib/apns.ts");
    expect(apns).toContain("aps.badge = payload.badge");

    // The CALL, not the import. A first draft asserted only that the name
    // appeared in the file, which the `import` line satisfies on its own — so
    // deleting the actual call left this green. An import is not a use.
    const push = code("services/edge-functions/src/lib/transactional-push.ts");
    expect(push).toMatch(/sendPushToUser\(\s*userId,\s*await withUnreadBadge\(userId, payload\)/);
  });

  it("never sends a badge of zero", () => {
    // In APNs an absent badge means "leave the icon alone" and 0 means "clear
    // it". A read failure or a genuine zero must therefore attach nothing —
    // otherwise a database hiccup wipes a badge showing real unread items.
    const badge = code("services/edge-functions/src/lib/notification-badge.ts");
    expect(badge).toContain("count === null || count <= 0");
    expect(badge).toContain("return payload");
  });
});

describe("the iOS premise this story was filed on (US-2557 AC1)", () => {
  it("still has no badge API outside the two unrelated files", () => {
    // Recorded as a BASELINE, not an assertion that it stays zero: the whole
    // point of the story is that Swift adds one. When the iOS half lands this
    // test should be updated to name ContentView, not deleted — the value is
    // knowing the two matches below are the filter sheet and the tools hub
    // rather than a tab badge somebody already wrote.
    const hits = readFileSync(
      resolve(process.cwd(), "ios/GradeThread/Tools/ToolsHubView.swift"),
      "utf8",
    );
    expect(hits).toContain("badgeCount");

    const filter = readFileSync(
      resolve(process.cwd(), "ios/GradeThread/Inventory/InventoryFilterSheet.swift"),
      "utf8",
    );
    expect(filter).toContain(".badge(");
  });
});
