import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3262. The import step sends a brand-new switcher to this page, and the
// first thing they do on it is paste a Google Sheets link and press Enter.
//
// The Fetch button was guarded -- `disabled={... || fetchSheet.isPending}` --
// and the Enter key was not. So a second Enter, or a held Enter, started a
// second fetch of the same sheet. Both calls resolve into `setText` +
// `detectFromText`, so whichever lands LAST wins: the mapping, the header list
// and the row count can all come from the earlier request while the toast
// reports the later one. That is the stale-response class US-3223 dealt with
// elsewhere, arriving here through the one entry point that had no guard.
//
// The fix is in `handleFetchSheet` rather than on the keydown, because the
// function is the thing that must be safe to call twice -- guarding one caller
// leaves the next caller to rediscover this.

const PAGE = "src/pages/flipdesk/import.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The body of a top-level `async function <name>(...)` declaration, by brace
 * matching.
 *
 * Scoped on purpose. A whole-file `toContain("isPending")` passes on the
 * Button's `disabled` prop 380 lines away, which is the guard that was already
 * there while the bug was live -- so a file-wide scan would have reported this
 * page clean the entire time it was broken.
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`no async function ${name} in the page`);
  const open = src.indexOf("{", start);
  if (open === -1) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("a second Enter cannot start a second sheet fetch (US-3262)", () => {
  it("handleFetchSheet bails out while a fetch is already in flight", () => {
    const body = functionBody(read(PAGE), "handleFetchSheet");
    expect(
      /if\s*\(\s*fetchSheet\.isPending\s*\)\s*return/.test(body),
      "handleFetchSheet does not check fetchSheet.isPending before firing. " +
        "The Fetch button is disabled while pending but the Enter key is not, " +
        "so two in-flight reads of the same sheet race into setText and the " +
        "loser's headers can overwrite the winner's.",
    ).toBe(true);
  });

  it("still refuses an empty link", () => {
    // The pre-existing guard. Asserted alongside the new one so a rewrite of
    // this function cannot drop it silently.
    const body = functionBody(read(PAGE), "handleFetchSheet");
    expect(/if\s*\(\s*!sheetUrl\.trim\(\)\s*\)\s*return/.test(body)).toBe(true);
  });

  it("the Enter key goes through handleFetchSheet, not straight to the mutation", () => {
    // If the keydown ever calls fetchSheet.mutateAsync directly it bypasses
    // every guard above, and the test at the top would still pass.
    const src = read(PAGE);
    expect(src).toMatch(
      /onKeyDown=\{\(e\)\s*=>\s*\{\s*if\s*\(e\.key === "Enter"\)\s*void handleFetchSheet\(\);/,
    );
  });

  // -------------------------------------------------------------- self-check
  //
  // vault/70-agent: an extractor that stops extracting reads exactly like clean
  // code. If the function is renamed or reshaped, fail loudly here rather than
  // going quiet above.
  it("the extractor actually found the function", () => {
    const body = functionBody(read(PAGE), "handleFetchSheet");
    expect(body.length).toBeGreaterThan(80);
    expect(body).toContain("fetchSheet.mutateAsync");
  });
});
