// US-3055 — derive forced light/dark rules from a stylesheet's ONE
// prefers-color-scheme:dark block, so a theme preference can override the OS.
//
// WHY GENERATED. Every extension sheet keeps a single dark media block
// (src/test/popup-theme.test.ts requires exactly one in popup.css), and a media
// query cannot be switched off from a page. A preference therefore needs the
// same rules under an attribute selector — html[data-theme="dark"] — and, for
// forced LIGHT on a dark OS, rules that put the light values back with higher
// specificity than the media block. Writing those by hand is a second copy of
// every dark rule that drifts the first time someone edits the block. So they
// are derived: the dark side is the block's rules re-scoped, the light side is
// each dark-declared property looked up in the base sheet and re-scoped.
//
// Deliberately small: a brace-walking parser for the CSS this repo writes
// (rule blocks, one level of @media, no nesting inside rules). Not a general
// CSS parser and not meant to be one.

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DARK_MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split `a; b: url(x;y)` on semicolons outside parentheses and quotes. */
function splitDecls(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      if (i < 0) return null;
      return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

/**
 * Walk one level of blocks. Returns [{ prelude, body, children }], where a
 * rule has `body` (declaration text) and an at-rule with nested rules has
 * `children` (parsed the same way).
 */
function parseBlocks(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    if (prelude.startsWith("@") && inner.includes("{")) {
      out.push({ prelude, children: parseBlocks(inner) });
    } else {
      out.push({ prelude, body: inner });
    }
    i = j;
  }
  return out;
}

/** { base: [{selector, decls}], dark: [{selector, decls}], darkBlocks } */
function parse(css) {
  const blocks = parseBlocks(stripComments(css));
  const base = [];
  const dark = [];
  let darkBlocks = 0;
  for (const b of blocks) {
    if (b.children) {
      if (DARK_MEDIA.test(b.prelude)) {
        darkBlocks++;
        for (const r of b.children) if (r.body !== undefined) dark.push({ selector: r.prelude, decls: splitDecls(r.body) });
      }
      continue; // other at-rules (keyframes, reduced-motion) carry no theme
    }
    if (b.prelude.startsWith("@")) continue;
    base.push({ selector: b.prelude, decls: splitDecls(b.body) });
  }
  return { base, dark, darkBlocks };
}

function selectorsOf(rule) {
  return rule.selector.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The LAST base value of `prop` declared for exactly `selector`, else null. */
function baseValue(base, selector, prop) {
  let found = null;
  for (const r of base) {
    if (!selectorsOf(r).includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) found = d.value;
  }
  return found;
}

/** Page scope: the attribute rides <html>. */
function pageScope(selector, theme) {
  const attr = `html[data-theme="${theme}"]`;
  if (selector === ":root" || selector === "html") return attr;
  return attr + " " + selector;
}

/** Overlay scope: the attribute rides the card (#gt-cc-overlay) or the badge row. */
function overlayScope(selector, theme) {
  const attr = `[data-theme="${theme}"]`;
  const m = /^(#gt-cc-overlay(?:\.[\w-]+)*|\.gt-cc-badge-row)(.*)$/.exec(selector);
  if (m) return m[1] + attr + m[2];
  return "#gt-cc-overlay" + attr + " " + selector;
}

/**
 * The forced-theme sheet for `css`. `scope(selector, theme)` decides where the
 * attribute lives. Every dark rule becomes a forced-dark rule; every property
 * a dark rule sets becomes a forced-light rule carrying the base sheet's value
 * for that selector, or `unset` when the base never set it (which is what the
 * base rendered as).
 */
function forcedThemeCss(css, scope) {
  const { base, dark } = parse(css);
  const lines = [];
  lines.push(`/* forced dark: the media block's rules under [data-theme="dark"] */`);
  for (const r of dark) {
    const sels = selectorsOf(r).map((s) => scope(s, "dark")).join(",\n");
    lines.push(`${sels} {`);
    for (const d of r.decls) lines.push(`  ${d.prop}: ${d.value};`);
    lines.push("}");
  }
  lines.push("");
  lines.push(`/* forced light: the base values back, under [data-theme="light"], for every property the dark block touches */`);
  for (const r of dark) {
    for (const sel of selectorsOf(r)) {
      const decls = [];
      for (const d of r.decls) {
        const v = baseValue(base, sel, d.prop);
        decls.push(`  ${d.prop}: ${v === null ? "unset" : v};`);
      }
      if (!decls.length) continue;
      lines.push(`${scope(sel, "light")} {`);
      lines.push(...decls);
      lines.push("}");
    }
  }
  return lines.join("\n") + "\n";
}

const HEADER = (src) => `/* GENERATED FILE — DO NOT EDIT.
 *
 * Source:      ${src} (its prefers-color-scheme: dark block)
 * Regenerate:  node scripts/gen-extension-theme-css.mjs
 * Guarded by:  extension-unified/test/theme-css.test.cjs (fails the build on drift)
 *
 * US-3055: the theme preference (System / Light / Dark). The OS theme still
 * comes from the media block in the source sheet; these rules apply the same
 * dark set under html[data-theme="dark"] and put the light set back under
 * html[data-theme="light"], so the preference wins over the OS either way. */

`;

const TARGETS = [
  { css: "extension-unified/popup.css", out: "extension-unified/popup-theme.css" },
  { css: "extension-unified/compare.css", out: "extension-unified/compare-theme.css" },
];

function expectedSheet(target, repoRoot) {
  const base = repoRoot || REPO_ROOT;
  const css = fs.readFileSync(path.resolve(base, target.css), "utf8");
  return HEADER(target.css) + forcedThemeCss(css, pageScope);
}

function drift(repoRoot) {
  const base = repoRoot || REPO_ROOT;
  const stale = [];
  for (const t of TARGETS) {
    let have = null;
    try { have = fs.readFileSync(path.resolve(base, t.out), "utf8"); } catch (_e) { have = null; }
    const want = expectedSheet(t, base);
    if (have === null || have.replace(/\r\n/g, "\n") !== want.replace(/\r\n/g, "\n")) stale.push(t.out);
  }
  return stale;
}

function generate(repoRoot) {
  const base = repoRoot || REPO_ROOT;
  for (const t of TARGETS) fs.writeFileSync(path.resolve(base, t.out), expectedSheet(t, base), "utf8");
  return TARGETS.map((t) => t.out);
}

module.exports = { parse, splitDecls, forcedThemeCss, pageScope, overlayScope, baseValue, TARGETS, expectedSheet, drift, generate };
