// US-2667: the admin support inbox lifts an open crisis thread to the top.
//
// The ordering is a pure function precisely so this can be a real test rather
// than another source scan. What it protects: a crisis thread does NOT keep
// bumping its own last_message_at, because the person typically sends one
// message and stops. Under ordinary traffic it slides off the first screen
// within the hour, which is exactly when someone should be opening it.

// US-2379: first import, always - this file's graph reaches lib/supabase.ts
// through routes/admin-support.ts, and _env.ts has to be loaded before it.
import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import { isUrgentInboxRow, sortInboxRows } from "../routes/admin-support.ts";

interface Row {
  id: string;
  status: string;
  escalation_trigger: string | null;
}

const row = (
  id: string,
  status: string,
  escalation_trigger: string | null = null,
): Row => ({ id, status, escalation_trigger });

Deno.test("inbox: an open crisis thread sorts above newer routine threads", () => {
  // Query order is already recency-descending, so 'newest' is simply first.
  const rows = [
    row("newest", "open"),
    row("newer", "escalated", "model"),
    row("crisis", "escalated", "crisis"),
    row("older", "open"),
  ];
  assertEquals(sortInboxRows(rows).map((r) => r.id), [
    "crisis",
    "newest",
    "newer",
    "older",
  ]);
});

Deno.test("inbox: recency order is preserved among everything else", () => {
  const rows = [row("a", "open"), row("b", "escalated", "auto"), row("c", "resolved")];
  assertEquals(sortInboxRows(rows).map((r) => r.id), ["a", "b", "c"]);
});

Deno.test("inbox: two crisis threads keep their recency order between them", () => {
  const rows = [
    row("routine", "open"),
    row("crisis-new", "escalated", "crisis"),
    row("crisis-old", "awaiting_user", "crisis"),
  ];
  assertEquals(sortInboxRows(rows).map((r) => r.id), [
    "crisis-new",
    "crisis-old",
    "routine",
  ]);
});

Deno.test("inbox: a SETTLED crisis thread stops being pinned", () => {
  // The point of the pin is "open this first". A resolved thread pinned forever
  // trains an operator to scroll past the top of their own inbox, which is the
  // failure this feature exists to prevent.
  for (const settled of ["resolved", "closed"]) {
    assertEquals(
      isUrgentInboxRow({ escalation_trigger: "crisis", status: settled }),
      false,
      settled,
    );
  }
  assertEquals(
    isUrgentInboxRow({ escalation_trigger: "crisis", status: "escalated" }),
    true,
  );
  assertEquals(
    isUrgentInboxRow({ escalation_trigger: "crisis", status: "awaiting_user" }),
    true,
  );
});

Deno.test("inbox: only the crisis trigger is urgent", () => {
  for (const trigger of ["model", "auto", "user", null, undefined, "", "CRISIS"]) {
    assertEquals(
      isUrgentInboxRow({ escalation_trigger: trigger, status: "escalated" }),
      false,
      String(trigger),
    );
  }
});

Deno.test("inbox: an empty list is not a special case", () => {
  assertEquals(sortInboxRows([]), []);
});

Deno.test("inbox: sorting does not mutate the input array", () => {
  const rows = [row("a", "open"), row("crisis", "escalated", "crisis")];
  const sorted = sortInboxRows(rows);
  assertEquals(rows.map((r) => r.id), ["a", "crisis"]);
  assert(sorted !== rows);
});
