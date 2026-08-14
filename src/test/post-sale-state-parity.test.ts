import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isClosedCase } from "@/pages/flipdesk/post-sale-state";

// US-2560. The rule for "is this eBay post-sale case still open" now exists
// twice: in the SPA page that renders the rows, and in the edge poll that
// decides whether to notify. The edge is a separate Deno project and cannot
// import the SPA module, so this compares the two by source.
//
// WHY THE DUPLICATION IS WORTH GUARDING RATHER THAN ARGUING ABOUT. Either rule
// being wrong on its own is survivable — the SPA copy documents that asymmetry
// at length, and it holds for the poll too. The two DISAGREEING is not:
//
//   The poll decides whether the seller is told. The page decides whether the
//   row appears under "open" or behind "Show closed". Notify on a state the
//   page files as closed and the seller follows the notification to a page that
//   shows them nothing — which reads as a bug in the notification, and teaches
//   them to ignore the next one.
//
// So the guard is on the marker LIST, not on either behaviour.

const EDGE = "services/edge-functions/src/lib/post-sale-state.ts";
const SPA = "src/pages/flipdesk/post-sale-state.ts";

function markers(rel: string): string[] {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  const block = /TERMINAL_MARKERS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error(`no TERMINAL_MARKERS in ${rel}`);
  // Strip comments first: the SPA copy explains in prose why "REFUND" is not on
  // the list on its own, and that sentence quotes both "REFUND" and
  // "REFUND_OVERDUE". Reading the prose as data would invent two markers, one
  // of which is the exact value the comment exists to keep OUT.
  const body = block[1]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the two post-sale state rules agree (US-2560)", () => {
  it("has the same terminal markers on both sides, in the same order", () => {
    const spa = markers(SPA);
    expect(spa.length).toBeGreaterThan(5);
    expect(markers(EDGE)).toEqual(spa);
  });

  it("still excludes the bare word REFUND", () => {
    // REFUND_OVERDUE is an OPEN case and the most urgent kind there is: a refund
    // the seller owes and has not issued. Matching the bare word would bury the
    // row that needs action most — on the page AND, now, in the notification.
    for (const rel of [SPA, EDGE]) {
      expect(markers(rel), rel).not.toContain("REFUND");
      expect(markers(rel), rel).toContain("REFUNDED");
    }
  });

  it("reads a cancellation's states the way the poll needs", () => {
    // ONLY the two states this repo actually records — the ebay-postorder.ts
    // comment on CancellationSummary.state names CANCEL_REQUESTED and
    // CANCEL_CLOSED and nothing else. A first draft of this test also asserted
    // CANCEL_COMPLETE was terminal, which is a state I made up; it went red,
    // because "COMPLETED" does not match "COMPLETE".
    //
    // That near-miss is left documented rather than fixed, and the fix would be
    // wrong: shortening the marker to "COMPLETE" widens the TERMINAL set on a
    // guess, and a state like COMPLETE_REFUND_PENDING would then be read as
    // finished and hidden. Hiding work is the expensive direction. If eBay is
    // ever observed sending a COMPLETE-suffixed cancellation state, add that
    // exact string — do not generalise the marker.
    //
    // Note both documented states contain the word "CANCEL", which is why the
    // rule matches terminal MARKERS and not the case type.
    expect(isClosedCase({ state: "CANCEL_REQUESTED" })).toBe(false);
    expect(isClosedCase({ state: "CANCEL_PENDING" })).toBe(false);
    expect(isClosedCase({ state: "CANCEL_CLOSED" })).toBe(true);
  });

  it("defaults an unknown state to OPEN", () => {
    // The asymmetry both copies rest on: eBay's vocabulary is unpublished, so a
    // state nobody anticipated must surface, not vanish.
    expect(isClosedCase({ state: "SOME_STATE_EBAY_ADDED_LAST_TUESDAY" })).toBe(false);
    expect(isClosedCase({ state: null })).toBe(false);
  });
});

describe("the cancellation source is wired end to end", () => {
  it("the poll reads searchCancellations", () => {
    // The finding, stated as a test: the function existed and nothing called it.
    const poll = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/marketplace-event-poll.ts"),
      "utf8",
    );
    expect(poll).toContain("searchCancellations");
    expect(poll).toContain('"cancellation_requested"');
    // Claim before deliver, release on failure — the same contract as the other
    // three sources, not a shortcut because this one is new.
    expect(poll).toMatch(/release\?\.\(\s*ownerId,\s*"cancellation"/);
  });

  it("the enum value ships with its migration", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/00601_cancellation_requested_notification.sql"),
      "utf8",
    );
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'cancellation_requested'");
    expect(sql).toContain("insert into public.applied_migrations");

    const version = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/schema-version.ts"),
      "utf8",
    );
    const m = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(version);
    expect(m, "EXPECTED_SCHEMA_VERSION not found").toBeTruthy();
    // >= not ==, so a later story adding 00602 does not redden this. The
    // property is "the edge never expects a schema older than the migration this
    // story needs", and a guard every later story has to edit is a guard nobody
    // reads.
    expect(Number(m![1])).toBeGreaterThanOrEqual(601);
  });

  it("the settings copy covers what the returns gate now delivers", () => {
    // Routing a type under a category whose description does not describe it
    // makes a sentence the user already agreed to retroactively false.
    const prefs = readFileSync(
      resolve(process.cwd(), "src/lib/notification-preferences.ts"),
      "utf8",
    );
    const returnsCat = prefs.slice(prefs.indexOf('key: "returns"'));
    const description = returnsCat.slice(0, returnsCat.indexOf("channels:"));
    expect(description.toLowerCase()).toContain("cancel");
    expect(prefs).toContain('type: "cancellation_requested"');
  });
});
