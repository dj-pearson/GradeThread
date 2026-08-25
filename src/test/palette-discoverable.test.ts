import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2863. The command palette has been mounted app-wide since US-1053 and
// opened on Cmd/Ctrl-K or "/". The header showed a keyboard-shortcuts icon, a
// theme toggle, a bell and an avatar — no search field. So the fastest way
// around a twenty-five destination app was reachable only by pressing a key
// nobody had told the user about.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const header = read("src/components/dashboard/header.tsx");
const palette = read("src/components/flipdesk/command-palette.tsx");

describe("the header offers a visible way into the palette (US-2863)", () => {
  it("the palette exports an open event", () => {
    expect(palette).toContain(
      'export const OPEN_COMMAND_PALETTE_EVENT = "gt:open-command-palette";',
    );
  });

  it("the palette listens for it", () => {
    expect(
      /addEventListener\(OPEN_COMMAND_PALETTE_EVENT/.test(palette),
      "the event is exported but nothing opens the dialog when it fires — the " +
        "header's button would then be a control that does nothing.",
    ).toBe(true);
    expect(
      /removeEventListener\(OPEN_COMMAND_PALETTE_EVENT/.test(palette),
      "the listener must be torn down with the effect",
    ).toBe(true);
  });

  it("the header dispatches it", () => {
    expect(header).toContain("OPEN_COMMAND_PALETTE_EVENT");
    expect(header).toMatch(
      /dispatchEvent\(new CustomEvent\(OPEN_COMMAND_PALETTE_EVENT\)\)/,
    );
  });

  it("the header renders the control, not just the function", () => {
    // The ordinary way this regresses: PaletteSearch survives a refactor and
    // the call site does not.
    expect(header).toContain("<PaletteSearch />");
  });

  it("there is a control at every width", () => {
    // A wide search box on desktop AND an icon button below md. One accessible
    // name, used by both, so a screen reader hears the same thing either way.
    const names = header.match(/aria-label="Search everything"/g) ?? [];
    expect(
      names.length,
      "expected two 'Search everything' controls: the desktop box (md and up) " +
        `and the icon button below it. Found ${names.length}.`,
    ).toBe(2);
    expect(header).toMatch(/md:flex/);
    expect(header).toMatch(/md:hidden/);
  });

  it("the desktop control shows the shortcut", () => {
    expect(header).toMatch(/<kbd[\s\S]{0,200}isMac \? "⌘K" : "Ctrl K"/);
  });
});

describe("the palette says what it can do before you type (US-2863)", () => {
  it("carries three worked examples", () => {
    const start = palette.indexOf("const PALETTE_EXAMPLES = [");
    expect(start, "PALETTE_EXAMPLES not found").toBeGreaterThan(-1);
    const block = palette.slice(start, palette.indexOf("];", start));
    const examples = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    expect(examples.length, "expected exactly three examples").toBe(3);
    for (const e of examples) {
      expect(e.length, `"${e}" is too terse to be an example`).toBeGreaterThan(10);
    }
  });

  it("renders them in the empty state", () => {
    expect(palette).toContain("PALETTE_EXAMPLES.map(");
  });

  it("hides them when search is down", () => {
    // US-2517's rule: an outage never poses as an empty result. Teaching the
    // user how to search, while search is broken, is the same mistake.
    expect(palette).toMatch(/\{!deepFailed && \([\s\S]{0,400}PALETTE_EXAMPLES\.map/);
  });
});
