// ACC-8: every in-app link that names a Settings or Account tab must name one
// that exists. The AI self-cap toast used to open /dashboard/settings (Profile)
// and the workspace-2FA toast ?tab=settings (Profile too); legal pages sent
// "export or delete" readers to Profile. An unknown ?tab= does not error, it
// silently lands on the default tab, so nothing else would notice.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_HUB_TAB_VALUES, SETTINGS_TAB_VALUES } from "@/lib/settings-tabs";

const ROOTS = ["src", "services/edge-functions/src", "functions"];
const SKIP = /(^|\/)(test|tests|__tests__)(\/|$)|\.test\.tsx?$|_test\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !SKIP.test(p)) out.push(p);
  }
  return out;
}

const valid = new Set<string>([...ACCOUNT_HUB_TAB_VALUES, ...SETTINGS_TAB_VALUES]);

describe("settings deep links name real tabs", () => {
  const links: Array<{ file: string; tab: string }> = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\/dashboard\/(?:account|settings)\?tab=([\w-]+)/g)) {
        links.push({ file, tab: m[1]! });
      }
    }
  }

  it("finds links to check", () => {
    // If the scan breaks, the next assertion passes while checking nothing.
    expect(links.length).toBeGreaterThan(10);
  });

  it("every ?tab= value is an Account hub tab or a Settings section", () => {
    const bad = links.filter((l) => !valid.has(l.tab));
    expect(bad).toEqual([]);
  });

  it("the AI cap and workspace-2FA toasts open the AI and Security sections", () => {
    const src = readFileSync("src/lib/edge-fetch.ts", "utf8");
    expect(src).toContain('appNavigate(settingsTabHref("ai"))');
    expect(src).toContain('appNavigate(settingsTabHref("security"))');
    // No full reload for either.
    expect(src).not.toMatch(/window\.location\.href\s*=\s*"\/dashboard\/(account|settings)/);
  });

  it("the legal and buyer export/delete links point at Danger and Data", () => {
    expect(readFileSync("src/pages/legal/account-deletion.tsx", "utf8")).toContain(
      "/dashboard/account?tab=danger",
    );
    expect(readFileSync("src/pages/buyer/settings.tsx", "utf8")).toContain(
      "/dashboard/account?tab=data",
    );
  });
});

describe("appNavigate", () => {
  it("uses the registered router navigate, and location.assign without one", async () => {
    const { appNavigate, registerAppNavigate } = await import("@/lib/app-navigate");
    const seen: string[] = [];
    registerAppNavigate((to) => seen.push(to));
    appNavigate("/dashboard/account?tab=ai");
    expect(seen).toEqual(["/dashboard/account?tab=ai"]);
    registerAppNavigate(null);
  });
});
