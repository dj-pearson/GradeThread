// US-3013: cut a stylesheet down to the rules a given page can actually use.
//
// WHY THIS EXISTS. `impeccable detect <url>` reads the page's STYLESHEET, not
// only its computed styles. Three of its rules - gradient-text, bounce-easing
// and dark-glow - fire on a utility DEFINITION whether or not anything uses it.
// Measured 2026-08-30: a page containing `<h1>Hello</h1>` and nothing else,
// with the app's built CSS inlined, reports all three. That is what sank the
// first attempt at this harness (US-2999): every authed page it rendered came
// back carrying findings that belonged to src/index.css.
//
// So the stylesheet handed to the scanner has to be the page's own. Not
// "Tailwind's output for the whole app" - that is already tree-shaken across
// every route and still contains every utility any route uses.
//
// THE RULE. A selector survives when every class it names is on the page. A
// selector that names no class at all (element, `:root`, `*`, `::selection`)
// survives, because those apply to any document. An at-rule survives when
// something inside it did.
//
// WHAT THIS IS NOT. It is not a general-purpose purger and must never be used
// to ship CSS. It ignores attribute selectors, `:has()` arguments and anything
// a class could be added by at runtime, because the page it feeds is static
// HTML that no script will ever touch.

/**
 * Class names present in a fragment of HTML.
 *
 * Reads the raw text rather than a DOM, because the input is server-rendered
 * markup with no script: what is in the string is what the browser will lay
 * out.
 */
export function classesIn(html) {
  const out = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  for (const m of html.matchAll(/class='([^']*)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

/**
 * The class names a selector requires.
 *
 * Tailwind escapes almost everything - `.md\:flex`, `.w-1\/2`, `.bg-\[\#fff\]` -
 * so the unescaping is the whole job. A backslash before any character means
 * "this character is literal".
 */
export function classesOf(selector) {
  const out = [];
  for (let i = 0; i < selector.length; i += 1) {
    if (selector[i] !== ".") continue;
    // A dot inside brackets is part of a value, not the start of a class.
    let name = "";
    let j = i + 1;
    for (; j < selector.length; j += 1) {
      const ch = selector[j];
      if (ch === "\\") {
        name += selector[j + 1] ?? "";
        j += 1;
        continue;
      }
      if (/[A-Za-z0-9_-]/.test(ch)) {
        name += ch;
        continue;
      }
      break;
    }
    if (name) out.push(name);
    i = j - 1;
  }
  return out;
}

/** Split a comma-separated selector list, respecting brackets and parens. */
function splitSelectors(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Top-level blocks of a stylesheet, as `{ prelude, body, isAtRule }`.
 *
 * A hand-rolled brace matcher rather than a CSS parser, because the only input
 * is Tailwind's own output and adding a parser dependency to a report-only
 * script is not worth it. Strings and comments are skipped so a `}` inside a
 * `content: "}"` cannot end a block early.
 */
function blocks(css) {
  const out = [];
  let i = 0;
  let prelude = "";
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      prelude += ch;
      i += 1;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\") {
          prelude += css[i] + (css[i + 1] ?? "");
          i += 2;
          continue;
        }
        prelude += css[i];
        i += 1;
      }
      prelude += quote;
      i += 1;
      continue;
    }
    if (ch === ";" && prelude.trim().startsWith("@")) {
      // A statement at-rule: @import, @charset, @layer a, b;
      out.push({ prelude: prelude.trim(), body: null, isAtRule: true });
      prelude = "";
      i += 1;
      continue;
    }
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < css.length && depth > 0) {
        const c = css[j];
        if (c === "/" && css[j + 1] === "*") {
          const end = css.indexOf("*/", j + 2);
          j = end === -1 ? css.length : end + 2;
          continue;
        }
        if (c === '"' || c === "'") {
          const quote = c;
          body += c;
          j += 1;
          while (j < css.length && css[j] !== quote) {
            if (css[j] === "\\") {
              body += css[j] + (css[j + 1] ?? "");
              j += 2;
              continue;
            }
            body += css[j];
            j += 1;
          }
          body += quote;
          j += 1;
          continue;
        }
        if (c === "{") depth += 1;
        if (c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += c;
        j += 1;
      }
      const head = prelude.trim();
      out.push({ prelude: head, body, isAtRule: head.startsWith("@") });
      prelude = "";
      i = j + 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return out;
}

/**
 * The subset of [css] whose selectors are satisfied by [used].
 *
 * @param {string} css
 * @param {Set<string>} used class names present on the page
 * @returns {string}
 */
export function narrowCss(css, used) {
  const keep = [];
  for (const block of blocks(css)) {
    if (block.body === null) {
      keep.push(`${block.prelude};`);
      continue;
    }
    if (block.isAtRule) {
      // @media / @supports / @layer wrap rules; @keyframes, @font-face,
      // @property and @theme hold declarations, not selectors, so they pass
      // through whole. Dropping a @keyframes an animation still names would
      // silence a rule rather than a false positive.
      const name = block.prelude.split(/[\s({]/)[0];
      if (
        ["@media", "@supports", "@layer", "@container", "@scope"].includes(name)
      ) {
        const inner = narrowCss(block.body, used);
        if (inner.trim()) keep.push(`${block.prelude} {${inner}}`);
        continue;
      }
      keep.push(`${block.prelude} {${block.body}}`);
      continue;
    }
    const selectors = splitSelectors(block.prelude).filter((sel) =>
      classesOf(sel).every((c) => used.has(c)),
    );
    if (selectors.length) keep.push(`${selectors.join(",")} {${block.body}}`);
  }
  return keep.join("\n");
}
