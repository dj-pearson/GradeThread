// US-2628 AC6: the SSR certificate page escapes the description, THEN turns
// newlines into <br> — and never interpolates it raw.
//
// WHY THIS TEST EXISTS SEPARATELY FROM THE FLATTENER'S OWN SUITE. The edge
// flattens a listing description to plain text once, in the endpoint both
// renderers read, and cert-description_test.ts covers that thoroughly. But the
// flattener returns TEXT, and text still has to reach an anonymous public page
// safely: the description is seller-controlled input, so the SSR page escaping
// it is the last thing standing between a seller and stored XSS on a
// certificate anyone can open.
//
// AC6 asks for exactly this guard and it was the one part of the story that had
// not shipped — the behaviour was right, nothing held it there. The ORDER is the
// property: escape first and the <br> tags this adds are the only markup in the
// output; convert first and every `<` the seller wrote survives the escape as a
// tag.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SSR = readFileSync(join(process.cwd(), "functions/cert/[id].ts"), "utf8");

/** The expression that builds the description paragraph. */
function descriptionExpression(): string {
  const at = SSR.indexOf("const descriptionHtml");
  expect(at, "descriptionHtml was renamed or removed").toBeGreaterThan(-1);
  return SSR.slice(at, SSR.indexOf(";", at) + 1);
}

describe("US-2628 AC6: the certificate SSR escapes the description before it renders", () => {
  it("escapes, and only then converts newlines", () => {
    const expr = descriptionExpression();
    expect(expr, "the description is not escaped").toMatch(/escape\(\s*cert\.description\s*\)/);
    // Order, asserted positionally rather than by presence: both halves can be
    // there in the wrong sequence and the wrong sequence is the vulnerability.
    const escapeAt = expr.indexOf("escape(");
    const brAt = expr.indexOf("<br>");
    expect(brAt, "no newline-to-<br> conversion").toBeGreaterThan(-1);
    expect(escapeAt, "the newline conversion happens before the escape").toBeLessThan(brAt);
  });

  it("never interpolates the description raw", () => {
    // `${cert.description}` with nothing around it is the failure. Matched on
    // the expression rather than the whole file so a mention in a COMMENT does
    // not satisfy or break it — that mistake has been made repeatedly here.
    const expr = descriptionExpression();
    expect(
      /\$\{\s*cert\.description\s*\}/.test(expr),
      "cert.description is interpolated raw into the page",
    ).toBe(false);
  });

  it("no other place in the page prints the description unescaped", () => {
    // The guard above pins one expression; this catches a second one appearing
    // elsewhere, which is how the first one stops being the only path.
    const raw = [...SSR.matchAll(/\$\{\s*cert\.description[^}]*\}/g)].map((m) => m[0]);
    const unescaped = raw.filter((m) => !/escape\(/.test(m));
    expect(unescaped, "an unescaped description interpolation").toEqual([]);
  });

  it("guard-the-guard: the escape helper is the shared one", () => {
    // A local `escape` that HTML-encodes nothing would satisfy every assertion
    // above. The page imports it from the shared render module.
    expect(SSR).toMatch(/import \{[^}]*\bescape\b[^}]*\} from "\.\.\/_shared\//);
  });
});
