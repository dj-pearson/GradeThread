// US-905 (AC5): re-assert that admin_audit_log is APPEND-ONLY.
//
// The forensic value of the audit trail depends on rows being immutable. RLS on
// admin_audit_log must expose ONLY SELECT + INSERT policies to non-service-role
// callers — never UPDATE or DELETE — so an admin (or a compromised admin
// session) cannot rewrite or erase history. This guard parses the migrations
// and fails if any UPDATE/DELETE policy is ever added to the table.
import { assert } from "@std/assert";

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

async function loadSql(): Promise<string> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const parts: string[] = [];
  for (const name of names) {
    parts.push(await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)));
  }
  return parts.join("\n");
}

Deno.test("admin_audit_log has no UPDATE/DELETE RLS policy (append-only)", async () => {
  const sql = await loadSql();
  const polRe = /CREATE POLICY\s+"([^"]+)"\s+ON\s+public\.admin_audit_log([\s\S]*?);/gi;

  const offenders: string[] = [];
  for (const m of sql.matchAll(polRe)) {
    const name = m[1]!;
    const body = m[2]!.toLowerCase();
    // The policy's command is "FOR <cmd>"; default (no FOR) is ALL, which would
    // also grant update/delete — treat that as an offender too.
    const forMatch = body.match(/\bfor\s+(select|insert|update|delete|all)\b/);
    const cmd = forMatch ? forMatch[1] : "all";
    if (cmd === "update" || cmd === "delete" || cmd === "all") {
      offenders.push(`${name} (FOR ${cmd.toUpperCase()})`);
    }
  }

  assert(
    offenders.length === 0,
    "admin_audit_log must stay append-only — found mutating policy(ies): " +
      offenders.join(", "),
  );
});

Deno.test("admin_audit_log RLS is enabled", async () => {
  const sql = await loadSql();
  assert(
    /ALTER TABLE\s+public\.admin_audit_log\s+ENABLE ROW LEVEL SECURITY/i.test(sql),
    "admin_audit_log must have RLS enabled",
  );
});
