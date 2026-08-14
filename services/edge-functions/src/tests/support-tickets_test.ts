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

// ── US-2525: attachments ────────────────────────────────────────────────────
//
// Support is where someone goes when a photo came out wrong, and the thread
// took text only. These pin the pure halves of the upload path: what counts as
// an image, what a filename may become, and where a file is allowed to land.

const {
  decodeImageDataUrl,
  safeAttachmentName,
  attachmentPath,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ATTACHMENT_URL_TTL_SEC,
} = await import("../routes/support-tickets.ts");

Deno.test("US-2525: a data URL that is not an image decodes to null", () => {
  assertEquals(decodeImageDataUrl("data:text/html;base64,PHNjcmlwdD4="), null);
  assertEquals(decodeImageDataUrl("https://example.com/x.png"), null);
  assertEquals(decodeImageDataUrl(""), null);
  assertEquals(decodeImageDataUrl(undefined), null);
  // Well-formed but not decodable base64.
  assertEquals(decodeImageDataUrl("data:image/png;base64,!!!!"), null);
});

Deno.test("US-2525: a real image data URL decodes to its bytes", () => {
  // "PNG" as base64 — the magic-byte check is the server's job (US-276); this
  // only proves the decoder returns what it was given.
  const bytes = decodeImageDataUrl("data:image/png;base64,UE5H");
  assert(bytes !== null);
  assertEquals(Array.from(bytes!), [0x50, 0x4e, 0x47]);
});

Deno.test("US-2525: a filename cannot steer the storage path", () => {
  // The name is shown back to the user, so it stays readable — but it must not
  // be able to climb out of the folder it is written into.
  assertEquals(safeAttachmentName("../../etc/passwd"), "etc_passwd");
  assert(!safeAttachmentName("../../etc/passwd").includes(".."));
  assertEquals(safeAttachmentName("shot 1.png"), "shot_1.png");
  assertEquals(safeAttachmentName(".hidden"), "hidden");
  assertEquals(safeAttachmentName(""), "attachment");
  assertEquals(safeAttachmentName(null), "attachment");
  assert(!safeAttachmentName("a/b/c.png").includes("/"));
});

Deno.test("US-2525: the storage path starts with the owner's own folder", () => {
  // The bucket policy is (storage.foldername(name))[1] = auth.uid()::text, so a
  // path shaped any other way is unreadable by the person who uploaded it.
  const path = attachmentPath("user-1", "ticket-9", "png", 1_700_000_000_000, 0);
  assertEquals(path, "user-1/support/ticket-9/1700000000000_0.png");
  assert(path.startsWith("user-1/"));
});

Deno.test("US-2525: the caps stay inside their US-276 limits", () => {
  assertEquals(MAX_ATTACHMENTS_PER_MESSAGE, 3);
  // The private bucket's signed URLs are capped at 900s.
  assert(ATTACHMENT_URL_TTL_SEC <= 900);
});
