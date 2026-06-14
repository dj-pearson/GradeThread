// US-887: maintenance-window enforcement — pure decision + schedule logic.
//
// The guard (middleware/maintenance.ts) is a thin wrapper over decideMaintenance,
// so testing the pure function covers the enforcement matrix without booting
// Hono. AC#6 ("admins are never locked out of /admin by a window") is asserted
// two ways: an admin always passes, AND /api/admin is exempt for anyone.
import { assert, assertEquals } from "@std/assert";

// lib/maintenance.ts imports the service-role supabase client at init (it throws
// without env). Set dummy env BEFORE the dynamic import — mirrors
// schema-version_test.ts. The pure helpers under test never touch the client.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  decideMaintenance,
  isMaintenanceExemptPath,
  isWindowEffective,
  scopesForPath,
} = await import("../lib/maintenance.ts");

type MaintenanceMode = import("../lib/maintenance.ts").MaintenanceMode;
type MaintenanceScope = import("../lib/maintenance.ts").MaintenanceScope;
type MaintenanceWindow = import("../lib/maintenance.ts").MaintenanceWindow;

function win(
  scope: MaintenanceScope,
  mode: MaintenanceMode,
  over: Partial<MaintenanceWindow> = {},
): MaintenanceWindow {
  return {
    id: `${scope}-${mode}`,
    scope,
    mode,
    message: `${scope} is in ${mode} maintenance`,
    starts_at: null,
    ends_at: null,
    is_active: true,
    created_by: null,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    ...over,
  };
}

// ── decision: nothing active ─────────────────────────────────────

Deno.test("no effective windows → allow", () => {
  const d = decideMaintenance({
    path: "/api/grade/submit",
    method: "POST",
    isAdmin: false,
    windows: [],
  });
  assertEquals(d.action, "allow");
});

Deno.test("banner mode never blocks (even writes)", () => {
  const d = decideMaintenance({
    path: "/api/grade/submit",
    method: "POST",
    isAdmin: false,
    windows: [win("platform", "banner")],
  });
  assertEquals(d.action, "allow");
});

// ── blocked mode ─────────────────────────────────────────────────

Deno.test("blocked platform → 503 for a non-admin in-scope request", () => {
  const d = decideMaintenance({
    path: "/api/grade/status/abc",
    method: "GET",
    isAdmin: false,
    windows: [win("platform", "blocked")],
  });
  assertEquals(d.action, "block");
  assertEquals(d.status, 503);
  assertEquals(d.code, "MAINTENANCE");
  assert(d.message?.includes("platform"));
});

Deno.test("blocked grading does NOT affect a flipdesk request (scope isolation)", () => {
  const d = decideMaintenance({
    path: "/api/flipdesk/listings/123",
    method: "POST",
    isAdmin: false,
    windows: [win("grading", "blocked")],
  });
  assertEquals(d.action, "allow");
});

Deno.test("blocked checkout blocks /api/payments writes for non-admins", () => {
  const d = decideMaintenance({
    path: "/api/payments/checkout",
    method: "POST",
    isAdmin: false,
    windows: [win("checkout", "blocked")],
  });
  assertEquals(d.action, "block");
  assertEquals(d.scope, "checkout");
});

// ── read_only mode ───────────────────────────────────────────────

Deno.test("read_only blocks writes but allows reads", () => {
  const write = decideMaintenance({
    path: "/api/flipdesk/listings",
    method: "POST",
    isAdmin: false,
    windows: [win("flipdesk", "read_only")],
  });
  assertEquals(write.action, "block");
  assertEquals(write.code, "MAINTENANCE_READ_ONLY");

  const read = decideMaintenance({
    path: "/api/flipdesk/listings",
    method: "GET",
    isAdmin: false,
    windows: [win("flipdesk", "read_only")],
  });
  assertEquals(read.action, "allow");
});

// ── severity: blocked wins over read_only ────────────────────────

Deno.test("blocked outranks read_only when both apply", () => {
  const d = decideMaintenance({
    path: "/api/grade/status/x",
    method: "GET",
    isAdmin: false,
    windows: [win("grading", "read_only"), win("platform", "blocked")],
  });
  assertEquals(d.action, "block");
  assertEquals(d.code, "MAINTENANCE");
});

// ── AC#6: admins are never locked out ────────────────────────────

Deno.test("AC#6: an admin is NEVER blocked, even under a platform block", () => {
  for (const path of ["/api/grade/submit", "/api/flipdesk/listings", "/api/payments/checkout"]) {
    const d = decideMaintenance({
      path,
      method: "POST",
      isAdmin: true,
      windows: [win("platform", "blocked")],
    });
    assertEquals(d.action, "allow", `admin should pass ${path}`);
  }
});

Deno.test("AC#6: /api/admin is exempt for everyone (admins reach /admin)", () => {
  assert(isMaintenanceExemptPath("/api/admin/ops/maintenance"));
  assert(isMaintenanceExemptPath("/api/admin/users"));
  const d = decideMaintenance({
    path: "/api/admin/ops/maintenance",
    method: "POST",
    isAdmin: false,
    windows: [win("platform", "blocked")],
  });
  assertEquals(d.action, "allow");
});

Deno.test("webhooks, crons, oauth callbacks and the public status endpoint are exempt", () => {
  for (
    const p of [
      "/api/webhooks/stripe",
      "/api/flipdesk/webhooks/depop",
      "/api/jobs/reprice-scan",
      "/api/flipdesk/ebay/oauth/callback",
      "/api/maintenance/active",
    ]
  ) {
    assert(isMaintenanceExemptPath(p), `${p} must be exempt`);
  }
});

// ── scope mapping ────────────────────────────────────────────────

Deno.test("scopesForPath maps subsystems and always adds platform", () => {
  assertEquals([...scopesForPath("/api/grade/submit")].sort(), ["grading", "platform"]);
  assertEquals([...scopesForPath("/api/flipdesk/x")].sort(), ["flipdesk", "platform"]);
  assertEquals([...scopesForPath("/api/payments/x")].sort(), ["checkout", "platform"]);
  // A path with no subsystem scope is never enforced.
  assertEquals(scopesForPath("/api/notifications/x").size, 0);
});

// ── schedule effectiveness ───────────────────────────────────────

Deno.test("isWindowEffective honors the master switch and schedule bounds", () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");

  // Active, no bounds → effective.
  assert(isWindowEffective(win("platform", "blocked"), now));
  // is_active=false → never effective (this is the "end now" state).
  assert(!isWindowEffective(win("platform", "blocked", { is_active: false }), now));
  // Scheduled in the future → not yet effective.
  assert(
    !isWindowEffective(
      win("platform", "blocked", { starts_at: "2026-06-14T18:00:00.000Z" }),
      now,
    ),
  );
  // Already ended → not effective.
  assert(
    !isWindowEffective(
      win("platform", "blocked", { ends_at: "2026-06-14T06:00:00.000Z" }),
      now,
    ),
  );
  // Inside the window → effective.
  assert(
    isWindowEffective(
      win("platform", "blocked", {
        starts_at: "2026-06-14T06:00:00.000Z",
        ends_at: "2026-06-14T18:00:00.000Z",
      }),
      now,
    ),
  );
});
