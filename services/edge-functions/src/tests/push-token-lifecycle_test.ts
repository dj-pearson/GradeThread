// US-795: push device-token lifecycle — environment validation, unregister, prune.
//
// notifications.ts / push-token-prune.ts import the service-role supabase client
// at init; set dummy env BEFORE the dynamic imports.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { parsePushEnvironment, notificationRoutes } = await import("../routes/notifications.ts");
const { prunePushTokens } = await import("../lib/push-token-prune.ts");
import type { PushTokenPruneStore } from "../lib/push-token-prune.ts";

// ── environment validation ───────────────────────────────────────

Deno.test("parsePushEnvironment: the two valid values pass through", () => {
  assertEquals(parsePushEnvironment("development"), "development");
  assertEquals(parsePushEnvironment("production"), "production");
});

Deno.test("parsePushEnvironment: absent defaults to development (back-compat)", () => {
  assertEquals(parsePushEnvironment(undefined), "development");
  assertEquals(parsePushEnvironment(null), "development");
});

Deno.test("parsePushEnvironment: an unrecognized value is 'invalid' (→ 400)", () => {
  assertEquals(parsePushEnvironment("prod"), "invalid");
  assertEquals(parsePushEnvironment("staging"), "invalid");
  assertEquals(parsePushEnvironment(42), "invalid");
});

// POST /register rejects an explicit invalid environment with 400 (before any DB
// work). The auth middleware isn't mounted on the bare router, so userId is
// unset and the handler 401s first UNLESS we... actually we can assert the
// validation via the pure function above; here we assert the DELETE route exists.
Deno.test("the router exposes BOTH POST and DELETE /register", () => {
  // Hono registers routes on the app; assert the DELETE handler is wired by
  // checking the router's registered methods for /register.
  const methods = new Set(
    // deno-lint-ignore no-explicit-any
    (notificationRoutes as any).routes
      .filter((r: { path: string }) => r.path === "/register")
      .map((r: { method: string }) => r.method.toUpperCase()),
  );
  assert(methods.has("POST"), "POST /register must exist");
  assert(methods.has("DELETE"), "DELETE /register (unregister) must exist");
});

// ── prune orchestration ──────────────────────────────────────────

Deno.test("prune deletes long-inactive rows and reports the count", async () => {
  let beforeArg: string | null = null;
  const store: PushTokenPruneStore = {
    deleteInactiveBefore: (beforeIso) => {
      beforeArg = beforeIso;
      return Promise.resolve(7);
    },
  };
  const r = await prunePushTokens(store);
  assertEquals(r.pruned, 7);
  assert(beforeArg, "a cutoff timestamp must be passed");
  // The cutoff is in the past (older-than threshold).
  assert(new Date(beforeArg!).getTime() < Date.now());
});

Deno.test("prune with nothing to delete returns zero", async () => {
  const store: PushTokenPruneStore = { deleteInactiveBefore: () => Promise.resolve(0) };
  assertEquals((await prunePushTokens(store)).pruned, 0);
});
