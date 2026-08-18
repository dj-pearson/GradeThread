import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// US-2557: the iOS unread badge, scanned from a lane that RUNS here.
//
// Swift cannot be compiled on a Windows checkout and iOS CI on macOS is the
// gate for anything that has to build. That leaves a real gap for decisions
// which are correct or incorrect in the SOURCE rather than at runtime — and
// every one below is that kind. Same arrangement as the ungated-print port
// beside this file: scan the Swift from vitest so the rule is checked on every
// push instead of only when a macOS runner is free.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments stripped, so a header describing a call that is not made cannot pass. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*(\/\/|\/\/\/).*$/gm, "");
}

const STORE = "ios/GradeThread/Notifications/UnreadBadgeStore.swift";
const SHELL = "ios/GradeThread/ContentView.swift";

describe("US-2557: the unread badge reads the edge, not the table", () => {
  const store = code(read(STORE));

  it("calls the counted route rather than querying notifications directly", () => {
    // The count must be a head+exact query, and getting that wrong is not a
    // compile error - it is a number that silently stops rising at the page
    // size, which is the bug the web bell shipped with. One counter, on the
    // server, shared with the push payload.
    expect(store).toContain("/api/notifications/unread-count");
    expect(
      /from\(\s*"notifications"\s*\)/.test(store),
      "the store queries the notifications table directly; use the counted route",
    ).toBe(false);
  });

  it("does NOT touch the app icon when the refresh fails", () => {
    // The route answers 503 rather than 0 precisely so this can hold the
    // distinction. Writing 0 on a failed read clears a badge showing five
    // unread because the network hiccupped.
    const catchBlock = store.match(/\}\s*catch\s*\{[\s\S]*?\n {8}\}/);
    expect(catchBlock, "no catch block found in refresh()").toBeTruthy();
    expect(
      /setIconBadge/.test(catchBlock![0]),
      "the failure path writes the icon badge; a failed read must leave it alone",
    ).toBe(false);
  });

  it("clears on reset, because the server only ever raises the badge", () => {
    // A push cannot know a notification was read on another device, so the
    // server never lowers the number. Bringing it down is the app's job.
    const reset = store.match(/public func reset\(\) async \{[\s\S]*?\n {4}\}/);
    expect(reset, "reset() not found").toBeTruthy();
    expect(reset![0]).toContain("unreadCount = 0");
    expect(reset![0]).toContain("setIconBadge(0)");
  });

  it("keeps the last count on failure rather than zeroing it", () => {
    const refresh = store.match(/public func refresh\(\) async \{[\s\S]*?\n {4}\}/);
    expect(refresh, "refresh() not found").toBeTruthy();
    expect(
      /unreadCount = 0/.test(refresh![0]),
      "refresh() zeroes the count somewhere; a network blip is not 'no unread mail'",
    ).toBe(false);
  });
});

describe("US-2557: the shell renders and refreshes it", () => {
  const shell = code(read(SHELL));

  it("badges the Home tab, with the count threaded from the shell that refreshes it", () => {
    // Checked as a CHAIN rather than one string. The first version asserted
    // ".badge(unreadBadge.unreadCount)" and was green over code that did not
    // compile: the store lives in MainShell and the TabView in TabBarShell, a
    // different struct, so the property was not in scope. A single-string check
    // could not see that; three links can.
    expect(shell, "the store is not declared").toContain("unreadBadge = UnreadBadgeStore()");
    expect(shell, "the count is not passed to the tab shell").toContain(
      "unreadCount: unreadBadge.unreadCount",
    );
    expect(shell, "the tab is not badged").toContain(".badge(unreadCount)");
  });

  it("refreshes on first render AND on foreground", () => {
    // Foreground is the one that matters: a push may have raised the badge
    // while the app was away, and rows may have been read on another device.
    const hits = shell.match(/unreadBadge\.refresh\(\)/g) ?? [];
    expect(hits.length, "expected a refresh at launch and on foreground").toBeGreaterThanOrEqual(2);
  });

  it("the scan is reading real files, not passing vacuously", () => {
    expect(read(STORE).length).toBeGreaterThan(500);
    expect(read(SHELL).length).toBeGreaterThan(5000);
  });
});
