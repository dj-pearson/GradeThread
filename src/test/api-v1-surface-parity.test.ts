// US-2635: three descriptions of the public API, held to each other.
//
// The API is described in three places, and a customer meets all three:
//
//   1. `routes/api-v1.ts` — what is actually mounted
//   2. `lib/openapi-spec.ts` — what `GET /api/v1/openapi.json` serves, which is
//      what Postman imports and what codegen turns into a client
//   3. `pages/marketing/developers.tsx` — the endpoint table on the public page
//
// The spec was missing three of the four sandbox endpoints while its own
// `info.description` advertised "a free, deterministic sandbox lives under
// /api/v1/sandbox/*" and it declared a Sandbox tag. So a generated client could
// SUBMIT a mock grade and had no method to fetch the result — which is the only
// thing a sandbox is for. The bare `GET /sandbox/price-guide` was in neither the
// spec nor the page, so nothing a customer reads mentioned it at all.
//
// That is the specific hazard of a HAND-WRITTEN spec: it does not fail, it
// silently describes less than exists, and the omission looks like the endpoint
// not being ready rather than the document being stale.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC = "services/edge-functions/src/lib/openapi-spec.ts";
const ROUTES = "services/edge-functions/src/routes/api-v1.ts";
const MAIN = "services/edge-functions/src/main.ts";
const PAGE = "src/pages/marketing/developers.tsx";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Paths that exist but are deliberately absent from a surface. Named, with the
 * reason, so an omission has to be argued rather than assumed.
 */
const NOT_ADVERTISED: Array<{ path: string; absentFrom: "spec" | "page"; why: string }> = [
  {
    path: "/api/v1/openapi.json",
    absentFrom: "spec",
    why: "A spec listing itself is noise, and this route takes no API key while every path in the document is documented as requiring one.",
  },
  {
    path: "/api/v1/openapi.json",
    absentFrom: "page",
    why: "The page links it in prose above the table with 'no key required'; a row in a table whose every other row carries a scope would misread as key-gated.",
  },
];

/** `{id}` in OpenAPI and `:id` in Hono are the same path. */
const norm = (p: string) => p.replace(/\{([^}]+)\}/g, ":$1").replace(/\/$/, "") || "/";

type Surface = Map<string, Set<string>>;
const put = (m: Surface, method: string, path: string) => {
  const p = norm(path);
  if (!m.has(p)) m.set(p, new Set());
  m.get(p)!.add(method.toLowerCase());
};

/** Slice from the `{` at `open` to its match. */
function braceBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

function mounted(): Surface {
  const out: Surface = new Map();
  const routes = read(ROUTES);
  const main = read(MAIN);
  const prefix = /app\.route\(\s*"([^"]*)",\s*apiV1Routes/.exec(main)?.[1] ?? "/api/v1";
  for (const m of routes.matchAll(/\bapiV1(?:Routes)?\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
    put(out, m[1]!, prefix + m[2]!);
  }
  for (const m of main.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/v1[^"]*)"/g)) {
    put(out, m[1]!, m[2]!);
  }
  return out;
}

function specSurface(): Surface {
  const out: Surface = new Map();
  const src = read(SPEC);
  const body = braceBody(src, src.indexOf("{", src.indexOf("\n  paths: {")));
  const rx = /"(\/api\/v1[^"]*)":\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body))) {
    const obj = braceBody(body, body.indexOf("{", m.index + m[0].length - 1));
    // Immediate keys only — a fixed-length window spills into the next path and
    // reports every entry as supporting every verb. That was the first bug here.
    for (const mm of obj.matchAll(/(get|post|put|patch|delete):\s*\{/g)) {
      const before = obj.slice(0, mm.index! + mm[0].length);
      const depth =
        (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
      if (depth === 2) put(out, mm[1]!, m[1]!);
    }
    rx.lastIndex = m.index + obj.length;
  }
  return out;
}

function pageSurface(): Surface {
  const out: Surface = new Map();
  for (const m of read(PAGE).matchAll(/method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"/g)) {
    put(out, m[1]!, m[2]!);
  }
  return out;
}

function missingFrom(have: Surface, want: Surface, surface: "spec" | "page"): string[] {
  const exempt = new Set(
    NOT_ADVERTISED.filter((e) => e.absentFrom === surface).map((e) => norm(e.path)),
  );
  const out: string[] = [];
  for (const [path, methods] of want) {
    if (exempt.has(path)) continue;
    for (const method of methods) {
      if (!have.get(path)?.has(method)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

describe("US-2635: the API's three descriptions agree", () => {
  it("the spec is not smaller than the router", () => {
    expect(
      missingFrom(specSurface(), mounted(), "spec"),
      "these are mounted and openapi.json does not describe them. A client " +
        "generated from the spec cannot call them, and the absence reads as the " +
        "endpoint not existing rather than the document being stale.",
    ).toEqual([]);
  });

  it("the spec does not describe routes that are not mounted", () => {
    expect(
      missingFrom(mounted(), specSurface(), "page"),
      "openapi.json describes these and nothing serves them. Worse than an " +
        "omission: a generated client calls them and gets a 404.",
    ).toEqual([]);
  });

  it("the developers page lists every mounted endpoint", () => {
    expect(missingFrom(pageSurface(), mounted(), "page")).toEqual([]);
  });

  it("the page does not advertise routes that are not mounted", () => {
    expect(missingFrom(mounted(), pageSurface(), "spec")).toEqual([]);
  });

  it("every deliberate omission still names a real route and a reason", () => {
    const live = mounted();
    for (const e of NOT_ADVERTISED) {
      expect(live.has(norm(e.path)), `${e.path} is exempted but no longer mounted`).toBe(true);
      expect(e.why.length, `${e.path} needs a reason`).toBeGreaterThan(40);
    }
  });

  it("guard-the-guard: the parsers actually found something", () => {
    // Every assertion above passes vacuously if a rename makes a parser return
    // an empty map. Three surfaces, three floors.
    expect(mounted().size, "no mounted routes parsed").toBeGreaterThan(8);
    expect(specSurface().size, "no spec paths parsed").toBeGreaterThan(8);
    expect(pageSurface().size, "no page rows parsed").toBeGreaterThan(8);
  });
});
