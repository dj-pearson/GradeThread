// US-1560: RBAC coverage drift-guard.
//
// Every admin router must have exactly one entry in the router→scope registry
// (lib/admin-scope-map.ts), and the source of each router must MATCH its
// declared mode: guarded routers actually call requireScope; role-only routers
// deliberately don't (with a written rationale) and must have zero mutations.
// A new admin-*.ts file fails this test until it's classified — prose rules
// become a hard gate.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { ADMIN_ROUTER_SCOPES } = await import("../lib/admin-scope-map.ts");
const { DEFAULT_ROLE_SCOPES, isScopeKey, SCOPE_KEYS } = await import(
  "../lib/rbac-scopes.ts"
);

const ROUTES_DIR = new URL("../routes/", import.meta.url);

async function adminRouterFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(ROUTES_DIR)) {
    if (entry.isFile && /^admin-.*\.ts$/.test(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

const MUTATION_RE = /\.(post|put|patch|delete)\(/;

Deno.test("US-1560: every admin router is classified, and no stale entries remain", async () => {
  const files = await adminRouterFiles();
  const mapped = ADMIN_ROUTER_SCOPES.map((e) => e.file).sort();
  assertEquals(
    files,
    mapped,
    "src/routes/admin-*.ts and lib/admin-scope-map.ts must list the same files — " +
      "classify new routers (or remove stale entries) in admin-scope-map.ts",
  );
  // Exactly one entry per file.
  assertEquals(new Set(mapped).size, mapped.length, "duplicate registry entries");
});

Deno.test("US-1560: each router's source matches its declared guard mode", async () => {
  for (const entry of ADMIN_ROUTER_SCOPES) {
    const src = await Deno.readTextFile(new URL(entry.file, ROUTES_DIR));
    const hasGuard = src.includes("requireScope(");
    if (entry.mode === "role-only") {
      assert(
        !hasGuard,
        `${entry.file}: declared role-only but calls requireScope — reclassify it`,
      );
      assert(
        !MUTATION_RE.test(src),
        `${entry.file}: declared role-only but has mutations — role-only is for ` +
          "read-only aggregates; give its writes a scope",
      );
      assert(
        entry.rationale.trim().length >= 20,
        `${entry.file}: role-only requires a written rationale`,
      );
      assertEquals(entry.scope, null, `${entry.file}: role-only entries carry no scope`);
    } else {
      assert(
        hasGuard,
        `${entry.file}: declared ${entry.mode}-guarded but never calls requireScope`,
      );
      if (entry.mode === "router") {
        assert(
          isScopeKey(entry.scope),
          `${entry.file}: router mode requires a valid scope key`,
        );
        assert(
          src.includes(`requireScope("${entry.scope}")`),
          `${entry.file}: source doesn't guard with the registered scope ${entry.scope}`,
        );
        assert(
          /\.use\(\s*"\*"\s*,\s*requireScope\(/.test(src),
          `${entry.file}: router mode expects a use("*", requireScope(...)) guard`,
        );
      }
    }
  }
});

Deno.test("US-1560: admin default holds every scope except users:role (rollout parity)", () => {
  const adminScopes = new Set(DEFAULT_ROLE_SCOPES.admin);
  for (const scope of SCOPE_KEYS) {
    if (scope === "users:role") {
      assert(!adminScopes.has(scope), "users:role stays super_admin-only by default");
    } else {
      assert(
        adminScopes.has(scope),
        `admin default is missing ${scope} — enforcement would lock admins out at rollout; ` +
          "add it here AND to the role_scopes seed migration",
      );
    }
  }
});

Deno.test("US-1560: every scope referenced by the registry exists", () => {
  for (const entry of ADMIN_ROUTER_SCOPES) {
    if (entry.scope !== null) {
      assert(isScopeKey(entry.scope), `${entry.file}: unknown scope ${entry.scope}`);
    }
  }
});
