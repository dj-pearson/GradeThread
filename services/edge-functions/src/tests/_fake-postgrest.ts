// An in-memory stand-in for PostgREST, reached through the REAL supabase-js
// client. It exists so a route's database behaviour can be driven end to end in
// a unit test: the code under test builds its queries exactly as in production,
// supabase-js turns them into HTTP, and this answers the HTTP.
//
// It models only what the pricing routes use: eq / neq / in / is / gt / gte /
// lt / lte filters (dotted paths reach into embeds), order, limit, embeds joined
// by `<singular>_id` (inventory_items -> inventory_item_id), `!inner` dropping
// rows whose embed is missing, insert / upsert(on_conflict) / update / delete,
// single() / maybeSingle(), ignore-duplicates upserts, and the two job-lock RPCs.
//
// Usage:
//   import "./_env.ts";
//   import { installFakePostgrest } from "./_fake-postgrest.ts";
//   const db = installFakePostgrest();   // before the first query runs
//   db.reset({ listings: [...], inventory_items: [...] });

import { resetSupabaseAdminForTests } from "../lib/supabase.ts";

export type Row = Record<string, unknown>;

export interface FakeCall {
  method: string;
  table: string;
  params: URLSearchParams;
  body: unknown;
}

export interface FakePostgrest {
  tables: Record<string, Row[]>;
  calls: FakeCall[];
  locks: Set<string>;
  reset(seed?: Record<string, Row[]>): void;
  /** Make the next `method` on `table` answer a 500. */
  failNext(table: string, method: "GET" | "POST" | "PATCH" | "DELETE"): void;
  /** Every call that wrote to `table`. */
  writes(table: string): FakeCall[];
  restore(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getPath(row: Row, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Row)[part];
  }
  return cur;
}

function cmp(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === "number" && Number.isFinite(nb)) return na - nb;
  const da = Date.parse(String(a));
  const db = Date.parse(b);
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function test(cell: unknown, expr: string): boolean {
  if (expr.startsWith("not.")) return !test(cell, expr.slice(4));
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const value = expr.slice(dot + 1);
  switch (op) {
    case "eq":
      return cell !== undefined && cell !== null && String(cell) === value;
    case "neq":
      return cell !== undefined && cell !== null && String(cell) !== value;
    case "is":
      return value === "null" ? cell == null : String(cell) === value;
    case "in": {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
      return cell != null && list.includes(String(cell));
    }
    case "gt":
      return cell != null && cmp(cell, value) > 0;
    case "gte":
      return cell != null && cmp(cell, value) >= 0;
    case "lt":
      return cell != null && cmp(cell, value) < 0;
    case "lte":
      return cell != null && cmp(cell, value) <= 0;
    default:
      throw new Error(`fake postgrest: unsupported operator ${op}`);
  }
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/** Top-level embeds named in a select string: `inventory_items!inner(...)`. */
function embedsOf(select: string | null): Array<{ name: string; inner: boolean }> {
  if (!select) return [];
  const out: Array<{ name: string; inner: boolean }> = [];
  let depth = 0;
  let token = "";
  for (const ch of select) {
    if (ch === "(") {
      if (depth === 0) {
        const t = token.trim();
        const m = /^(?:\w+:)?(\w+)(!inner)?/.exec(t);
        if (m) out.push({ name: m[1], inner: Boolean(m[2]) });
      }
      depth++;
      token = "";
    } else if (ch === ")") {
      depth--;
      token = "";
    } else if (ch === "," && depth === 0) {
      token = "";
    } else if (depth === 0) {
      token += ch;
    }
  }
  return out;
}

function singular(name: string): string {
  return name.endsWith("ies") ? name.slice(0, -3) + "y" : name.replace(/s$/, "");
}

export function installFakePostgrest(): FakePostgrest {
  const realFetch = globalThis.fetch;
  const failures: Array<{ table: string; method: string }> = [];

  const fake: FakePostgrest = {
    tables: {},
    calls: [],
    locks: new Set(),
    reset(seed = {}) {
      fake.tables = structuredClone(seed);
      fake.calls = [];
      fake.locks = new Set();
      failures.length = 0;
    },
    failNext(table, method) {
      failures.push({ table, method });
    },
    writes(table) {
      return fake.calls.filter((c) => c.table === table && c.method !== "GET");
    },
    restore() {
      globalThis.fetch = realFetch;
      resetSupabaseAdminForTests();
    },
  };

  function joined(table: string, row: Row, select: string | null): Row | null {
    const out: Row = { ...row };
    for (const e of embedsOf(select)) {
      if (out[e.name] !== undefined) {
        if (e.inner && out[e.name] == null) return null;
        continue;
      }
      const fk = `${singular(e.name)}_id`;
      const target = (fake.tables[e.name] ?? []).find((r) => r.id === row[fk]);
      if (!target && e.inner) return null;
      out[e.name] = target ? { ...target } : null;
    }
    void table;
    return out;
  }

  function matching(table: string, params: URLSearchParams): Row[] {
    const select = params.get("select");
    const rows = fake.tables[table] ?? [];
    const out: Row[] = [];
    for (const row of rows) {
      const j = joined(table, row, select);
      if (!j) continue;
      let ok = true;
      for (const [k, v] of params.entries()) {
        if (RESERVED.has(k)) continue;
        if (!test(getPath(j, k), v)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(j);
    }
    return out;
  }

  function stored(table: string, joinedRows: Row[]): Row[] {
    const ids = new Set(joinedRows.map((r) => r.id));
    return (fake.tables[table] ?? []).filter((r) => ids.has(r.id));
  }

  function shape(rows: Row[], headers: Headers, status = 200): Response {
    const accept = headers.get("accept") ?? "";
    if (accept.includes("vnd.pgrst.object")) {
      if (rows.length === 1) return json(rows[0], status);
      return json({
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      }, 406);
    }
    return json(rows, status);
  }

  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const headers = req.headers;
    const rawBody = method === "GET" || method === "HEAD" ? "" : await req.text();
    const body = rawBody ? JSON.parse(rawBody) : undefined;

    const rpc = /\/rest\/v1\/rpc\/(\w+)/.exec(url.pathname);
    if (rpc) {
      const args = (body ?? {}) as Row;
      fake.calls.push({ method, table: `rpc:${rpc[1]}`, params: url.searchParams, body });
      if (rpc[1] === "try_acquire_job_lock") {
        const job = String(args.p_job);
        if (fake.locks.has(job)) return json(false);
        fake.locks.add(job);
        return json(true);
      }
      if (rpc[1] === "release_job_lock") {
        fake.locks.delete(String(args.p_job));
        return json(null);
      }
      return json(null);
    }

    const m = /\/rest\/v1\/(\w+)/.exec(url.pathname);
    if (!m) {
      if (url.hostname === "localhost" || url.hostname === "fake.supabase") {
        return json({ message: "not modelled" }, 404);
      }
      return realFetch(input as Request, init);
    }
    const table = m[1];
    const params = url.searchParams;
    fake.calls.push({ method, table, params, body });

    const f = failures.findIndex((x) => x.table === table && x.method === method);
    if (f >= 0) {
      failures.splice(f, 1);
      return json({ message: "injected failure", code: "XX000", details: null, hint: null }, 500);
    }

    const prefer = headers.get("prefer") ?? "";
    const wantRows = prefer.includes("return=representation");
    const list = (fake.tables[table] ??= []);

    if (method === "GET" || method === "HEAD") {
      let rows = matching(table, params);
      const order = params.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        rows = rows.slice().sort((a, b) => {
          const r = cmp(getPath(a, col), String(getPath(b, col)));
          return dir === "desc" ? -r : r;
        });
      }
      const limit = params.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return shape(rows, headers);
    }

    if (method === "POST") {
      const input = (Array.isArray(body) ? body : [body]) as Row[];
      const conflict = params.get("on_conflict");
      const merge = prefer.includes("resolution=merge-duplicates");
      const ignore = prefer.includes("resolution=ignore-duplicates");
      const out: Row[] = [];
      for (const r of input) {
        const keys = conflict ? conflict.split(",") : ["id"];
        const hit = merge || ignore
          ? list.find((x) => keys.every((k) => x[k] === r[k]))
          : undefined;
        if (hit && ignore) continue; // ON CONFLICT DO NOTHING returns no row
        if (hit) {
          Object.assign(hit, r);
          out.push(hit);
        } else {
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          list.push(row);
          out.push(row);
        }
      }
      return wantRows ? shape(out, headers, 201) : new Response(null, { status: 201 });
    }

    if (method === "PATCH") {
      const hit = stored(table, matching(table, params));
      for (const r of hit) Object.assign(r, body as Row);
      return wantRows ? shape(hit, headers) : new Response(null, { status: 204 });
    }

    if (method === "DELETE") {
      const hit = stored(table, matching(table, params));
      fake.tables[table] = list.filter((r) => !hit.includes(r));
      return wantRows ? shape(hit, headers) : new Response(null, { status: 204 });
    }

    return json({ message: `fake postgrest: ${method} not modelled` }, 405);
  }) as typeof fetch;

  resetSupabaseAdminForTests();
  return fake;
}
