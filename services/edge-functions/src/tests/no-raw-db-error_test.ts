// US-1445: regression guard against leaking raw DB / provider error text to
// clients. Every edge route must return a SAFE, generic error body — raw
// Supabase/PostgREST `.message` strings can disclose schema, table/column names,
// SQL, internal hostnames, or PII. Use failSafe()/jsonError() from
// lib/http-errors.ts instead of `c.json({ error: dbErr.message }, status)`.
//
// This test scans every route file for the leak shape and fails the build if a
// new one appears. A deliberately-safe site (a typed validation message, a
// curated plan-gate/abuse message — NOT raw DB text) may opt out with a trailing
// `// safe-raw-error: <reason>` marker on the same line.
import { assertEquals } from "@std/assert";

const ROUTES_DIR = new URL("../routes/", import.meta.url);

// Matches a response body that returns an object whose `error` field is some
// value's `.message` (raw error text): `c.json({ error: <expr>.message` — where
// <expr> is an identifier / member chain / cast, e.g. error.message,
// dbErr.message, counterRes.error.message, (e as Error).message.
const LEAK = /c\.json\(\{\s*error:\s*[A-Za-z_$][\w$.()\s]*\.message\b/;
const OPT_OUT = "safe-raw-error";

Deno.test("no route returns a raw DB error.message in a c.json body (US-1445)", () => {
  const offenders: string[] = [];

  for (const entry of Deno.readDirSync(ROUTES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = Deno.readTextFileSync(new URL(entry.name, ROUTES_DIR));
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!LEAK.test(line)) continue;
      if (line.includes(OPT_OUT)) continue; // annotated safe (typed/curated msg)
      offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
    }
  }

  assertEquals(
    offenders,
    [],
    "Raw DB error.message returned to a client — use failSafe()/jsonError() " +
      "from lib/http-errors.ts, or annotate a genuinely-safe line with " +
      `\`// ${OPT_OUT}: <reason>\`.\n` +
      offenders.join("\n"),
  );
});
