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

const { ADMIN_ROUTER_SCOPES, ADMIN_ROUTE_SCOPE_EXEMPTIONS } = await import(
  "../lib/admin-scope-map.ts"
);
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

// US-2354: one mutating route registration, with a window wide enough to hold
// middleware that sits on a following line.
//
// This exists because "mutations" mode used to be checked with
// src.includes("requireScope(") — a WHOLE-FILE substring, so a router with
// three guarded writes and one unguarded one passed. admin-bulk.ts was exactly
// that shape. A per-route parse is the only way the mode means what its name
// says.
const ROUTE_REG =
  /^\s*(\w+Routes)\.(post|put|patch|delete)\(\s*"([^"]*)"([\s\S]{0,300}?)(?:=>|\basync\b)/gm;

interface MutatingRoute {
  method: string;
  path: string;
  guarded: boolean;
}

function mutatingRoutes(src: string): MutatingRoute[] {
  const out: MutatingRoute[] = [];
  for (const m of src.matchAll(ROUTE_REG)) {
    out.push({
      method: m[2]!,
      path: m[3]!,
      guarded: (m[4] ?? "").includes("requireScope("),
    });
  }
  return out;
}

// True when every route registration in the file passes requireScope(scope) as
// an argument — the mount-safe equivalent of a whole-router use("*") guard.
function allRoutesGuarded(src: string, scope: string | null): boolean {
  if (!scope) return false;
  const regs = [...src.matchAll(/^\w+Routes\.(?:get|post|put|patch|delete)\((.*)$/gm)];
  if (regs.length === 0) return false;
  return regs.every((m) => m[1].includes(`requireScope("${scope}")`));
}

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
      if (entry.mode === "mutations") {
        // US-2354: EVERY mutating route, not just one somewhere in the file.
        const exempt = new Set(
          ADMIN_ROUTE_SCOPE_EXEMPTIONS
            .filter((e) => e.file === entry.file)
            .map((e) => `${e.method} ${e.path}`),
        );
        const unguarded = mutatingRoutes(src)
          .filter((r) => !r.guarded)
          .filter((r) => !exempt.has(`${r.method} ${r.path}`))
          .map((r) => `${r.method.toUpperCase()} ${r.path}`);
        assertEquals(
          unguarded,
          [],
          `${entry.file}: mutating route(s) with no requireScope. Give each one ` +
            "the scope that owns it, or — if it genuinely should carry none — " +
            "add it to ADMIN_ROUTE_SCOPE_EXEMPTIONS with the argument written out.",
        );
      }
      if (entry.mode === "router") {
        assert(
          isScopeKey(entry.scope),
          `${entry.file}: router mode requires a valid scope key`,
        );
        assert(
          src.includes(`requireScope("${entry.scope}")`),
          `${entry.file}: source doesn't guard with the registered scope ${entry.scope}`,
        );
        // "router" mode means EVERY route carries the scope, reads included —
        // not that it is attached one particular way. use("*") is the usual
        // shape, but US-2377: a sub-app wildcard leaks onto the parent router,
        // so a router mounted at a shared prefix must attach the scope per
        // route instead. Both satisfy the mode; a router with neither doesn't.
        const wildcard = /\.use\(\s*"\*"\s*,\s*requireScope\(/.test(src);
        const perRoute = allRoutesGuarded(src, entry.scope);
        assert(
          wildcard || perRoute,
          `${entry.file}: router mode means every route carries ${entry.scope} — ` +
            `attach it with use("*", requireScope(...)), or as a per-route argument ` +
            "on every registration (required when the router is mounted at a prefix " +
            "other routers live under — see router-mount-isolation_test.ts)",
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

// ── US-2354: the exemption list must stay honest ────────────────────
//
// An allowlist that can hold entries for routes that no longer exist, or that
// have since been guarded, decays into a place where things go to be forgotten.
// Both directions are checked so the list can only shrink on its own.

Deno.test("US-2354: every scope exemption points at a real, still-unguarded route", async () => {
  for (const ex of ADMIN_ROUTE_SCOPE_EXEMPTIONS) {
    const src = await Deno.readTextFile(new URL(ex.file, ROUTES_DIR));
    const routes = mutatingRoutes(src);
    const hit = routes.find((r) => r.method === ex.method && r.path === ex.path);
    assert(
      hit,
      `${ex.file}: exemption for ${ex.method.toUpperCase()} ${ex.path} matches no ` +
        "route registration — the route was renamed or removed; delete the entry",
    );
    assert(
      !hit.guarded,
      `${ex.file}: ${ex.method.toUpperCase()} ${ex.path} now carries requireScope — ` +
        "delete its exemption so the guard, not the allowlist, is what permits it",
    );
  }
});

Deno.test("US-2354: an exemption states its argument, and names a mutations router", () => {
  const byFile = new Map(ADMIN_ROUTER_SCOPES.map((e) => [e.file, e]));
  for (const ex of ADMIN_ROUTE_SCOPE_EXEMPTIONS) {
    // Long enough that "n/a" or "legacy" cannot be the whole justification —
    // the point of the list is that someone had to write down why.
    assert(
      ex.reason.trim().length >= 80,
      `${ex.file} ${ex.path}: an exemption needs a real written argument`,
    );
    const entry = byFile.get(ex.file);
    assert(entry, `${ex.file}: exemption names a router that is not in the registry`);
    assertEquals(
      entry.mode,
      "mutations",
      `${ex.file}: only "mutations" routers have per-route exemptions — a ` +
        `"router"-mode file guards every route by definition, and "role-only" ` +
        "has no mutations at all",
    );
  }
});

Deno.test("US-2354: the per-route parser actually sees the routes it is checking", () => {
  // Without this the whole guard passes vacuously if the registration shape
  // changes and the regex silently matches nothing — the same failure mode as a
  // whole-file substring, one level down.
  const sample = [
    'adminBulkRoutes.post("/credits", requireScope("billing:write"), async (c) => {',
    'adminBulkRoutes.post("/resolve", async (c) => {',
    'adminBulkRoutes.patch(',
    '  "/wrapped",',
    '  requireScope("ops:write"),',
    "  async (c) => {",
  ].join("\n");
  const routes = mutatingRoutes(sample);
  assertEquals(routes.map((r) => `${r.method} ${r.path}`), [
    "post /credits",
    "post /resolve",
    "patch /wrapped",
  ]);
  assertEquals(routes.map((r) => r.guarded), [true, false, true]);
});
