// US-2357: the admin nav must not claim a gate it does not have.
//
// TWO THINGS THIS HOLDS, and they are different failures.
//
// 1. NAV TRUTH. The sidebar marks entries `superAdminOnly: true` — Incentives
//    and Audit Log — and that flag only HID the link. `<AdminRoute>` checks for
//    admin-or-better and nothing else, so typing either URL rendered the whole
//    page for a plain admin. A nav that hides a link it does not gate lies about
//    the shape of the product, and the operator reading it is the person least
//    able to check.
//
//    This is NOT a security assertion and must not be read as one. Every
//    mutation behind those pages is enforced server-side by scope plus an MFA
//    step-up, which is the real boundary; a client check can be removed with
//    devtools. US-2352 owns the actual hole (the audit-log export endpoint is
//    reachable by any admin, and no client gate closes that).
//
// 2. NO ADMIN WRITE ASSUMES SUCCESS. supabase-js resolves with `{ data, error }`
//    rather than rejecting, so a write that ignores `error` reports success for
//    a row RLS silently refused. That is exactly how users.plan and
//    submissions.status came to be broken features that looked like working ones
//    — the page toasted, wrote an audit row, and changed nothing. US-2376 moved
//    both to the edge; this stops the shape from coming back.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const NAV = "src/layouts/admin-layout.tsx";
const ADMIN_PAGES = "src/pages/admin";

/** `/admin/foo` → `src/pages/admin/foo.tsx`, when that file exists. */
function pageFileFor(route: string): string | null {
  const slug = route.replace(/^\/admin\/?/, "");
  if (!slug) return null;
  const candidate = join(ADMIN_PAGES, `${slug}.tsx`);
  try {
    readFileSync(resolve(ROOT, candidate), "utf8");
    return candidate;
  } catch {
    return null;
  }
}

describe("US-2357: superAdminOnly means the page is gated, not just hidden", () => {
  const nav = read(NAV);
  const flagged = [
    ...nav.matchAll(/to:\s*"(\/admin[^"]*)"[^}]*superAdminOnly:\s*true/g),
  ].map((m) => m[1]!);

  it("found the nav entries, so an empty list cannot pass as agreement", () => {
    // Guards the guard: if the nav is restructured and this regex stops
    // matching, every assertion below becomes trivially true.
    expect(flagged.length).toBeGreaterThan(0);
    expect(nav).toContain("superAdminOnly");
  });

  it("every superAdminOnly route renders behind SuperAdminOnly", () => {
    const ungated: string[] = [];
    for (const route of flagged) {
      const file = pageFileFor(route);
      // A route with no same-named page file is out of scope rather than a
      // pass — say so instead of skipping silently.
      expect(file, `no page file found for ${route}; wire it here`).not.toBeNull();
      if (!read(file!).includes("<SuperAdminOnly>")) ungated.push(`${route} (${file})`);
    }
    expect(
      ungated,
      "these nav entries are marked super-admin-only but their page renders " +
        "for any admin who types the URL",
    ).toEqual([]);
  });

  it("SuperAdminOnly checks the role rather than merely reading it", () => {
    const src = read("src/components/auth/super-admin-only.tsx");
    expect(src).toContain('profile?.role === "super_admin"');
    // An absent profile must NOT fall through to the children. Guessing
    // permissively for one render is how a gate becomes decorative.
    expect(src).not.toMatch(/if\s*\(!profile\)\s*return\s*<>/);
  });
});

describe("US-2357: no admin-page write assumes it succeeded", () => {
  function adminPageFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".tsx")) out.push(p);
      }
    };
    walk(ADMIN_PAGES);
    return out;
  }

  it("every supabase insert/update/delete/upsert reads its error", () => {
    const offenders: string[] = [];
    for (const file of adminPageFiles()) {
      const src = read(file);
      for (const m of src.matchAll(/supabase\s*\.from\(([^)]*)\)([\s\S]{0,500}?);/g)) {
        if (!/\.(insert|update|delete|upsert)\(/.test(m[0])) continue;
        // The check lives on the LEFT of the call — `const { error } = await
        // supabase.from(…)` — so the statement has to be read from its start,
        // not from the `supabase` token. My first version matched forward only
        // and reported a write that does read its error, which would have made
        // this guard permanently red on correct code.
        // Statement boundaries only — `;` and `{`. NOT a newline: a wrapped
        // `const { error } =` / newline / `await supabase` gets cut in half by
        // one, and the guard would then accuse correct code.
        const stmtStart = Math.max(
          src.lastIndexOf(";", m.index!),
          src.lastIndexOf("{", m.index!),
        );
        const block = src.slice(stmtStart + 1, m.index! + m[0].length);
        if (!/\berror\b/.test(block)) {
          const line = src.slice(0, m.index!).split("\n").length;
          offenders.push(`${file}:${line} → ${m[1]}`);
        }
      }
    }
    expect(
      offenders,
      "supabase-js RESOLVES on a refused write, so ignoring `error` means the " +
        "page reports success for a change RLS discarded — the exact bug " +
        "US-2376 fixed on users.plan and submissions.status.",
    ).toEqual([]);
  });

  it("the scan can still see a write, so a passing run means something", () => {
    // Without this, a rename of `supabase` or a formatting change would empty
    // the scan and the test above would pass by finding nothing at all.
    const seen = adminPageFiles().filter((f) =>
      /supabase\s*\.from\([\s\S]{0,500}?\.(insert|update|delete|upsert)\(/.test(read(f)),
    );
    expect(seen.length).toBeGreaterThan(0);
  });
});
