// US-2167: a `getQueryData` peek must read a key some hook actually WRITES.
//
// THE BUG THIS EXISTS FOR. The FlipDesk command palette read the cache directly
// — `getQueryData(["items_full", user?.id])` — to offer instant matches with no
// extra round-trip. That is a good pattern. But it spelled the key out BY HAND,
// as an array literal, rather than calling the exported key factory.
//
// US-2188 then moved every consumer of `items_full` onto a projected read,
// `useItemsList()`, which writes a DIFFERENT key. `useItemsFull()` — the writer
// of the key the palette was reading — was left with no callers at all. The
// palette's key therefore had no writer.
//
// Nothing failed. `getQueryData` on an unwritten key returns `undefined`, the
// `?? []` at the call site turned that into an empty array, and the palette's
// "Recent" section — the whole content of the panel when the search box is
// EMPTY — silently had nothing to show. Typed searches kept working, because
// those come from a separate FTS RPC, so the feature looked healthy. A refactor
// deleted a feature and left every test green.
//
// WHY A SOURCE SCAN. Both halves are invisible at runtime below the surface: a
// missing writer is indistinguishable from an empty cache, and an empty cache is
// the NORMAL state on first render. There is no assertion to make against a
// running app that would have caught this.
//
// Guarded by ENUMERATION rather than by pattern, matching the house style: every
// cache peek is declared with the module that writes its key, and the scan
// asserts the declared set IS the whole set. A new peek fails this test until
// its author names the writer — which is the question that was never asked.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

interface DeclaredPeek {
  /** The file doing the `getQueryData` read. */
  readonly file: string;
  /** How the key is written at the read site. */
  readonly key: string;
  /** The module that registers a query under that key. */
  readonly writer: string;
  /** The `queryKey:` line that must exist in the writer. */
  readonly writes: string;
  readonly why: string;
}

const DECLARED: readonly DeclaredPeek[] = [
  {
    file: "src/components/flipdesk/command-palette.tsx",
    key: "itemsListQueryKey(user?.id)",
    writer: "src/hooks/use-items-full.ts",
    writes: "queryKey: itemsListQueryKey(user?.id)",
    why:
      "instant item matches + the Recent section, off whatever the projected " +
      "list read already cached. This is the read that broke.",
  },
  {
    file: "src/components/flipdesk/command-palette.tsx",
    key: '["sources", user?.id]',
    writer: "src/hooks/use-sources.ts",
    writes: 'queryKey: ["sources", user?.id]',
    why: "instant source matches; useSources owns the key",
  },
  {
    file: "src/hooks/use-dashboard-layout.ts",
    key: "getQueryData<LayoutEntry[]>(key)",
    writer: "src/hooks/use-dashboard-layout.ts",
    writes: "queryKey: dashboardLayoutKey(user?.id, surface)",
    why:
      "the US-3073 optimistic layout save snapshots the current widget list " +
      "before patching it, so onError can roll back; `key` is " +
      "dashboardLayoutKey(user?.id, surface), and useDashboardLayout in the " +
      "same module is the writer",
  },
  {
    file: "src/pages/flipdesk/listings.tsx",
    key: "listingsPageKey",
    writer: "src/pages/flipdesk/listings.tsx",
    writes: "queryKey: listingsPageKey",
    why:
      "the US-2372 optimistic write reads the current page back before " +
      "patching it; writer and reader are the same module",
  },
];

/** Every .ts/.tsx under src/, excluding tests. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "test") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

/** `src/...` paths, forward-slashed, of every file containing a cache peek. */
function filesWithPeeks(): string[] {
  return sourceFiles()
    .filter((f) => /\bgetQueryData\s*[<(]/.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(/\\/g, "/").slice(ROOT.replace(/\\/g, "/").length + 1))
    .sort();
}

describe("US-2167: every cache peek reads a key something writes", () => {
  it("each declared peek's key is registered by its declared writer", () => {
    for (const d of DECLARED) {
      const reader = read(d.file);
      expect(
        reader.includes(`getQueryData`),
        `${d.file} no longer peeks the cache — drop its declaration`,
      ).toBe(true);
      expect(
        reader.includes(d.key),
        `${d.file} no longer reads ${d.key} (${d.why})`,
      ).toBe(true);
      expect(
        read(d.writer).includes(d.writes),
        `${d.writer} no longer registers a query with \`${d.writes}\`, so ` +
          `${d.file}'s peek at ${d.key} would silently read undefined forever`,
      ).toBe(true);
    }
  });

  it("the declared set is the whole set", () => {
    // A new peek is not wrong — it just has to name its writer here, which is
    // the question nobody asked the first time.
    const declaredFiles = [...new Set(DECLARED.map((d) => d.file))].sort();
    expect(filesWithPeeks()).toEqual(declaredFiles);
  });

  it("nobody hand-spells the items_full key the palette used to read", () => {
    // The specific literal, kept by name. `useItemsFull()` still exists as a
    // deliberate escape hatch for a surface that genuinely needs every column,
    // so the key is not dead — it just has no writer at the moment, and a
    // hand-spelled read of it is a peek at nothing.
    const offenders = sourceFiles().filter((f) => {
      const body = readFileSync(f, "utf8");
      return (
        /getQueryData[^;]*\[\s*"items_full"\s*,/.test(body) &&
        !body.includes("itemsListQueryKey")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("useItemsFull is still unused, or its key has a reader again", () => {
    // Not a rule so much as a tripwire on the condition that made the bug
    // possible: an exported hook with no callers, whose key another file reads
    // by hand. If someone starts calling useItemsFull, this test should be
    // revisited rather than trusted — so it states the current fact out loud.
    // Detected by IMPORT rather than by call text: prose about `useItemsFull()`
    // — including the explanation above — is not a caller, and a scan that
    // cannot tell the difference reddens on its own documentation.
    const IMPORTS_IT =
      /import\s*\{[^}]*\buseItemsFull\b[^}]*\}\s*from\s*["'][^"']*use-items-full["']/s;
    const callers = sourceFiles().filter((f) => {
      if (f.endsWith("use-items-full.ts")) return false;
      return IMPORTS_IT.test(readFileSync(f, "utf8"));
    });
    expect(
      callers,
      "useItemsFull() has callers now. That is allowed — but it means the " +
        "bare [\"items_full\", userId] key has a writer again, so re-read " +
        "this file's third case before extending it.",
    ).toEqual([]);
  });
});
