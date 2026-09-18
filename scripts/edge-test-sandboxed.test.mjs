// The import map this builds is derived from deno.json, not copied from it.
//
// A hand-listed copy is what CLAUDE.md carried before scripts/edge-test-sandboxed.mjs
// existed, and a second source of truth for fifteen pinned versions goes stale
// the first time someone bumps one. These cases pin the derivation and the two
// specifiers it cannot derive.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyErrors, rewriteImports, DEGRADED } from "./edge-test-sandboxed.mjs";

const denoJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "services/edge-functions/deno.json"), "utf8"),
);

describe("the sandboxed edge-test import map", () => {
  it("turns an esm.sh pin into the same npm pin", () => {
    const { imports } = rewriteImports({
      stripe: "https://esm.sh/stripe@15.5.0",
    });
    expect(imports.stripe).toBe("npm:stripe@15.5.0");
  });

  it("drops an esm.sh build query, which means nothing to npm", () => {
    // `?target=deno` selects an esm.sh build variant. Carried through to a
    // npm: specifier it would be part of the version string and resolve to
    // nothing.
    const { imports } = rewriteImports({
      "@jsquash/webp": "https://esm.sh/@jsquash/webp@1.4.0?target=deno",
    });
    expect(imports["@jsquash/webp"]).toBe("npm:@jsquash/webp@1.4.0");
  });

  it("keeps a scoped package's scope", () => {
    const { imports } = rewriteImports({
      "@anthropic-ai/sdk": "https://esm.sh/@anthropic-ai/sdk@0.104.1",
    });
    expect(imports["@anthropic-ai/sdk"]).toBe("npm:@anthropic-ai/sdk@0.104.1");
  });

  it("sends @std/assert to jsr, which the proxy allows", () => {
    // deno.json maps it at deno.land, which is refused. 1038 edge test files
    // import it, so this one entry decides whether anything runs at all.
    const { imports } = rewriteImports({
      "@std/assert": "https://deno.land/std@0.224.0/assert/mod.ts",
    });
    expect(imports["@std/assert"]).toBe("jsr:@std/assert@1.0.8");
  });

  it("leaves an already-reachable specifier alone", () => {
    const { imports, unresolved } = rewriteImports({
      hono: "jsr:@hono/hono@4.13.1",
      "./local.ts": "./local.ts",
    });
    expect(imports.hono).toBe("jsr:@hono/hono@4.13.1");
    expect(imports["./local.ts"]).toBe("./local.ts");
    expect(unresolved).toEqual([]);
  });

  it("REPORTS a blocked specifier it has no rule for", () => {
    // The whole point, and it is about the NEXT dependency rather than the two
    // known ones. A map that silently left a blocked host in place would abort
    // the run on the first file importing it, with nothing saying why.
    //
    // Asked of a synthetic specifier, because denomailer and imagescript are in
    // DEGRADED now and the earlier version of this case pinned denomailer as
    // unresolved -- which stopped being true the moment they were mapped.
    const { unresolved } = rewriteImports({
      "some-future-dep": "https://deno.land/x/some_future_dep@1.0.0/mod.ts",
    });
    expect(unresolved).toEqual([
      ["some-future-dep", "https://deno.land/x/some_future_dep@1.0.0/mod.ts"],
    ]);
  });

  it("maps a degraded specifier rather than leaving it blocked", () => {
    // THE DEFECT THE FIRST VERSION SHIPPED. Refusing to map denomailer and
    // imagescript looked like the careful choice and aborted the entire run,
    // because deno treats an unresolvable import as fatal. Zero tests measured
    // is worse than 9,673 measured with 110 accounted for.
    const { imports, unresolved } = rewriteImports(denoJson.imports ?? {});
    for (const key of Object.keys(DEGRADED)) {
      expect(imports[key], `${key} must resolve to something`).toBe(
        DEGRADED[key].to,
      );
      expect(imports[key]).not.toMatch(/deno\.land|esm\.sh/);
    }
    expect(unresolved, "nothing in deno.json should be left unmapped").toEqual([]);
  });

  it("every degraded entry carries a reason AND a signature", () => {
    // Without the signature its failures land in the UNEXPLAINED bucket and the
    // script exits 1. Without the reason nobody can re-check it.
    for (const [key, d] of Object.entries(DEGRADED)) {
      expect(d.breaks.length, `${key} has no recorded reason`).toBeGreaterThan(20);
      expect(d.signature, `${key} has no error signature`).toBeInstanceOf(RegExp);
      expect(d.to, `${key} must name a substitute`).toMatch(/^(npm|jsr):/);
    }
  });

  it("leaves NOTHING in the real deno.json pointing at a blocked host", () => {
    // Measured 2026-09-18: fifteen of deno.json's specifiers point at deno.land
    // or esm.sh. All fifteen have to move or the run dies on the first one.
    const before = Object.values(denoJson.imports ?? {}).filter((v) =>
      /deno\.land|esm\.sh/.test(v),
    ).length;
    expect(before).toBeGreaterThan(0);
    const { imports } = rewriteImports(denoJson.imports ?? {});
    const stillBlocked = Object.entries(imports).filter(([, v]) =>
      /deno\.land|esm\.sh/.test(v),
    );
    expect(stillBlocked).toEqual([]);
  });
});

// ── Classifying failures, which is where this script earns its keep ──────────
//
// The first version had two buckets: signature match = "explained", everything
// else = "unexplained". On the first full run that reported 109 of 110 failures
// as explained. One was not: `turn 1: mark vanished` in
// measure-auto-upright_test.ts, an ASSERTION failure in a file that imports
// imagescript. The substitution caused it, and widening the signature list
// until it matched would have been the wrong fix -- the next such failure is
// indistinguishable from a real defect and nothing here can tell them apart.

describe("classifyErrors", () => {
  it("drops deno's exit banner, which is not a failure", () => {
    // Counting it is why the first run reported 110 errors for 109 failing
    // tests. An off-by-one in the direction of inventing a failure is mild; the
    // same bug in the other direction would have hidden one.
    const { attributed, rest } = classifyErrors(
      "ok | 10 passed | 0 failed\nerror: Test failed\n",
    );
    expect(attributed).toEqual([]);
    expect(rest).toEqual([]);
  });

  it("attributes a module-load error that names a degraded dependency", () => {
    const { attributed, rest } = classifyErrors(
      "error: SyntaxError: The requested module 'denomailer' does not provide " +
        "an export named 'SMTPClient'\n",
    );
    expect(attributed).toHaveLength(1);
    expect(rest).toEqual([]);
  });

  it("does NOT attribute an assertion failure, even in a degraded file", () => {
    // The measured case. This is the whole reason the third category exists.
    const { attributed, rest } = classifyErrors(
      "error: AssertionError: Values are not equal: turn 1: mark vanished\n",
    );
    expect(attributed).toEqual([]);
    expect(rest).toEqual([
      "error: AssertionError: Values are not equal: turn 1: mark vanished",
    ]);
  });

  it("leaves a real defect unattributed", () => {
    const { rest } = classifyErrors(
      "error: TypeError: cannot read properties of null (reading 'userId')\n",
    );
    expect(rest).toHaveLength(1);
  });

  it("reads through ANSI colour, which deno emits by default", () => {
    // Classifying the coloured text would match nothing and report every
    // failure as unattributable -- noisy, but in the safe direction. Still
    // worth pinning, because the safe direction is where it gets ignored.
    const { attributed } = classifyErrors(
      "\u001b[31merror\u001b[0m: SyntaxError: The requested module " +
        "'denomailer' does not provide an export named 'SMTPClient'\n",
    );
    expect(attributed).toHaveLength(1);
  });

  it("every degraded signature matches the text its dependency really emits", () => {
    // A signature nobody has seen fire is a signature that may not fire.
    // Measured 2026-09-18: these are the two strings the run actually printed.
    const real = {
      denomailer:
        "error: SyntaxError: The requested module 'denomailer' does not " +
        "provide an export named 'SMTPClient'",
      imagescript:
        "error: TypeError: Cannot read properties of undefined (reading 'encode')",
    };
    for (const [key, line] of Object.entries(real)) {
      expect(
        DEGRADED[key].signature.test(line),
        `${key}'s signature does not match the error it produces`,
      ).toBe(true);
    }
  });
});
