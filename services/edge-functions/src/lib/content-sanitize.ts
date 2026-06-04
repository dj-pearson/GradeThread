// Allowlist HTML sanitizer for blog body_html at publish time (US-353).
//
// The HTML comes from our own AI generator (Sonnet, with explicit
// "no <script>, no inline handlers" prompt rules), but it is published to the
// marketing domain, so a single regex bypass would become stored XSS. This is
// therefore a real PARSER-BASED pipeline, not a regex pass: a small HTML5-ish
// tokenizer produces a token stream (start/end tag, text, comment), and a
// serializer re-emits ONLY allowlisted tags/attributes, auto-balances the tree,
// and HTML-escapes all text. We tokenize instead of pulling jsdom/DOMPurify so
// the module stays dependency-free in the Deno runtime.
//
// Why a tokenizer beats the old regex walker:
//   - RAWTEXT elements (script/style/textarea/noscript/...) are consumed in a
//     raw state and dropped wholesale, so the classic mutation bypasses
//     (`<scri<script>pt>`, `<svg><style><img onerror=…>`, broken-nested tags)
//     can't reconstitute an executable tag after a naive .replace().
//   - Attribute values are parsed with quote tracking, so a `>` inside an
//     attribute can't prematurely "close" a tag and smuggle markup.
//   - The output tree is balanced (stray/unbalanced end tags dropped, open
//     tags auto-closed at EOF), removing the foothold for parser-differential
//     mXSS between our sanitizer and the browser.
//
// Allowlist:
//   - Block: h1-h6, p, ul, ol, li, blockquote, pre, hr, table, thead,
//            tbody, tfoot, tr, th, td, caption, figure, figcaption
//   - Inline: a, em, i, strong, b, u, code, br, sup, sub, span (class only)
//   - Media:  img (src/alt/width/height/loading), iframe (YouTube embeds only)
//
// Stripped:
//   - <script>, <style>, <object>, <embed>, <link>, <meta>, <base>,
//     <form>, <input>, <button>, <textarea>, <select>, <noscript>,
//     <svg>, and every other non-allowlisted element
//   - All on* event-handler attributes; style attributes (no inline CSS)
//   - href/src starting with javascript:/vbscript:/data: (except data:image/*
//     on <img>); iframe src not from youtube.com / youtube-nocookie.com
//
// The RENDER side (functions/_shared/blog-render.ts on Cloudflare Pages) emits
// this already-sanitized HTML and inherits the enforcing CSP from
// public/_headers (script-src has no 'unsafe-inline'; object-src 'none'), so
// publish-time sanitization here is the single gate for stored markup.

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li", "blockquote", "pre", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "figure", "figcaption",
  "a", "em", "i", "strong", "b", "u", "code", "br", "sup", "sub", "span",
  "img", "iframe",
]);

// Attributes per tag. Anything not listed is dropped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  iframe: new Set([
    "src", "width", "height", "title",
    "allow", "allowfullscreen", "frameborder", "loading",
  ]),
  th: new Set(["scope", "colspan", "rowspan"]),
  td: new Set(["colspan", "rowspan"]),
  span: new Set(["class"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
  blockquote: new Set(["cite"]),
};

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

// Whether a tag is void (self-closing) in HTML5 — never pushed on the open
// stack and never expects an end tag.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// RAWTEXT / escapable-rawtext / "drop everything inside" elements. Their text
// content is NOT parsed as HTML by a browser, which is exactly how mutation
// bypasses hide markup. The tokenizer consumes their content in a raw state up
// to the matching close tag and drops the whole element (none are on the
// allowlist, so nothing is emitted).
const RAWTEXT_TAGS = new Set([
  "script", "style", "textarea", "title", "noscript", "noembed", "noframes",
  "xmp", "plaintext", "iframe",
]);

function isSafeHref(value: string, tag: string, attr: string): boolean {
  // Strip ASCII whitespace/control chars that browsers ignore inside a scheme
  // (e.g. "java\tscript:") before classifying.
  // deno-lint-ignore no-control-regex
  const v = value.replace(/[\x00-\x20]+/g, "").toLowerCase();
  if (!v) return false;
  if (v.startsWith("javascript:")) return false;
  if (v.startsWith("vbscript:")) return false;
  // Allow data:image/* on <img src> only.
  if (v.startsWith("data:")) {
    return tag === "img" && attr === "src" && v.startsWith("data:image/");
  }
  return true;
}

function isAllowedIframeSrc(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return false;
    return YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── Text + attribute escaping ──────────────────────────────────────────────

// Matches the BODY of a character reference (after the leading `&`), sticky so
// it only matches at lastIndex. We advance lastIndex past the `&` before
// testing, so the pattern intentionally omits the leading `&`.
const ENTITY_RE = /(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y;

// Escape a text node for safe HTML output. Existing valid entities are
// preserved (not double-escaped); bare &, <, > are neutralized.
function escapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "&") {
      ENTITY_RE.lastIndex = i + 1;
      if (ENTITY_RE.test(s)) {
        out += "&";
      } else {
        out += "&amp;";
      }
    } else if (ch === "<") {
      out += "&lt;";
    } else if (ch === ">") {
      out += "&gt;";
    } else {
      out += ch;
    }
  }
  return out;
}

function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type Token =
  | { kind: "text"; value: string }
  | { kind: "start"; name: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { kind: "end"; name: string };

const TAG_NAME_RE = /[a-zA-Z][a-zA-Z0-9]*/y;
const ATTR_RE = /\s*([^\s/>=][^\s/>=]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'<>`]*)))?/y;

// Read attributes starting at index i (just after the tag name). Returns the
// parsed pairs and the index of the character that ended the tag scan (the
// position of '>' or end-of-input), plus whether it was self-closing.
function readAttrs(
  src: string,
  i: number,
): { attrs: Array<[string, string]>; next: number; selfClosing: boolean } {
  const attrs: Array<[string, string]> = [];
  let selfClosing = false;
  while (i < src.length) {
    // Skip leading whitespace.
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === ">") {
      i++;
      break;
    }
    if (src[i] === "/" && src[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }
    if (src[i] === "/") {
      i++;
      continue;
    }
    ATTR_RE.lastIndex = i;
    const m = ATTR_RE.exec(src);
    if (!m || m.index !== i || m[0].length === 0) {
      // Couldn't parse an attribute here — advance one char to avoid a loop.
      i++;
      continue;
    }
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    attrs.push([name, value]);
    i = ATTR_RE.lastIndex;
  }
  return { attrs, next: i, selfClosing };
}

// Consume a RAWTEXT element's content from index i (just after its '>') up to
// and including the matching `</name>` (case-insensitive). Returns the index
// after the close tag. The content is discarded.
function consumeRawText(src: string, i: number, name: string): number {
  const lower = src.toLowerCase();
  const close = "</" + name;
  let from = i;
  while (true) {
    const idx = lower.indexOf(close, from);
    if (idx === -1) return src.length; // unterminated → swallow to EOF
    // Ensure the char after the name is a tag terminator (>, whitespace, /).
    const after = src[idx + close.length];
    if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) {
      // Skip to the '>' that ends this close tag.
      const gt = src.indexOf(">", idx);
      return gt === -1 ? src.length : gt + 1;
    }
    from = idx + close.length;
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) {
      tokens.push({ kind: "text", value: src.slice(textStart, end) });
    }
  };

  while (i < src.length) {
    if (src[i] !== "<") {
      i++;
      continue;
    }
    const next = src[i + 1];

    // `<` not starting a tag/comment → literal text.
    if (next === undefined || (!/[a-zA-Z]/.test(next) && next !== "/" && next !== "!")) {
      i++;
      continue;
    }

    flushText(i);

    // Comment / CDATA / doctype — drop.
    if (next === "!") {
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        i = end === -1 ? src.length : end + 3;
      } else {
        const end = src.indexOf(">", i);
        i = end === -1 ? src.length : end + 1;
      }
      textStart = i;
      continue;
    }

    // End tag.
    if (next === "/") {
      TAG_NAME_RE.lastIndex = i + 2;
      const nm = TAG_NAME_RE.exec(src);
      if (!nm || nm.index !== i + 2) {
        // `</` not followed by a name → bogus comment, drop to '>'.
        const end = src.indexOf(">", i);
        i = end === -1 ? src.length : end + 1;
        textStart = i;
        continue;
      }
      const name = nm[0].toLowerCase();
      const end = src.indexOf(">", TAG_NAME_RE.lastIndex);
      i = end === -1 ? src.length : end + 1;
      textStart = i;
      tokens.push({ kind: "end", name });
      continue;
    }

    // Start tag.
    TAG_NAME_RE.lastIndex = i + 1;
    const tm = TAG_NAME_RE.exec(src);
    if (!tm || tm.index !== i + 1) {
      i++; // shouldn't happen given the guard above
      continue;
    }
    const name = tm[0].toLowerCase();
    const { attrs, next: afterTag, selfClosing } = readAttrs(src, TAG_NAME_RE.lastIndex);
    tokens.push({ kind: "start", name, attrs, selfClosing });
    i = afterTag;

    // RAWTEXT element: consume + drop its content and matching close tag so
    // hidden markup can never be reconstituted by a later pass / the browser.
    if (RAWTEXT_TAGS.has(name) && !selfClosing) {
      i = consumeRawText(src, i, name);
    }
    textStart = i;
  }
  flushText(src.length);
  return tokens;
}

// ── Attribute filtering / serialization ─────────────────────────────────────

function rebuildAttrs(tag: string, attrs: Array<[string, string]>): string {
  const allowed = ALLOWED_ATTRS[tag];
  const parts: string[] = [];
  for (const [name, value] of attrs) {
    if (name.startsWith("on")) continue; // event handlers
    if (name === "style") continue; // inline CSS
    if (!allowed || !allowed.has(name)) continue;

    if ((name === "href" && tag === "a") || (name === "src" && tag === "img")) {
      if (!isSafeHref(value, tag, name)) continue;
    }
    if (tag === "iframe" && name === "src") {
      if (!isAllowedIframeSrc(value)) continue;
    }
    if (tag === "a" && name === "target" && value === "_blank") {
      parts.push('target="_blank"');
      continue;
    }
    parts.push(`${name}="${escapeAttr(value)}"`);
  }
  if (tag === "a") {
    const hasTargetBlank = parts.some((p) => p === 'target="_blank"');
    const hasRel = parts.some((p) => p.startsWith('rel="'));
    if (hasTargetBlank && !hasRel) parts.push('rel="noopener noreferrer"');
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const tokens = tokenize(html);
  const out: string[] = [];
  const openStack: string[] = []; // allowlisted, currently-open block/inline tags

  for (const t of tokens) {
    if (t.kind === "text") {
      out.push(escapeText(t.value));
      continue;
    }
    if (t.kind === "start") {
      const tag = t.name;
      if (!ALLOWED_TAGS.has(tag)) continue; // drop unknown tag, keep its text flow

      if (tag === "iframe") {
        const src = t.attrs.find(([n]) => n === "src")?.[1];
        if (!src || !isAllowedIframeSrc(src)) continue; // drop unsafe iframe entirely
      }

      const rebuilt = rebuildAttrs(tag, t.attrs);
      if (VOID_TAGS.has(tag)) {
        out.push(`<${tag}${rebuilt} />`);
      } else if (tag === "iframe" && t.selfClosing) {
        // A self-closing iframe still needs a close tag in HTML.
        out.push(`<iframe${rebuilt}></iframe>`);
      } else {
        out.push(`<${tag}${rebuilt}>`);
        openStack.push(tag);
      }
      continue;
    }
    // end tag
    const tag = t.name;
    if (!ALLOWED_TAGS.has(tag) || VOID_TAGS.has(tag)) continue;
    const idx = openStack.lastIndexOf(tag);
    if (idx === -1) continue; // stray end tag → drop
    // Close everything opened after the matched tag (auto-balance), then it.
    for (let k = openStack.length - 1; k >= idx; k--) {
      out.push(`</${openStack[k]}>`);
    }
    openStack.length = idx;
  }

  // Close any tags still open at EOF.
  for (let k = openStack.length - 1; k >= 0; k--) {
    out.push(`</${openStack[k]}>`);
  }

  return out.join("");
}
