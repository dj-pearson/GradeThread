// Conservative HTML sanitizer for blog body_html at publish time.
//
// The HTML comes from our own AI generator (Sonnet, with explicit
// "no <script>, no inline handlers" prompt rules), not arbitrary user
// input. This pass is belt-and-suspenders: it strips known-bad
// constructs even if the model misbehaves, without pulling jsdom or
// DOMPurify into the Deno runtime.
//
// Allowlist:
//   - Block: h1-h6, p, ul, ol, li, blockquote, pre, hr, table, thead,
//            tbody, tr, th, td, figure, figcaption
//   - Inline: a, em, strong, code, br, sup, sub, span (class only)
//   - Media:  img (src/alt/width/height/loading), iframe (YouTube embeds only)
//
// Stripped:
//   - <script>, <style>, <object>, <embed>, <link>, <meta>, <base>,
//     <form>, <input>, <button>, <textarea>, <select>, <noscript>,
//     <svg> (we don't expect SVG from the generator; remove to be safe)
//   - All on* event handler attributes
//   - href/src starting with javascript: or data: (except data:image/* on <img>)
//   - style attributes (no inline CSS)
//   - <iframe> not from youtube.com / youtube-nocookie.com

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

function isSafeHref(value: string, tag: string, attr: string): boolean {
  const v = value.trim().toLowerCase();
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

// Strip an entire element (open tag, content, close tag) by name.
// Handles nested same-name elements minimally — fine for <script>/<style>/etc.
function stripElement(html: string, tag: string): string {
  const opener = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closer = new RegExp(`</${tag}\\s*>`, "gi");
  return html.replace(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi"),
    "",
  ).replace(opener, "").replace(closer, "");
}

// Parse attributes from an opening tag string. Supports
// foo="bar", foo='bar', and bare foo (= "").
function parseAttrs(tagInner: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagInner)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out.push([name, value]);
  }
  return out;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function rebuildAttrs(
  tag: string,
  attrs: Array<[string, string]>,
): string {
  const allowed = ALLOWED_ATTRS[tag];
  const parts: string[] = [];
  for (const [name, value] of attrs) {
    // Drop all event handlers regardless of tag.
    if (name.startsWith("on")) continue;
    // Drop inline style.
    if (name === "style") continue;
    if (!allowed || !allowed.has(name)) continue;

    if ((name === "href" && tag === "a") || (name === "src" && tag === "img")) {
      if (!isSafeHref(value, tag, name)) continue;
    }
    if (tag === "iframe" && name === "src") {
      if (!isAllowedIframeSrc(value)) continue;
    }
    // Force safe target/rel on outbound links.
    if (tag === "a" && name === "target" && value === "_blank") {
      parts.push('target="_blank"');
      continue;
    }
    parts.push(`${name}="${escapeAttr(value)}"`);
  }
  // For <a target="_blank">, add rel="noopener noreferrer" if not present.
  if (tag === "a") {
    const hasTargetBlank = parts.some((p) => p === 'target="_blank"');
    const hasRel = parts.some((p) => p.startsWith('rel="'));
    if (hasTargetBlank && !hasRel) {
      parts.push('rel="noopener noreferrer"');
    }
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

// Whether a tag is self-closing in HTML5.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function sanitizeHtml(html: string): string {
  if (!html) return "";
  let out = html;

  // 1. Strip dangerous elements entirely (tags + their content).
  for (const tag of [
    "script", "style", "object", "embed", "form", "input", "button",
    "textarea", "select", "noscript", "svg", "link", "meta", "base",
  ]) {
    out = stripElement(out, tag);
  }

  // 2. Strip HTML comments (defensive against <!-- conditional --> tricks).
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Walk tags and filter / rewrite attributes per allowlist.
  out = out.replace(
    /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (_full, closing, rawTag, attrsRaw) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return ""; // drop opening + closing of unknown tags
      if (closing) return `</${tag}>`;

      const attrs = parseAttrs(attrsRaw);
      // Iframes without a safe src after filtering get dropped entirely.
      if (tag === "iframe") {
        const src = attrs.find(([n]) => n === "src")?.[1];
        if (!src || !isAllowedIframeSrc(src)) return "";
      }
      const rebuilt = rebuildAttrs(tag, attrs);
      if (VOID_TAGS.has(tag)) return `<${tag}${rebuilt} />`;
      return `<${tag}${rebuilt}>`;
    },
  );

  return out;
}
