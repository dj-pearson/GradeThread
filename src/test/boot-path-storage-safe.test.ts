import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3218.
//
// Reading `localStorage` or `sessionStorage` can THROW, not just return null.
// Chrome raises a SecurityError when the visitor has blocked site data for the
// origin, and inside a cross-origin iframe whose storage access is denied.
// The property access itself throws, so no `typeof` check guards it.
//
// routes/lazy.tsx cleared its stale-chunk flag with a bare
// `sessionStorage.removeItem(...)` inside the `.then()` of every lazy import.
// EVERY route in this app is lazily loaded, and its `.catch()` recovery path
// touched sessionStorage too. So a visitor with site data blocked got an error
// boundary on every page of the product — marketing, public certificates,
// dashboard — from a browser setting we never see and they chose deliberately.
//
// These files run before or during the first render of every route. Raw
// storage access in any of them is a whole-app outage rather than a lost
// preference, so they go through @/lib/safe-storage. Everything else may still
// inline a try/catch; this guard is deliberately narrow, and the list is meant
// to grow when a new file joins the boot path, not to police the whole tree.

const BOOT_PATH_FILES = [
  "src/main.tsx",
  "src/routes/lazy.tsx",
  "src/routes/index.tsx",
  "src/stores/theme-store.ts",
  "src/stores/auth-store.ts",
  "src/lib/query-client.ts",
  // Not "before the first render", but the same severity for the same reason.
  // These four decide where a sign-in LANDS. auth-callback runs after the
  // provider has already authenticated the visitor, so a throw there left
  // them signed in and stranded on a blank screen -- a sign-in that cannot
  // complete, not a preference that did not stick.
  "src/pages/login.tsx",
  "src/pages/auth-callback.tsx",
  "src/pages/auth-confirm.tsx",
  "src/pages/accept-invite.tsx",
];

// src/pages/flipdesk/autolister.tsx is NOT on that list, though its session-id
// read during render was the same severity and was fixed alongside these. The
// rest of that file's ~8 storage calls all sit inside try/catch already, and a
// line-level rule cannot see that, so listing it would mean converting eight
// working call sites to satisfy a guard rather than to fix anything.

// src/lib/supabase.ts is deliberately NOT on that list. Its `hybridStorage`
// adapter IS a safe-storage implementation -- it is the Storage object handed
// to supabase-js, every branch already sits inside try/catch, and it has to
// name localStorage and sessionStorage separately because choosing between
// them on a shared device is the whole point of it. Routing it through
// safe-storage would be a wrapper around a wrapper.

// `localStorage.getItem(...)`, `window.sessionStorage.setItem(...)`, etc.
const RAW_STORAGE = /(?:\bwindow\s*\.\s*)?\b(?:local|session)Storage\s*\.\s*\w+\s*\(/;

function bodyLines(rel: string): { n: number; text: string }[] {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return src
    .split(/\r?\n/)
    .map((text, i) => ({ n: i + 1, text }))
    // Comments explaining the rule are not violations of it.
    .filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text));
}

describe("boot-path files can't be taken down by blocked site data (US-3218)", () => {
  it("the listed files all exist", () => {
    // Guard the guard: a renamed file must fail loudly, not drop out silently.
    for (const rel of BOOT_PATH_FILES) {
      expect(() => readFileSync(resolve(process.cwd(), rel), "utf8"), rel).not.toThrow();
    }
    expect(BOOT_PATH_FILES.length).toBeGreaterThan(5);
  });

  it("the pattern actually matches the shape it is looking for", () => {
    // A regex that matches nothing passes forever.
    expect(RAW_STORAGE.test('sessionStorage.removeItem("k");')).toBe(true);
    expect(RAW_STORAGE.test("window.localStorage.getItem(key)")).toBe(true);
    expect(RAW_STORAGE.test('readStored("gt-theme")')).toBe(false);
  });

  it("no boot-path file touches localStorage or sessionStorage directly", () => {
    const offenders: string[] = [];
    for (const rel of BOOT_PATH_FILES) {
      for (const { n, text } of bodyLines(rel)) {
        if (RAW_STORAGE.test(text)) offenders.push(`${rel}:${n}  ${text.trim()}`);
      }
    }
    expect(
      offenders,
      "these run on every route load, so a browser that blocks site data " +
        "turns the throw into a whole-app outage. Use readStored / " +
        "writeStored / removeStored from @/lib/safe-storage:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
