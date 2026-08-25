#!/usr/bin/env node
// US-2876. ONE generator for every table iOS mirrors out of TypeScript.
//
// Before this, each mirror was hand-typed into a `// BEGIN GENERATED TABLE`
// fence and pinned by its own Vitest parity test. That works -- the parity
// tests are real and they have caught real drift -- but it makes adding a
// mirror a two-file job that somebody has to remember, which is the same
// failure this story exists to fix one level up. Three separate stories were
// already parked waiting for "the generator" (US-2864 AC6, US-2865 AC5,
// US-2874 AC3), so it is this one, not a fourth.
//
//   node scripts/generate-swift-mirrors.mjs           write the fences
//   node scripts/generate-swift-mirrors.mjs --check   fail if they are stale
//
// --check runs in `npm run verify` and in CI. It is the whole point: a
// generator nobody re-runs is a hand-written file with extra steps.
//
// The TypeScript is READ, never imported. These modules pull `@/lib/constants`
// and lucide icons; running them would need a bundler, and a bundler in a
// codegen step is a build dependency that breaks on a Node upgrade. The arrays
// are plain literals, so the compiler's own parser resolves them exactly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const BEGIN = "// BEGIN GENERATED TABLE";
const END = "// END GENERATED TABLE";

// ── reading TypeScript object-literal arrays ──────────────────────────────

/** Statically evaluate a literal node. Throws on anything not a literal. */
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) {
        throw new Error(`non-literal property in object at pos ${p.pos}`);
      }
      out[p.name.getText()] = literal(p.initializer);
    }
    return out;
  }
  // `[...] as const satisfies readonly Surface[]` and friends.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  // US-2879: `"a " + "b"`. Long product copy in the registry is wrapped this
  // way to stay under the line limit, and the first entry that did it broke
  // the generator outright. Only string + string -- a `+` over numbers here
  // would mean the registry is computing something, which it must not.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    if (typeof left !== "string" || typeof right !== "string") {
      throw new Error(`+ over non-strings in the registry: ${node.getText().slice(0, 60)}`);
    }
    return left + right;
  }
  throw new Error(`not a literal: ${ts.SyntaxKind[node.kind]} "${node.getText().slice(0, 60)}"`);
}

/** The exported `const <name> = [...]` from a .ts file, as plain JS. */
function readExportedArray(relFile, name) {
  const abs = path.join(ROOT, relFile);
  const src = ts.createSourceFile(
    path.basename(relFile),
    fs.readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.name.getText() === name && d.initializer) {
          found = literal(d.initializer);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  if (found === null) throw new Error(`${relFile}: no exported const named ${name}`);
  if (!Array.isArray(found)) throw new Error(`${relFile}: ${name} is not an array`);
  return found;
}

// ── Swift emission ────────────────────────────────────────────────────────

/**
 * A Swift string literal.
 *
 * Deliberately narrow. Swift and TypeScript disagree about escapes in more
 * places than is comfortable, and this generator only ever handles product
 * copy, so anything that is not plain text is a bug in the SOURCE rather than
 * something to encode around.
 */
function swiftString(s) {
  if (/[\\\r\n\t]/.test(s)) {
    throw new Error(`copy contains an escape Swift and TS spell differently: ${JSON.stringify(s)}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(`copy contains a control character: ${JSON.stringify(s)}`);
  }
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** kebab / space / punctuation -> lowerCamelCase, for a Swift case name. */
function camelCase(s) {
  const parts = s
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  return parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join("");
}

// ── the mirrors ───────────────────────────────────────────────────────────
//
// Each entry names one fenced region and the function that fills it. Adding a
// mirror is one entry here plus the fence in the Swift file.

const MIRRORS = [
  {
    id: "surfaces",
    swift: "ios/GradeThread/Tools/ProductSurfaces.swift",
    from: "src/lib/surfaces.ts",
    build() {
      const surfaces = readExportedArray("src/lib/surfaces.ts", "SURFACES");
      const onIos = surfaces.filter((s) => s.ios !== null);
      const lines = [];
      for (const s of onIos) {
        lines.push(
          "        ProductSurface(",
          `            id: ${swiftString(s.id)},`,
          `            route: ${swiftString(s.ios)},`,
          `            label: ${swiftString(s.label)},`,
          `            summary: ${swiftString(s.description)},`,
          `            webLink: ${s.web === null ? "nil" : swiftString(s.web)}`,
          "        ),",
        );
      }
      return lines.join("\n");
    },
  },
  {
    id: "product-terms",
    swift: "ios/GradeThread/Help/ProductTerms.swift",
    from: "src/lib/product-terms.ts",
    build() {
      const terms = readExportedArray("src/lib/product-terms.ts", "PRODUCT_TERMS");
      const lines = [];
      for (const t of terms) {
        lines.push(
          "        ProductTerm(",
          `            term: ${swiftString(t.term)},`,
          `            definition: ${swiftString(t.definition)}`,
          "        ),",
        );
      }
      return lines.join("\n");
    },
  },
  {
    id: "help-slugs",
    swift: "ios/GradeThread/Help/HelpSlugs.swift",
    from: "src/lib/help-slugs.ts",
    build() {
      const slugs = readExportedArray("src/lib/help-slugs.ts", "PRODUCT_HELP_SLUGS");
      return slugs.map((s) => `    case ${camelCase(s.slug)} = ${swiftString(s.slug)}`).join("\n");
    },
  },
];

/** Splice `body` between the fences of `text`. Returns the new text. */
function splice(text, body, label) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`${label}: no BEGIN/END GENERATED TABLE fence`);
  }
  // Keep whatever trails BEGIN on its own line (the "(generated by ...)" note)
  // and whatever indents END.
  const beginLineEnd = text.indexOf("\n", b);
  const endLineStart = text.lastIndexOf("\n", e) + 1;
  return text.slice(0, beginLineEnd + 1) + body + "\n" + text.slice(endLineStart);
}

let stale = 0;
let wrote = 0;
for (const m of MIRRORS) {
  const abs = path.join(ROOT, m.swift);
  if (!fs.existsSync(abs)) {
    console.error(`  MISSING  ${m.swift} (declared by mirror "${m.id}")`);
    stale++;
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const after = splice(before.split("\r\n").join("\n"), m.build(), m.swift)
    .split("\n")
    .join(eol);
  if (after === before) {
    console.log(`  ok       ${m.swift}`);
    continue;
  }
  if (CHECK) {
    console.error(`  STALE    ${m.swift} -- regenerate from ${m.from}`);
    stale++;
  } else {
    fs.writeFileSync(abs, after);
    console.log(`  written  ${m.swift}`);
    wrote++;
  }
}

if (CHECK && stale > 0) {
  console.error(
    `\n${stale} Swift mirror(s) do not match their TypeScript source.\n` +
      "Run: node scripts/generate-swift-mirrors.mjs",
  );
  process.exit(1);
}
console.log(
  CHECK
    ? `\nall ${MIRRORS.length} Swift mirrors match their TypeScript source.`
    : `\n${wrote} written, ${MIRRORS.length - wrote} already current.`,
);
