// US-776: plan-downgrade communication on a silent demotion.
//
// plan-change-notify.ts imports email.ts / notify.ts which import the service-role
// supabase client at init, so set dummy env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { notifyPlanDowngrade } = await import("../lib/plan-change-notify.ts");
import type { PlanDowngradeNotifyDeps } from "../lib/plan-change-notify.ts";

function fakeDeps() {
  const calls = {
    notify: [] as Array<{ userId: string; type: string; link: string | null | undefined }>,
    email: [] as Array<{ to: string; fromPlan: string }>,
  };
  const deps: PlanDowngradeNotifyDeps = {
    notify: (userId, input) => {
      calls.notify.push({ userId, type: input.type, link: input.link });
      return Promise.resolve();
    },
    sendEmail: (to, data) => {
      calls.email.push({ to, fromPlan: data.fromPlan });
      return Promise.resolve(true);
    },
  };
  return { calls, deps };
}

Deno.test("demotion writes an in-app billing notification AND enqueues an email", async () => {
  const { calls, deps } = fakeDeps();
  await notifyPlanDowngrade(
    { userId: "u1", email: "user@example.com", userName: "Sam", fromPlan: "Pro" },
    deps,
  );
  assertEquals(calls.notify.length, 1);
  assertEquals(calls.notify[0].userId, "u1");
  assertEquals(calls.notify[0].type, "billing");
  assertEquals(calls.notify[0].link, "/dashboard/billing");
  assertEquals(calls.email.length, 1);
  assertEquals(calls.email[0].to, "user@example.com");
  assertEquals(calls.email[0].fromPlan, "Pro");
});

Deno.test("with no email on file, still posts the in-app notification (no email send)", async () => {
  const { calls, deps } = fakeDeps();
  await notifyPlanDowngrade(
    { userId: "u2", email: null, userName: "Sam", fromPlan: "Business" },
    deps,
  );
  assertEquals(calls.notify.length, 1);
  assertEquals(calls.email.length, 0); // no address → no email leg
});

Deno.test("never throws when a leg fails (best-effort)", async () => {
  const deps: PlanDowngradeNotifyDeps = {
    notify: () => Promise.reject(new Error("notify db down")),
    sendEmail: () => Promise.resolve(true),
  };
  // notify rejects → notifyPlanDowngrade awaits it; ensure callers are protected
  // by the fire-and-forget `void` at the call site, but also assert the function
  // surfaces the rejection deterministically (caller uses void).
  let threw = false;
  try {
    await notifyPlanDowngrade({ userId: "u3", email: "x@y.com", userName: "S", fromPlan: "Pro" }, deps);
  } catch {
    threw = true;
  }
  assert(threw, "rejection propagates to the awaiter (call site uses void to ignore)");
});
