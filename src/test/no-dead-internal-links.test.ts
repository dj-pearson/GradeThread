import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// Four links in shipped UI pointed at routes that have never existed. Nothing
// failed, because nothing connected a `to=` / `href=` to the router:
//
//   /legal/trademarks   eBay attribution footer  → the route is /trademarks
//   /referrals          partners page CTA        → it is /dashboard/referrals
//   /settings?tab=...   measurement form         → it is /dashboard/settings
//                                                  (and there is no `preferences` tab)
//   /snap               public finds page        → it is /dashboard/snap
//
// A dead internal link is invisible in review and invisible in CI: the page
// renders, the anchor is styled, and only a click finds out. This file walks
// every literal and template-literal internal link in src/ and asserts the
// router can serve it.
//
// SOURCE SCAN, so it can only fail if it actually finds links. The self-check
// at the bottom fails if the extractor comes back thin — a guard that extracts
// nothing passes forever and proves nothing.

const root = process.cwd();
const ROUTES_FILE = "src/routes/index.tsx";

const FILE_EXTENSION = /\.(xml|txt|json|ico|png|jpe?g|svg|webmanifest|pdf|css|js)$/i;

// Half of GradeThread's public surface is NOT in the SPA router: blog, certs,
// /durability, /authors, /rn and friends are edge-SSR'd by the Cloudflare Pages
// Functions in functions/. A link to one of those is perfectly live, so the
// guard has to know about both route tables or it reports false deaths. (It
// did, on the first run: /durability is a Pages Function, not a dead route.)
function readFunctionRoutePaths(): string[] {
  const paths: string[] = [];
  const walkFns = (dir: string) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith("_")) continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFns(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const route =
        "/" +
        rel
          .split(sep)
          .slice(1) // drop "functions"
          .join("/")
          .replace(/\.tsx?$/, "")
          .replace(/(^|\/)index$/, "");
      // [[path]] is a Pages catch-all: it serves the prefix and everything
      // under it. [name] is one dynamic segment.
      if (/\[\[[^\]]+\]\]$/.test(route)) {
        const prefix = route.replace(/\/?\[\[[^\]]+\]\]$/, "");
        paths.push(prefix === "" ? "/" : prefix, (prefix === "" ? "" : prefix) + "/*");
      } else {
        paths.push(route.replace(/\[([^\]]+)\]/g, ":$1"));
      }
    }
  };
  walkFns("functions");
  return paths;
}

function readRoutePaths(): string[] {
  const src = readFileSync(resolve(root, ROUTES_FILE), "utf8");
  const paths = new Set<string>();
  for (const m of src.matchAll(/path:\s*["']([^"']*)["']/g)) paths.add(m[1]!);
  return [...paths];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(rel, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

type FoundLink = { target: string; where: string };

// `to="/a/b"`, `href="/a/b"`, `to={"/a/b"}` and `to={`/a/${x}`}`. A `${...}`
// hole becomes a `:param` segment so it can match a dynamic route.
const LINK_RE = /(?:\bto|\bhref)=(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*`([^`]+)`\s*\})/g;

function collectLinks(): FoundLink[] {
  const found: FoundLink[] = [];
  for (const file of walk("src")) {
    const lines = readFileSync(resolve(root, file), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(LINK_RE)) {
        const raw = m[1] ?? m[2] ?? m[3] ?? m[4]!;
        if (!raw.startsWith("/") || raw.startsWith("//")) continue;
        const target = raw.split("?")[0]!.split("#")[0]!.replace(/\$\{[^}]*\}/g, ":param");
        if (target === "" || FILE_EXTENSION.test(target)) continue;
        found.push({ target, where: `${file.split(sep).join("/")}:${i + 1}` });
      }
    });
  }
  return found;
}

function routeMatcher(routePaths: string[]) {
  const exact = new Set(routePaths.filter((p) => !p.includes(":") && !p.endsWith("*")));
  const wildcards = routePaths.filter((p) => p.endsWith("/*")).map((p) => p.slice(0, -2));
  const dynamic = routePaths.filter((p) => p.includes(":")).map((p) => p.split("/"));

  return function matches(target: string): boolean {
    if (exact.has(target)) return true;
    for (const w of wildcards) if (target === w || target.startsWith(w + "/")) return true;
    const segs = target.split("/");
    for (const route of dynamic) {
      if (route.length !== segs.length) continue;
      let ok = true;
      for (let i = 0; i < route.length; i++) {
        const r = route[i]!;
        if (r.startsWith(":")) continue;
        if (r !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
}

describe("internal links resolve to a real route", () => {
  const routePaths = [...readRoutePaths(), ...readFunctionRoutePaths()];
  const links = collectLinks();
  const matches = routeMatcher(routePaths);

  it("extracts a real router and a real link set (self-check)", () => {
    // If either of these goes thin, the assertions below are vacuous.
    expect(routePaths.length).toBeGreaterThan(150);
    expect(links.length).toBeGreaterThan(200);
    expect(new Set(links.map((l) => l.target)).size).toBeGreaterThan(100);
    // The extractor must see all four link shapes it claims to handle.
    expect(matches("/pricing")).toBe(true);
    expect(matches("/dashboard/flipdesk/items/:param")).toBe(true);
    expect(matches("/admin/anything/at/all")).toBe(true);
    // Pages Functions half of the table.
    expect(matches("/durability/nike")).toBe(true);
    expect(matches("/rn/12345")).toBe(true);
    expect(matches("/blog/anything")).toBe(true);
    expect(matches("/nope/not/a/route")).toBe(false);
  });

  it("has no link to a route the router cannot serve", () => {
    const dead = links.filter((l) => !matches(l.target));
    const report = [...new Set(dead.map((l) => `${l.target}  <-  ${l.where}`))].sort();
    expect(report).toEqual([]);
  });
});
