import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  ALL_SURFACES,
  CONTEXTUAL_ROUTES,
  NAV_GROUPS,
  SURFACES,
  routePathOf,
  type Surface,
} from "@/lib/surfaces";

// US-2876. The registry is only worth having if something fails when reality
// walks away from it. Three things can:
//
//   1. a route lands in the router with no nav entry and no exemption (AC3);
//   2. a surface claims an iOS route that no Swift view resolves (AC4);
//   3. the generated Swift mirrors go stale against the TypeScript.
//
// The router is read through the COMPILER'S OWN PARSER rather than by regex,
// because paths nest: `/dashboard/flipdesk` and its children are separate
// `path:` strings and only the tree says what the full URL is. A regex over
// `path: "..."` would have reported forty-five routes that mostly do not
// exist.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Swift and TS comments both, so a scan never fires on its own prose. */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

// ── the router, as a resolved list of URLs ────────────────────────────────

type RouterRoute = { path: string; element: string };

function routerRoutes(): RouterRoute[] {
  const src = ts.createSourceFile(
    "index.tsx",
    read("src/routes/index.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: RouterRoute[] = [];

  const prop = (obj: ts.ObjectLiteralExpression, name: string) => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    }
    return null;
  };
  const join = (parent: string, seg: string) =>
    seg.startsWith("/") ? seg : parent === "" ? `/${seg}` : `${parent.replace(/\/$/, "")}/${seg}`;

  const walk = (node: ts.Expression, parent: string) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const pathNode = prop(node, "path");
    const seg = pathNode && ts.isStringLiteral(pathNode) ? pathNode.text : null;
    const here = seg === null ? parent : join(parent, seg);
    const el = prop(node, "element");
    if (seg !== null && el) {
      out.push({ path: here || "/", element: el.getText().replace(/\s+/g, " ") });
    }
    const kids = prop(node, "children");
    if (kids && ts.isArrayLiteralExpression(kids)) {
      for (const k of kids.elements) walk(k, here);
    }
  };

  const find = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "createBrowserRouter" &&
      node.arguments[0] &&
      ts.isArrayLiteralExpression(node.arguments[0])
    ) {
      for (const el of node.arguments[0].elements) walk(el, "");
      return true;
    }
    return ts.forEachChild(node, find) ?? false;
  };
  find(src);
  return out;
}

const ROUTES = routerRoutes();

/**
 * Dashboard routes that render a real page.
 *
 * Anything rendering `<Navigate>` or a `*Redirect` component is excluded: a
 * redirect is a kept-alive old URL, not a surface, and listing thirty-one of
 * them as exemptions would bury the four that matter. Matching the SUFFIX
 * rather than three names on purpose -- the first pass at this named
 * Navigate/TabRedirect/InventoryModeRedirect and missed ViewRedirect and
 * ContentRedirect, which reported five redirects as undeclared surfaces.
 * Param'd routes (`:id`) are excluded for the same reason -- a detail page is
 * reached from the list that owns it.
 */
const REAL_DASHBOARD_ROUTES = ROUTES.filter(
  (r) =>
    r.path.startsWith("/dashboard") &&
    !/^<(Navigate\b|\w*Redirect\b)/.test(r.element) &&
    !r.path.includes(":"),
).map((r) => r.path);

describe("the router does not grow surfaces nobody declared (US-2876 AC3)", () => {
  it("found the router at all", () => {
    // If the AST walk silently returned nothing, every other assertion in this
    // file would pass vacuously. That is the failure mode of a guard like this.
    expect(ROUTES.length).toBeGreaterThan(100);
    expect(REAL_DASHBOARD_ROUTES.length).toBeGreaterThan(30);
  });

  it("every /dashboard route is a declared surface or a named exemption", () => {
    const declared = new Set(
      ALL_SURFACES.map(routePathOf).filter((p): p is string => p !== null),
    );
    const exempt = new Set(CONTEXTUAL_ROUTES.map((r) => r.path));
    const orphans = REAL_DASHBOARD_ROUTES.filter((p) => !declared.has(p) && !exempt.has(p));
    expect(
      orphans,
      "these routes render a page nobody can find:\n" +
        orphans.map((p) => `  ${p}`).join("\n") +
        "\nAdd each to SURFACES (with a nav placement, or nav: null if it is a " +
        "tab) or to CONTEXTUAL_ROUTES with a reason.",
    ).toEqual([]);
  });

  it("no exemption outlives the route it exempts", () => {
    // The list can only shrink by accident otherwise: a route gets deleted, its
    // exemption stays, and the next reader believes a URL exists that does not.
    const real = new Set(REAL_DASHBOARD_ROUTES);
    const stale = CONTEXTUAL_ROUTES.filter((r) => !real.has(r.path)).map((r) => r.path);
    expect(stale, `CONTEXTUAL_ROUTES names routes the router no longer has`).toEqual([]);
  });

  it("every exemption says why", () => {
    for (const r of CONTEXTUAL_ROUTES) {
      expect(r.why.length, `${r.path} has no reason`).toBeGreaterThan(25);
      expect(r.why.trim().endsWith("."), `${r.path}'s reason is not a sentence`).toBe(true);
    }
  });

  it("every declared web route actually resolves", () => {
    const real = new Set(REAL_DASHBOARD_ROUTES);
    const broken = ALL_SURFACES.filter((s) => {
      const p = routePathOf(s);
      return p !== null && p.startsWith("/dashboard") && !real.has(p);
    }).map((s) => `${s.id} -> ${s.web}`);
    expect(broken, "surfaces pointing at a route the router does not have").toEqual([]);
  });
});

describe("a surface cannot claim an iOS screen that is not there (US-2876 AC4)", () => {
  const hub = stripComments(read("ios/GradeThread/Tools/ToolsHubView.swift"));
  const modules = stripComments(read("ios/GradeThread/Tools/ToolModulePresentation.swift"));

  /** Case names declared by `ToolRoute` and `ToolModule`. */
  function swiftCases(source: string, enumName: string): string[] {
    const at = source.indexOf(`enum ${enumName}`);
    if (at === -1) return [];
    const open = source.indexOf("{", at);
    const body = source.slice(open, source.indexOf("\n}", open));
    return [...body.matchAll(/^\s*case (\w+)/gm)].map((m) => m[1]!);
  }

  const declared = new Set([
    ...swiftCases(hub, "ToolRoute"),
    ...swiftCases(modules, "ToolModule"),
  ]);

  it("found the Swift enums at all", () => {
    expect(declared.size).toBeGreaterThan(12);
    expect(declared.has("autoLister")).toBe(true);
    expect(declared.has("prospect")).toBe(true);
  });

  it("every ios route names a real case", () => {
    const bad = ALL_SURFACES.filter((s) => s.ios !== null && !declared.has(s.ios)).map(
      (s) => `${s.id} -> .${s.ios}`,
    );
    expect(
      bad,
      "these surfaces claim an iOS route no ToolRoute/ToolModule case declares",
    ).toEqual([]);
  });

  it("every case a switch actually resolves to a view", () => {
    // A case declared and never handled is a compile error in Swift, but a case
    // handled with an EmptyView is not, and that is what a half-finished
    // surface looks like from here.
    for (const s of ALL_SURFACES) {
      if (s.ios === null) continue;
      const at = hub.indexOf(`case .${s.ios}:`) >= 0 ? hub : modules;
      const idx = at.indexOf(`case .${s.ios}:`);
      expect(idx, `.${s.ios} is declared but no switch resolves it`).toBeGreaterThan(-1);
      const body = at.slice(idx, idx + 200);
      expect(/EmptyView\(\)/.test(body), `.${s.ios} resolves to EmptyView`).toBe(false);
    }
  });

  it("every iOS module in the hub is a declared surface", () => {
    // The other direction. A row added to ToolsHubView without a registry entry
    // is exactly the drift this story exists to stop.
    const rows = [...hub.matchAll(/title:\s*"([^"]+)",\s*\n\s*subtitle:/g)].map((m) => m[1]!);
    expect(rows.length).toBeGreaterThan(12);
    const labels = new Set(ALL_SURFACES.filter((s) => s.ios !== null).map((s) => s.label));
    // Four rows are worded for the phone: the hub says "Certified grades"
    // where the web nav says "Submissions", "What's it worth?" for "Snap to
    // Value", "Consignors" for "Consignment" and "Verified seller" for
    // "Verified". Same surface either way; the id is what binds them, so the
    // registry carries the web label and this maps the exceptions.
    //
    // NOT a licence to reword freely. Every entry here is a place the two
    // clients say different words for one thing, and each one is a small tax
    // on a seller who uses both.
    const PHONE_WORDING: Record<string, string> = {
      "Certified grades": "Submissions",
      "What's it worth?": "Snap to Value",
      Consignors: "Consignment",
      "Verified seller": "Verified",
    };
    const undeclared = rows
      .map((r) => PHONE_WORDING[r] ?? r)
      .filter((r) => !labels.has(r));
    expect(undeclared, "Tools hub rows with no entry in SURFACES").toEqual([]);
  });
});

describe("the generated Swift mirrors are current (US-2876 AC2)", () => {
  const MIRRORS: { swift: string; count: () => number }[] = [
    {
      swift: "ios/GradeThread/Tools/ProductSurfaces.swift",
      count: () => ALL_SURFACES.filter((s) => s.ios !== null).length,
    },
  ];

  for (const m of MIRRORS) {
    it(`${m.swift} holds every row and no more`, () => {
      const src = read(m.swift);
      const b = src.indexOf("// BEGIN GENERATED TABLE");
      const e = src.indexOf("// END GENERATED TABLE");
      expect(b, "no BEGIN fence").toBeGreaterThan(-1);
      expect(e, "no END fence").toBeGreaterThan(b);
      const table = src.slice(b, e);
      // COUNTED, not `toContain`. A mirror with half its rows deleted still
      // contains the rows that are left.
      expect((table.match(/^\s{8}ProductSurface\(/gm) ?? []).length).toBe(m.count());
    });
  }

  it("every iOS surface's label and sentence survived the trip", () => {
    const table = read("ios/GradeThread/Tools/ProductSurfaces.swift");
    for (const s of ALL_SURFACES) {
      if (s.ios === null) continue;
      expect(table, `${s.id}: label missing from the Swift mirror`).toContain(
        `label: "${s.label}"`,
      );
      expect(table, `${s.id}: sentence missing from the Swift mirror`).toContain(
        `summary: "${s.description}"`,
      );
    }
  });

  it("the mirror is not hand-edited", () => {
    // The generator is the contract. `--check` runs in verify and in CI; this
    // says so where somebody editing the Swift will read it.
    const src = read("ios/GradeThread/Tools/ProductSurfaces.swift");
    expect(src).toContain("scripts/generate-swift-mirrors.mjs");
    expect(src).toContain("Do not hand-edit");
  });
});

describe("the registry is internally coherent", () => {
  it("ids are unique", () => {
    const ids = ALL_SURFACES.map((s) => s.id);
    expect(new Set(ids).size, "duplicate surface id").toBe(ids.length);
  });

  it("a nav-placed surface always has a web route", () => {
    const bad = ALL_SURFACES.filter((s) => s.nav !== null && s.web === null).map((s) => s.id);
    expect(bad, "these are in the sidebar with nowhere to go").toEqual([]);
  });

  it("every nav placement names a group the sidebar renders", () => {
    const groups = new Map(NAV_GROUPS.map((g) => [g.group, g]));
    for (const s of ALL_SURFACES) {
      if (s.nav === null) continue;
      const g = groups.get(s.nav.group);
      expect(g, `${s.id} is in group ${String(s.nav.group)}, which NAV_GROUPS does not have`).toBeDefined();
      if (s.nav.subgroup) {
        const titles = (g!.subgroups ?? []).map((x) => x.title);
        expect(titles, `${s.id} names subgroup "${s.nav.subgroup}"`).toContain(s.nav.subgroup);
      }
    }
  });

  it("no subgroup renders empty", () => {
    for (const g of NAV_GROUPS) {
      for (const sub of g.subgroups ?? []) {
        const n = ALL_SURFACES.filter(
          (s) => s.nav !== null && s.nav.group === g.group && s.nav.subgroup === sub.title,
        ).length;
        expect(n, `subgroup "${sub.title}" has no surfaces`).toBeGreaterThan(0);
      }
    }
  });

  it("every surface exists on at least one client", () => {
    const nowhere = ALL_SURFACES.filter((s) => s.web === null && s.ios === null).map((s) => s.id);
    expect(nowhere, "declared and shipped nowhere").toEqual([]);
  });

  it("descriptions are sentences a person could read", () => {
    for (const s of ALL_SURFACES) {
      expect(s.description.length, `${s.id}'s description is too short to say anything`)
        .toBeGreaterThan(30);
      expect(s.description.trim().endsWith("."), `${s.id}'s description is not a sentence`)
        .toBe(true);
      expect(/^[A-Z]/.test(s.description), `${s.id}'s description does not start a sentence`)
        .toBe(true);
    }
  });

  it("the client gaps this story found are still visible, not silently closed", () => {
    // Not a wish list. These are REAL gaps, recorded so that closing one is a
    // deliberate act with a note, and so that a reader who wonders "did anyone
    // notice?" has an answer.
    //
    // Measured on 2026-08-25 as ["listing-templates", "prospect"]. US-2877
    // closed the first the same day -- it built the web page -- and this line
    // moving is what that looked like from here. `prospect` (photograph an item
    // in a shop, get comps before you buy) has no web equivalent and arguably
    // should not: it is a thing you do standing up, holding a phone.
    const iosOnly = ALL_SURFACES.filter((s) => s.ios !== null && s.web === null).map((s) => s.id);
    expect(iosOnly.sort()).toEqual(["prospect"]);
  });
});

describe("the sidebar renders the registry rather than its own list", () => {
  const side = stripComments(read("src/components/dashboard/sidebar.tsx"));

  it("there is no second hand-written nav list", () => {
    // The whole point. `navGroups` is now a `.map` over NAV_GROUPS; a literal
    // array of nav objects reappearing here is the drift starting again.
    expect(side).toContain("NAV_GROUPS");
    expect(side).toContain("ALL_SURFACES");
    expect(
      /const navGroups: NavGroup\[\] = \[/.test(side),
      "navGroups is a literal array again",
    ).toBe(false);
  });

  it("every surface has an icon, checked by the compiler not by eye", () => {
    expect(side).toContain("Record<SurfaceId, typeof LayoutDashboard>");
    // COUNTED. A Record missing entries is a tsc error, but a Record that
    // silently lost its type annotation is not.
    const at = side.indexOf("const SURFACE_ICONS");
    const body = side.slice(at, side.indexOf("\n};", at));
    const entries = (body.match(/^\s{2}"?[\w-]+"?: \w+,$/gm) ?? []).length;
    expect(entries).toBe(SURFACES.length);
  });

  it("the gates moved with the labels", () => {
    // A gate left behind in the sidebar would be invisible to iOS and to the
    // registry, which is how a plan gate ends up enforced on one client.
    const gated = ALL_SURFACES.filter(
      (s: Surface) => s.requiresFlipdeskFlag || s.requires || s.hiddenWhenFlipdeskFlag,
    );
    expect(gated.length).toBeGreaterThan(0);
    expect(
      /requiresFlipdeskFlag: "/.test(side),
      "a plan gate is still written into sidebar.tsx",
    ).toBe(false);
  });
});
