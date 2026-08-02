// US-2348 [P0]: no admin page mutates a scope-guarded table through the browser
// client.
//
// The defect: 00003 grants any `is_admin()` caller full INSERT/UPDATE/DELETE on
// ai_prompt_versions via RLS, and the admin SPA used that grant directly —
// four writes in ai-models.tsx. So an admin whose `grading:review` scope had
// been deliberately revoked could still open /admin/ai-models and rewrite the
// prompt_text of the LIVE active grading prompt, biasing every grade the
// platform issues. The router scope guard, the MFA step-up on activate, the
// audit row and the whole shadow → eval → canary lifecycle were all routed
// around. That falsifies the premise stated in lib/admin-scope-map.ts: that
// revoking a scope closes the surface.
//
// This is an ENUMERATION, not a ban. Direct reads are fine and direct writes to
// tables the edge does NOT guard are fine, so a blanket rule would be wrong as
// often as it was right. Every remaining direct write is declared below with a
// reason. A new one fails until it is declared, and a closed one fails until its
// entry is deleted — so the list can only shrink, and every entry is something a
// reviewer chose.

import { describe, expect, it } from "vitest";
import { SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface DirectWrite {
  file: string;
  table: string;
  op: "insert" | "update" | "delete" | "upsert";
}

// Every direct-to-Postgres write left in an admin surface, and why it is still
// there. Sorted by file.
const DECLARED: Array<DirectWrite & { why: string }> = [
  {
    file: "src/pages/admin/ai-models.tsx",
    table: "admin_audit_log",
    op: "insert",
    why:
      "US-2349 owns this: the audit log is writable — and therefore forgeable — " +
      "by any admin through RLS, on three admin pages. Closing it means moving " +
      "every logAuditAction call to the edge and revoking the client grant, " +
      "which is that story's whole subject, not a side effect of this one.",
  },
];
// US-2376 closed four of the original six entries. submissions.tsx and
// user-detail.tsx now route every mutation through the edge, so their
// admin_audit_log inserts went with them — the audit row is written server-side
// by writeAuditLog, with the actor's role, IP and user-agent attached. Only
// ai-models.tsx still writes the audit log from the browser; that is US-2349.

// Tables the edge guards with a scope, a step-up, an audit row, or all three.
// A direct write to one of these from the browser is a bypass by construction.
const EDGE_GUARDED = new Set([
  "ai_prompt_versions",
  "admin_audit_log",
  "users",
  "submissions",
  "grading_eval_cases",
  "grade_reports",
  "human_reviews",
]);

const ADMIN_DIRS = ["src/pages/admin", "src/components/admin"];
const WRITE_OPS = ["insert", "update", "delete", "upsert"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// US-2383: memoized per worker. This is called from THREE separate tests and
// re-walked both admin trees each time. Cheap idle, but the flake this guards
// against is a parallel-load effect, not an idle-cost one — see the scanning
// tests' SCAN_TIMEOUT_MS.
let cachedWrites: DirectWrite[] | null = null;
function findDirectWrites(): DirectWrite[] {
  if (cachedWrites) return cachedWrites;
  return (cachedWrites = scanDirectWrites());
}

function scanDirectWrites(): DirectWrite[] {
  const found: DirectWrite[] = [];
  for (const dir of ADMIN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)) {
        // The chained op follows within a short window: `.from("x").update(...)`
        // possibly across a couple of formatted lines. Anything further away is
        // a different statement.
        const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
        for (const op of WRITE_OPS) {
          if (tail.includes(`.${op}(`)) {
            found.push({ file: file.replace(/\\/g, "/"), table: m[1]!, op });
            break;
          }
        }
      }
    }
  }
  return found;
}

const key = (w: DirectWrite) => `${w.file}::${w.table}::${w.op}`;

describe("US-2348: admin SPA writes to edge-guarded tables", () => {
  it("has no undeclared direct write", () => {
    const declared = new Set(DECLARED.map(key));
    const undeclared = findDirectWrites()
      .filter((w) => EDGE_GUARDED.has(w.table))
      .filter((w) => !declared.has(key(w)))
      .map(key)
      .sort();
    expect(
      undeclared,
      "A new direct-to-Postgres write on a table the edge guards. Route it " +
        "through the edge route that carries the scope check, the step-up and " +
        "the audit row. If there genuinely is no route, add it to DECLARED " +
        "with the reason.",
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("has no stale declaration", () => {
    // The other direction. Without it, a fixed write stays on a list saying it
    // is not fixed, and the list stops meaning anything.
    const found = new Set(findDirectWrites().map(key));
    const stale = DECLARED.map(key).filter((k) => !found.has(k)).sort();
    expect(stale, "these writes are gone — delete their entries").toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("ai_prompt_versions is not written from the browser at all", () => {
    // The story's own subject, pinned by name. The enumeration above would catch
    // a regression, but this says WHICH table was the point — and it is the one
    // where a direct write changes the number every customer is sold.
    const offenders = findDirectWrites()
      .filter((w) => w.table === "ai_prompt_versions")
      .map(key);
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("every prompt mutation in ai-models.tsx goes through the edge", () => {
    const src = readFileSync("src/pages/admin/ai-models.tsx", "utf8");
    // create, deactivate, delete, edit — the four that used to be raw writes.
    expect(src).toContain("/api/admin/grading/prompts");
    expect(src.match(/promptsApi\(/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe("US-2376: the plan grant and the mark-failed action", () => {
  it("user-detail.tsx changes the plan through the scoped edge route", () => {
    const src = readFileSync("src/pages/admin/user-detail.tsx", "utf8");
    expect(src).toContain("/plan`");
    expect(src).toContain("/api/admin/users/");
    // The step-up retry is the point of the route — without the dialog the
    // admin just gets a 403 they cannot clear.
    expect(src).toContain("setPlanStepUpOpen");
    expect(src).toContain("STEP_UP_REQUIRED");
  });

  it("submissions.tsx marks failed through the edge route", () => {
    const src = readFileSync("src/pages/admin/submissions.tsx", "utf8");
    expect(src).toContain("/mark-failed");
  });

  it("neither page writes the audit log from the browser any more", () => {
    for (const f of ["src/pages/admin/user-detail.tsx", "src/pages/admin/submissions.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toContain('from("admin_audit_log")');
    }
  });

  it("the submissions lifecycle columns are frozen against the owner", () => {
    // AC4. The SPA fix alone is cosmetic while a seller can PATCH their own
    // submission row: "Users can update own submissions" (00451) is USING-only,
    // with no WITH CHECK and no column list, so status='completed' was one
    // devtools request away.
    const mig = readFileSync(
      "supabase/migrations/00511_submissions_protected_columns_guard.sql",
      "utf8",
    );
    expect(mig).toContain("CREATE TRIGGER guard_submissions_protected_columns");
    for (const col of ["status", "payment_status", "refunded_at", "moderation_status", "grading_attempts"]) {
      expect(mig, col).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    // Service-role (the edge) must still own these columns, or the grading
    // pipeline itself would be blocked.
    expect(mig).toContain("auth.role() IS DISTINCT FROM 'authenticated'");
  });

  it("users.plan needs no new grant narrowing — there was never one", () => {
    // Recording the finding rather than writing a no-op migration: public.users
    // has no admin UPDATE policy at all (00006 is SELECT-only), and 00331's
    // trigger freezes `plan` against the owner. The browser write this story
    // removed did not bypass RLS — it silently matched zero rows and the page
    // reported success anyway.
    const adminRead = readFileSync("supabase/migrations/00006_admin_read_policies.sql", "utf8");
    expect(adminRead).toContain("Admins can view all users");
    expect(adminRead).not.toContain("ON public.users FOR UPDATE");
    const guard = readFileSync(
      "supabase/migrations/00331_fix_users_guard_bogus_moderation_cols.sql",
      "utf8",
    );
    expect(guard).toContain("NEW.plan IS DISTINCT FROM OLD.plan");
  });
});

describe("US-2348: the RLS grant that made it possible", () => {
  it("ai_prompt_versions write policies are revoked", () => {
    // The SPA fix alone is cosmetic: the grant is what let ANY is_admin() caller
    // write the table, and a browser devtools console is as good as the UI.
    const mig = readFileSync(
      "supabase/migrations/00510_prompt_versions_service_role_writes.sql",
      "utf8",
    );
    for (const op of ["create", "update", "delete"]) {
      expect(mig).toContain(`DROP POLICY IF EXISTS "Admins can ${op} AI prompt versions"`);
    }
    // Reads must survive — the admin UI still lists prompts directly.
    expect(mig).not.toContain('DROP POLICY IF EXISTS "Admins can view AI prompt versions"');
  });
});
