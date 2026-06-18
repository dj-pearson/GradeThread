// US-1056: grading-lifecycle failure-path notifications.
//
// grading-lifecycle-notify.ts imports notify.ts / transactional-push.ts which
// pull in the service-role supabase client at init, so set dummy env BEFORE the
// dynamic import (per the LEARNINGS playbook).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { notifyGradingFailed, notifyGradingIncomplete, notifyReviewNeeded } =
  await import("../lib/grading-lifecycle-notify.ts");
import type { GradingLifecycleNotifyDeps } from "../lib/grading-lifecycle-notify.ts";

function fakeDeps() {
  const calls = {
    notify: [] as Array<{
      userId: string;
      type: string;
      title: string;
      message: string;
      link: string | null | undefined;
    }>,
    push: [] as Array<{ userId: string; title: string | null | undefined }>,
  };
  const deps: GradingLifecycleNotifyDeps = {
    notify: (userId, input) => {
      calls.notify.push({
        userId,
        type: input.type,
        title: input.title,
        message: input.message,
        link: input.link,
      });
      return Promise.resolve();
    },
    pushReview: (userId, title) => {
      calls.push.push({ userId, title });
      return Promise.resolve();
    },
  };
  return { calls, deps };
}

Deno.test("grading_failed fires an in-app failure notification", async () => {
  const { calls, deps } = fakeDeps();
  await notifyGradingFailed("u1", "Blue denim jacket", deps);
  assertEquals(calls.notify.length, 1);
  assertEquals(calls.notify[0].userId, "u1");
  assertEquals(calls.notify[0].type, "grading_failed");
  assert(calls.notify[0].message.includes("Blue denim jacket"));
  assert(calls.notify[0].message.toLowerCase().includes("charge was reversed"));
  assertEquals(calls.notify[0].link, "/dashboard/submissions");
  // The failure path is in-app only — no human-review push.
  assertEquals(calls.push.length, 0);
});

Deno.test("grading_failed falls back to a generic label when title is null", async () => {
  const { calls, deps } = fakeDeps();
  await notifyGradingFailed("u1", null, deps);
  assertEquals(calls.notify[0].type, "grading_failed");
  assert(calls.notify[0].message.startsWith("Your submission"));
});

Deno.test("grading_incomplete carries the quality-gate summary + deep link", async () => {
  const { calls, deps } = fakeDeps();
  await notifyGradingIncomplete(
    "u2",
    "Wool coat",
    "the label photo is too blurry to read",
    "/dashboard/submissions/abc",
    deps,
  );
  assertEquals(calls.notify.length, 1);
  assertEquals(calls.notify[0].type, "grading_incomplete");
  assert(calls.notify[0].message.includes("Wool coat"));
  assert(calls.notify[0].message.includes("too blurry"));
  assertEquals(calls.notify[0].link, "/dashboard/submissions/abc");
});

Deno.test("grading_incomplete works without a summary", async () => {
  const { calls, deps } = fakeDeps();
  await notifyGradingIncomplete("u2", "Wool coat", null, null, deps);
  assertEquals(calls.notify[0].type, "grading_incomplete");
  assert(calls.notify[0].message.toLowerCase().includes("clearer photos"));
  assertEquals(calls.notify[0].link, "/dashboard/submissions");
});

Deno.test("review_needed fires BOTH the in-app notice and the iOS push", async () => {
  const { calls, deps } = fakeDeps();
  await notifyReviewNeeded("u3", "Leather bag", "/dashboard/submissions/xyz", deps);
  assertEquals(calls.notify.length, 1);
  assertEquals(calls.notify[0].type, "grade_complete");
  assertEquals(calls.notify[0].link, "/dashboard/submissions/xyz");
  assertEquals(calls.push.length, 1);
  assertEquals(calls.push[0].userId, "u3");
  assertEquals(calls.push[0].title, "Leather bag");
});
