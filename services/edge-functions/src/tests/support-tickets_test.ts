// US-900: unit tests for the user-facing ticket message projection.
//
// The TICKET OWNER must NEVER see an operator's internal notes, and must never
// learn the identity of the admin who replied. toUserMessageView() is the pure
// guard that enforces both before any message reaches the user-facing endpoint;
// these tests pin that behavior without a live DB. (The full cross-tenant
// boundary — user B can't read user A's ticket at all — is covered E2E in
// tenant-isolation_test.ts, and at rest by the RLS policies in 00223.)

import { assert, assertEquals } from "@std/assert";

// The route module pulls in the service-role supabase client at import time,
// which throws if these aren't set. Seed harmless locals BEFORE the dynamic
// import; the pure helper under test never touches the network.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

const { toUserMessageView } = await import("../routes/support-tickets.ts");
type TicketMessageRow = import("../routes/support-tickets.ts").TicketMessageRow;

const OWNER = "owner-user-id";
const ADMIN = "admin-user-id";

const ROWS: TicketMessageRow[] = [
  {
    id: "m1",
    author_user_id: OWNER,
    body: "My zipper photo wasn't graded.",
    is_internal_note: false,
    created_at: "2026-06-14T10:00:00Z",
  },
  {
    id: "m2",
    author_user_id: ADMIN,
    body: "Thanks — looking into it now.",
    is_internal_note: false,
    created_at: "2026-06-14T10:05:00Z",
  },
  {
    id: "m3",
    author_user_id: ADMIN,
    body: "PRIVATE: refund already issued, low priority.",
    is_internal_note: true,
    created_at: "2026-06-14T10:06:00Z",
  },
];

Deno.test("user view drops internal notes entirely", () => {
  const view = toUserMessageView(ROWS, OWNER);
  assertEquals(view.length, 2);
  assert(
    view.every((m) => m.id !== "m3"),
    "internal note m3 must not be in the user-visible view",
  );
  // The private body must not leak through any message.
  assert(
    view.every((m) => !m.body.includes("PRIVATE")),
    "internal note body leaked into the user view",
  );
});

Deno.test("user view labels authorship as you/support only (no admin identity)", () => {
  const view = toUserMessageView(ROWS, OWNER);
  assertEquals(view[0]?.author, "you"); // owner's own message
  assertEquals(view[1]?.author, "support"); // admin reply, de-identified
  // No raw author ids are exposed in the projected shape.
  for (const m of view) {
    assert(!("author_user_id" in m), "raw author id leaked into user view");
  }
});

Deno.test("empty transcript projects to an empty array", () => {
  assertEquals(toUserMessageView([], OWNER), []);
});

Deno.test("an all-internal-note thread is fully hidden from the user", () => {
  const internalOnly: TicketMessageRow[] = [
    {
      id: "n1",
      author_user_id: ADMIN,
      body: "internal triage",
      is_internal_note: true,
      created_at: "2026-06-14T10:00:00Z",
    },
  ];
  assertEquals(toUserMessageView(internalOnly, OWNER), []);
});
