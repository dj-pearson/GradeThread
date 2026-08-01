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
  {
    file: "src/pages/admin/submissions.tsx",
    table: "admin_audit_log",
    op: "insert",
    why: "Same as above — US-2349.",
  },
  {
    file: "src/pages/admin/submissions.tsx",
    table: "submissions",
    op: "update",
    why:
      "Marks a stuck submission failed. There is no edge equivalent today " +
      "(admin-grading has /submissions/:id/regrade and nothing for this), so " +
      "closing it means designing a route, not repointing a call.",
  },
  {
    file: "src/pages/admin/user-detail.tsx",
    table: "admin_audit_log",
    op: "insert",
    why: "Same as above — US-2349.",
  },
  {
    file: "src/pages/admin/user-detail.tsx",
    table: "users",
    op: "update",
    why:
      "Writes users.plan directly — an admin granting entitlement with no " +
      "billing:write scope check and no step-up. The nearest edge route, " +
      "POST /admin/billing/users/:id/change-plan, drives flipdesk_plan through " +
      "Stripe and lets the webhook write the row; it does not touch users.plan " +
      "at all. This one needs a new route and is filed separately. It is the " +
      "most serious entry on this list.",
  },
];

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

function findDirectWrites(): DirectWrite[] {
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
  });

  it("has no stale declaration", () => {
    // The other direction. Without it, a fixed write stays on a list saying it
    // is not fixed, and the list stops meaning anything.
    const found = new Set(findDirectWrites().map(key));
    const stale = DECLARED.map(key).filter((k) => !found.has(k)).sort();
    expect(stale, "these writes are gone — delete their entries").toEqual([]);
  });

  it("ai_prompt_versions is not written from the browser at all", () => {
    // The story's own subject, pinned by name. The enumeration above would catch
    // a regression, but this says WHICH table was the point — and it is the one
    // where a direct write changes the number every customer is sold.
    const offenders = findDirectWrites()
      .filter((w) => w.table === "ai_prompt_versions")
      .map(key);
    expect(offenders).toEqual([]);
  });

  it("every prompt mutation in ai-models.tsx goes through the edge", () => {
    const src = readFileSync("src/pages/admin/ai-models.tsx", "utf8");
    // create, deactivate, delete, edit — the four that used to be raw writes.
    expect(src).toContain("/api/admin/grading/prompts");
    expect(src.match(/promptsApi\(/g)?.length).toBeGreaterThanOrEqual(5);
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
