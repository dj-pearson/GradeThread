// US-3350 / US-3355: the parts of the privilege replay and the grant check that
// can be pinned without a Postgres.
//
// Both scripts were run against a real one when they were written (a local
// Postgres 16 with every migration applied): after GRANT ALL plus this replay,
// the anon/authenticated/service_role privilege map matched a never-granted
// build row for row, and a revokes-only replay left 16 rows wrong. What these
// cases hold still is the extraction that made the difference, so a later
// "simplification" back to `revoke[^;]*;` goes red here first.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  buildReplaySql,
  corpusStatements,
  privilegeStatements,
} from "./replay-migration-privileges.mjs";
import { parseOutput, parseServiceRoleRegistry } from "./check-service-role-grants.mjs";
import { readFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");

function run(script, args) {
  try {
    return { code: 0, out: execFileSync("node", [script, ...args], { cwd: ROOT, encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

describe("privilegeStatements", () => {
  it("reads a revoke wrapped in EXECUTE '...' as a clean statement", () => {
    // 00475 / 00531 / 00711 shape. The naive extraction returned this with a
    // trailing quote, psql refused it, and the table stayed open.
    const sql = `do $$ begin
      if exists (select 1 from pg_roles where rolname = 'anon') then
        EXECUTE 'REVOKE ALL ON public.selector_health_pings FROM anon, authenticated';
      end if;
    end $$;`;
    expect(privilegeStatements(sql).statements).toEqual([
      "REVOKE ALL ON public.selector_health_pings FROM anon, authenticated",
    ]);
  });

  it("keeps grants and revokes in source order", () => {
    const sql = `revoke all on public.t from anon, authenticated;
      grant select on public.t to authenticated;`;
    expect(privilegeStatements(sql).statements).toEqual([
      "revoke all on public.t from anon, authenticated",
      "grant select on public.t to authenticated",
    ]);
  });

  it("ignores commented-out statements, CRLF included", () => {
    const sql = "-- revoke all on public.t from anon;\r\n/* grant all on public.t to anon; */\r\n";
    expect(privilegeStatements(sql).statements).toEqual([]);
  });

  it("does not read data that merely starts with the word", () => {
    const sql = "insert into x values ('fila', 'Grant Hill', 'grant hill 96');";
    expect(privilegeStatements(sql).statements).toEqual([]);
  });

  it("reports a format() statement as not replayable instead of dropping it", () => {
    const sql = "do $$ begin execute format('REVOKE ALL ON public.%I FROM anon', t); end $$;";
    const r = privilegeStatements(sql);
    expect(r.statements).toEqual([]);
    expect(r.dynamic).toHaveLength(1);
  });
});

describe("the migration corpus", () => {
  const { statements } = corpusStatements();
  const texts = statements.map((s) => s.text.toLowerCase().replace(/\s+/g, " "));

  it("finds the EXECUTE-wrapped revokes a revokes-only regex missed", () => {
    for (const t of ["selector_health_pings", "extension_usage_pings", "ebay_api_call_daily", "ebay_rate_limit_snapshots"]) {
      expect(texts.some((s) => s.startsWith("revoke all on public." + t + " from anon"))).toBe(true);
    }
  });

  it("keeps the later re-grant that US-2403 depends on", () => {
    // Replaying only revokes would leave this function denied to anon, and a
    // denied call from anon crashes the Supabase Postgres image (US-2403).
    const i = texts.findIndex((s) => /^grant execute on function public\.pollable_ebay_owner_ids/.test(s));
    const j = texts.findIndex((s) => /^revoke .*function public\.pollable_ebay_owner_ids/.test(s));
    expect(i).toBeGreaterThan(-1);
    if (j > -1) expect(i).toBeGreaterThan(j);
  });

  it("reads a real corpus (floor)", () => {
    expect(statements.length).toBeGreaterThan(400);
    expect(texts.filter((s) => s.startsWith("revoke")).length).toBeGreaterThan(200);
  });

  it("wraps each statement so one dropped object cannot stop the replay", () => {
    const sql = buildReplaySql([{ file: "x", text: "revoke all on public.t from anon" }]);
    expect(sql).toContain("exception when others then raise notice 'REPLAY_FAIL 0");
    expect(sql.trim().endsWith("select 'REPLAY_DONE';")).toBe(true);
  });
});

describe("check-service-role-grants.mjs", () => {
  it("parses the same registry the posture test reads", () => {
    const src = readFileSync(resolve(ROOT, "services/edge-functions/src/tests/rls-guard_test.ts"), "utf8");
    const reg = parseServiceRoleRegistry(src);
    expect(reg.length).toBeGreaterThan(140);
    expect(reg).toContain("oauth_clients");
  });

  it("reads OPEN rows and the self-check out of psql's output", () => {
    const out = [
      "PRESENT 146",
      "OPEN oauth_clients authenticated SELECT",
      "NOTICE:  SELFCHECK_TABLE abuse_signals",
      "SELFCHECK abuse_signals anon SELECT",
      "DONE",
    ].join("\n");
    const r = parseOutput(out);
    expect(r.present).toBe(146);
    expect(r.open).toEqual(["oauth_clients authenticated SELECT"]);
    expect(r.selfTable).toBe("abuse_signals");
    expect(r.selfcheck).toEqual(["abuse_signals anon SELECT"]);
    expect(r.done).toBe(true);
  });

  it("exits 2 naming the DSN it could not reach", () => {
    const dsn = "postgresql://postgres@127.0.0.1:1/postgres";
    for (const script of ["scripts/check-service-role-grants.mjs", "scripts/replay-migration-privileges.mjs"]) {
      const { code, out } = run(script, ["--dsn", dsn]);
      expect(code).toBe(2);
      expect(out).toContain(dsn);
    }
  });
});
