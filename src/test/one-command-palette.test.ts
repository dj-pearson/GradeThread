import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_SEARCH_GROUP_ORDER } from "@/lib/admin-search";

// US-2881. Two palettes, two command sets, two behaviours.
//
// They were separate components with separate keyboard handling and separate
// result rendering, and an admin moving between the two shells got two search
// boxes that looked alike and were not. The differences were REAL, not
// cosmetic, and they are worth writing down because "they look the same" is
// what stopped anybody noticing:
//
//   ARIA      the seller palette implements the combobox pattern (US-441);
//             the admin one was a plain input over a div of buttons, so a
//             screen-reader user heard nothing as they arrowed through.
//   ARROWS    admin WRAPPED (modulo), the seller shell CLAMPED.
//   Cmd-K     admin used useKeyboardShortcuts with allowInInput; the seller
//             shell hand-rolled a listener whose Cmd-K branch skipped the
//             typing check the hook applies by default -- so the same
//             keystroke inside a text field opened the palette on /admin and
//             did nothing on /dashboard.
//
// PaletteShell owns all three now. A module supplies the sections and what a
// row looks like inside.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

const SHELL = "src/components/palette/palette-shell.tsx";
const SELLER = "src/components/flipdesk/command-palette.tsx";
const ADMIN = "src/components/admin/command-palette.tsx";

describe("there is one palette component (US-2881 AC1)", () => {
  it("both modules render the shared shell", () => {
    for (const f of [SELLER, ADMIN]) {
      const src = stripComments(read(f));
      expect(src, `${f} does not render PaletteShell`).toMatch(/<PaletteShell\b/);
    }
  });

  it("neither module builds its own dialog any more", () => {
    // A second <Dialog> here is the split starting again: it is the thing that
    // carries the input, the listbox and the keyboard.
    for (const f of [SELLER, ADMIN]) {
      const src = stripComments(read(f));
      expect(src, `${f} still opens its own Dialog`).not.toMatch(/<DialogContent\b/);
    }
  });

  it("the modules got smaller because the shell took the shared half", () => {
    // Counted, not asserted by eye. If a module grows back past its
    // pre-refactor size, the shared code has been copied back into it.
    const lines = (f: string) => read(f).split("\n").length;
    expect(lines(SELLER), "the seller module is bigger than the 824 it started at")
      .toBeLessThan(824);
    expect(lines(ADMIN), "the admin module is bigger than the 259 it started at")
      .toBeLessThan(259);
    expect(lines(SHELL), "the shell is suspiciously small to own all of that")
      .toBeGreaterThan(120);
  });
});

describe("a module cannot leak into the wrong shell (US-2881 AC2)", () => {
  it("the admin module is only mounted by the admin layout", () => {
    const adminLayout = read("src/layouts/admin-layout.tsx");
    expect(adminLayout).toContain("@/components/admin/command-palette");
    const dashLayout = read("src/layouts/dashboard-layout.tsx");
    expect(
      dashLayout,
      "the seller shell mounts the admin palette",
    ).not.toContain("@/components/admin/command-palette");
    const buyerLayout = read("src/layouts/buyer-layout.tsx");
    expect(buyerLayout).not.toContain("command-palette");
  });

  it("the seller module is only mounted by the seller layout", () => {
    const dashLayout = read("src/layouts/dashboard-layout.tsx");
    expect(dashLayout).toContain("@/components/flipdesk/command-palette");
    const adminLayout = read("src/layouts/admin-layout.tsx");
    expect(adminLayout).not.toContain("@/components/flipdesk/command-palette");
  });

  it("the shell knows nothing about either module", () => {
    // The isolation is structural: the shell is generic, so it cannot import
    // an admin search type or a seller entry kind even by accident.
    const shell = stripComments(read(SHELL));
    for (const leak of ["admin-search", "AdminSearchResult", "ItemListRow", "runbook"]) {
      expect(shell, `PaletteShell reaches into a module: ${leak}`).not.toContain(leak);
    }
  });

  it("the admin module does not import seller data, and vice versa", () => {
    expect(stripComments(read(ADMIN))).not.toContain("item-list-columns");
    expect(stripComments(read(SELLER))).not.toContain("admin-search");
  });

  it("the seller palette still hides its admin actions from sellers", () => {
    // Separate from the shell split, and still needed: the seller palette has
    // always carried Admin: Console / Users / Disputes / Reviews as quick
    // navigation, filtered by isAdmin.
    const seller = stripComments(read(SELLER));
    expect(seller).toContain("adminOnly: true");
    expect(seller).toMatch(/!a\.adminOnly \|\| isAdmin/);
  });
});

describe("keyboard, grouping and the empty state come from the shell (US-2881 AC3)", () => {
  const shell = stripComments(read(SHELL));

  it("the shell owns arrow keys and Enter", () => {
    expect(shell).toContain('e.key === "ArrowDown"');
    expect(shell).toContain('e.key === "ArrowUp"');
    expect(shell).toContain('e.key === "Enter"');
    for (const f of [SELLER, ADMIN]) {
      const src = stripComments(read(f));
      expect(src, `${f} handles arrow keys itself again`).not.toContain('e.key === "ArrowDown"');
    }
  });

  it("arrow keys clamp rather than wrap, once, for both", () => {
    // admin used modulo, the seller shell clamped. Clamping wins: wrapping
    // jumps you from the last result back to the first with no signal.
    expect(shell).toContain("Math.min(flat.length - 1, i + 1)");
    expect(shell).toContain("Math.max(0, i - 1)");
    expect(shell, "the wrapping version came back").not.toContain("% flat.length");
  });

  it("the shell owns the combobox pattern, so admin has it now too", () => {
    expect(shell).toContain('role="combobox"');
    expect(shell).toContain("aria-activedescendant");
    expect(shell).toContain('role="listbox"');
    expect(shell).toContain('role="option"');
    expect(shell).toContain('role="group"');
    // And the admin module does not re-implement a bare input over buttons.
    const admin = stripComments(read(ADMIN));
    expect(admin, "the admin module builds its own input again").not.toContain("<input");
  });

  it("the shell owns grouping, and both modules hand it sections", () => {
    expect(shell).toContain("sections.map(");
    expect(shell).toContain("section.entries.map(");
    for (const f of [SELLER, ADMIN]) {
      expect(stripComments(read(f)), `${f} does not pass sections`).toContain("sections=");
    }
  });

  it("the active row resets on a new query, not just clamps", () => {
    // Clamping alone leaves somebody who arrowed to row five sitting on row
    // five of a different list. Both palettes did this before the split and it
    // would have been quietly dropped in the merge.
    const at = shell.indexOf("useEffect(() => {\n    setActiveIdx(0);\n  }, [query]);");
    expect(at, "the shell does not reset the active row when the query changes")
      .toBeGreaterThan(-1);
  });

  it("both modules supply an empty state and the shell renders it", () => {
    expect(shell).toContain("{empty}");
    for (const f of [SELLER, ADMIN]) {
      expect(stripComments(read(f)), `${f} passes no empty state`).toContain("empty=");
    }
  });

  it("recent searches are still the seller module's, not the shell's", () => {
    // "recent-items behaviour comes from the shared component" cannot mean the
    // shell fetches them: admin has no recents and no per-user search history.
    // What is shared is the ROW MACHINERY; the data stays with the module that
    // has any.
    expect(stripComments(read(SELLER))).toContain("recentsearch");
    expect(shell, "the shell grew an opinion about recent searches").not.toContain("recent");
  });
});

describe("one Cmd-K, one behaviour (US-2881 AC3)", () => {
  it("both shells open through the shared hook", () => {
    for (const f of [SELLER, "src/layouts/admin-layout.tsx"]) {
      const src = stripComments(read(f));
      expect(src, `${f} does not use useKeyboardShortcuts`).toContain("useKeyboardShortcuts");
    }
  });

  it("Cmd-K works inside a text field on both", () => {
    // The actual bug: the seller shell's hand-rolled Cmd-K branch never called
    // isTypingTarget, but the hook skips typing targets by default -- so
    // moving to the hook without allowInInput would have SILENTLY REMOVED a
    // behaviour sellers already had.
    for (const f of [SELLER, "src/layouts/admin-layout.tsx"]) {
      const src = stripComments(read(f));
      expect(src, `${f} lost allowInInput on Cmd-K`).toMatch(
        /key: "k",[\s\S]{0,80}allowInInput: true/,
      );
    }
  });

  it("the seller shell no longer hand-rolls a keydown listener", () => {
    const seller = stripComments(read(SELLER));
    expect(
      seller,
      'the seller palette added its own window keydown listener back',
    ).not.toContain('window.addEventListener("keydown"');
  });

  it('"/" stays typing-aware', () => {
    // It is a printable character. Opening a dialog when somebody types a
    // slash into a field is a bug, not a shortcut -- so it must NOT gain
    // allowInInput along with Cmd-K.
    const seller = stripComments(read(SELLER));
    const at = seller.indexOf('key: "/"');
    expect(at, "the seller palette lost its / shortcut").toBeGreaterThan(-1);
    const entry = seller.slice(at, seller.indexOf("}", at));
    expect(entry, '"/" fires while the user is typing').not.toContain("allowInInput");
  });
});

describe("the admin commands all still work (US-2881 AC4)", () => {
  // THE STORY SAYS "verified by its existing tests". THERE WERE NONE.
  // src/lib/admin-search.test.ts covers the pure helpers (4 cases) and never
  // touches the component; nothing else referenced it at all. So this block is
  // the coverage the AC assumed already existed.
  const admin = stripComments(read(ADMIN));

  it("every result type still has an icon", () => {
    for (const type of [
      "user",
      "submission",
      "certificate",
      "listing",
      "sale",
      "ticket",
      "runbook",
    ]) {
      expect(admin, `the ${type} row lost its icon`).toMatch(
        new RegExp(`^\\s*${type}: \\w+,$`, "m"),
      );
    }
  });

  it("every declared group is offered to the shell", () => {
    expect(admin).toContain("ADMIN_SEARCH_GROUP_ORDER.map(");
    expect(ADMIN_SEARCH_GROUP_ORDER.length).toBeGreaterThan(5);
  });

  it("the search still calls the admin endpoint, debounced and abortable", () => {
    expect(admin).toContain("/api/admin/search?q=");
    expect(admin).toContain("AbortController");
    expect(admin).toMatch(/setTimeout\(\(\) => setDebounced\(query\.trim\(\)\), 300\)/);
  });

  it("the two-character floor is still there", () => {
    expect(admin).toContain("debounced.length < 2");
  });

  it("runbooks are still matched in the client, with no request", () => {
    expect(admin).toContain("searchRunbooks(");
    expect(admin).toContain('href: `/admin/ops/runbooks/${rb.slug}`');
  });

  it("selecting a result closes the palette and navigates", () => {
    expect(admin).toMatch(/onOpenChange\(false\);[\s\S]{0,60}navigate\(r\.href\)/);
  });

  it("closing resets the state so it opens fresh", () => {
    expect(admin).toMatch(/if \(!open\) \{[\s\S]{0,200}emptyAdminSearchGroups\(\)/);
  });
});
