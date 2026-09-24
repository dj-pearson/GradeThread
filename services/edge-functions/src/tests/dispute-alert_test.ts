// SUB-05: the admin alert moves from a fire-and-forget client call into the
// filing routes, and is keyed on the workspace OWNER the dispute is stored
// under. These cases drive lib/dispute-alert.ts through the real supabase-js
// client against the in-memory PostgREST.
//
// Run: deno test --allow-net --allow-env --allow-read src/tests/dispute-alert_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest } from "./_fake-postgrest.ts";
import {
  disputeAlertCopy,
  notifyAdminsDisputeFiled,
  removeOrphanedEvidence,
} from "../lib/dispute-alert.ts";

const OWNER = "aaaaaaaa-0000-0000-0000-000000000001";
const MEMBER = "aaaaaaaa-0000-0000-0000-000000000002";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000001";
const ADMIN = "cccccccc-0000-0000-0000-000000000001";

function seed() {
  return {
    users: [
      { id: OWNER, full_name: "Owner Ann", email: "a@example.com", role: "user" },
      { id: MEMBER, full_name: "Member Max", email: "m@example.com", role: "user" },
      { id: ADMIN, full_name: "Admin", email: "admin@example.com", role: "admin" },
    ],
    submissions: [{ id: "sub-1", user_id: OWNER, title: "Blue Jacket" }],
    grade_reports: [{ id: "gr-1", submission_id: "sub-1" }],
    // A member files as the owner (grade.ts), so the row carries OWNER.
    disputes: [
      {
        id: "d-1",
        grade_report_id: "gr-1",
        user_id: OWNER,
        kind: "grade",
        status: "open",
        reason: "Pilling is lint",
        admin_alerted_at: null,
      },
      {
        id: "d-2",
        grade_report_id: "gr-1",
        user_id: OWNER,
        kind: "authenticity",
        status: "open",
        reason: "Genuine, receipt on hand",
        admin_alerted_at: null,
      },
    ],
    notifications: [],
  };
}

const db = installFakePostgrest();

Deno.test("a member-filed dispute alerts once, looked up under the owner", async () => {
  db.reset(seed());
  // The route passes ownerId (workspaceOwnerId ?? userId), not the member id.
  const first = await notifyAdminsDisputeFiled("d-1", OWNER, "grade", { adminEmail: "" });
  assertEquals(first.status, "sent");
  // A legacy client still calling /dispute-filed after the route: no second alert.
  const second = await notifyAdminsDisputeFiled("d-1", OWNER, undefined, { adminEmail: "" });
  assertEquals(second, { status: "skipped", reason: "already alerted" });
  const notes = db.tables.notifications ?? [];
  assertEquals(notes.length, 1);
  assertEquals(notes[0].user_id, ADMIN);
  assertEquals(notes[0].title, "New grade dispute filed");
  assert(String(notes[0].message).includes("Blue Jacket"));
});

Deno.test("looking up by the MEMBER's own id finds nothing (the old 404)", async () => {
  db.reset(seed());
  const res = await notifyAdminsDisputeFiled("d-1", MEMBER, undefined, { adminEmail: "" });
  assertEquals(res.status, "not_found");
  assertEquals((db.tables.notifications ?? []).length, 0);
});

Deno.test("a foreign owner cannot alert on someone else's dispute", async () => {
  db.reset(seed());
  const res = await notifyAdminsDisputeFiled("d-1", OTHER, undefined, { adminEmail: "" });
  assertEquals(res.status, "not_found");
  assertEquals(db.tables.disputes.find((d) => d.id === "d-1")?.admin_alerted_at, null);
});

Deno.test("an authenticity appeal gets its own wording, email included", async () => {
  db.reset(seed());
  const sent: Array<{ kind?: string }> = [];
  const res = await notifyAdminsDisputeFiled("d-2", OWNER, "authenticity", {
    adminEmail: "ops@example.com",
    sendEmail: (_to, data) => {
      sent.push(data);
      return Promise.resolve(true);
    },
  });
  assertEquals(res.status, "sent");
  assertEquals(sent[0]?.kind, "authenticity");
  assertEquals(db.tables.notifications[0].title, "New authenticity appeal");
  assertEquals(disputeAlertCopy("grade", "A", "T").title, "New grade dispute filed");
});

Deno.test("a failed dispute insert removes the uploaded evidence paths", async () => {
  const removed: string[][] = [];
  const ok = await removeOrphanedEvidence(["o/s/dispute_1_0.jpg", "o/s/dispute_1_1.jpg"], (p) => {
    removed.push(p);
    return Promise.resolve({ error: null });
  });
  assert(ok);
  assertEquals(removed, [["o/s/dispute_1_0.jpg", "o/s/dispute_1_1.jpg"]]);
  // Nothing uploaded: nothing to call.
  assert(await removeOrphanedEvidence([], () => Promise.reject(new Error("must not run"))));
  // A storage failure is reported, not thrown.
  assertEquals(
    await removeOrphanedEvidence(["x"], () => Promise.resolve({ error: new Error("boom") })),
    false,
  );
});

Deno.test("grade.ts cleans up on insert failure and alerts from both routes", async () => {
  const src = await Deno.readTextFile(new URL("../routes/grade.ts", import.meta.url));
  const dispute = src.slice(src.indexOf('gradeRoutes.post("/dispute"'));
  const failBranch = dispute.slice(dispute.indexOf("if (dErr || !dispute)"));
  assert(
    failBranch.indexOf("removeOrphanedEvidence(evidencePaths)") <
      failBranch.indexOf('return c.json({ error: "Couldn\'t file the dispute" }, 500)'),
    "evidence cleanup must run before the failure returns",
  );
  assert(dispute.includes('notifyAdminsDisputeFiled((dispute as { id: string }).id, ownerId, "grade")'));
  const appeal = src.slice(src.indexOf('gradeRoutes.post("/authenticity-appeal"'));
  assert(appeal.includes('"authenticity",'));
  assert(appeal.includes("notifyAdminsDisputeFiled("));
});

Deno.test({
  name: "cleanup",
  fn: () => db.restore(),
});
