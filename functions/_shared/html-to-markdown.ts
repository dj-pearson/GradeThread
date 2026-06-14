// HTML → Markdown for the clean per-post Markdown endpoint (US-877).
//
// AI answer engines (ChatGPT, Claude, Perplexity, Google AI) ingest plain
// Markdown far more cleanly than a full SSR HTML page. This module renders a
// published post's already-sanitized `body_html` as faithful Markdown, plus a
// `buildPostMarkdown()` wrapper that frames the body with title, byline,
// updated date, key takeaways, FAQs, and a canonical link back.
//
// The input `body_html` was allowlist-sanitized at publish time
// (services/edge-functions/src/lib/content-sanitize.ts), so only a known,
// balanced tag set ever reaches here — h1-h6, p, ul/ol/li, blockquote, pre,
// hr, table (+ thead/tbody/tr/th/td/caption), figure/figcaption, a, em/i,
// strong/b, u, code, br, sup/sub, span, img, iframe. We therefore don't need a
// full HTML5 parser; a small tokenizer + tree walk covers the allowlist.
//
// Pure (no Cloudflare globals) so it's unit-testable from the Vite/Vitest side.

import type { BlogFaq, PublicPost } from "./blog-render";

// ── Entity decoding ─────────────────────────────────────────────────────────
// Markdown is plain text, so character references in the HTML must be decoded
// back to their literal characters (the SSR HTML path keeps them encoded).

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsaquo: "›",
  lsaquo: "‹",
  rarr: "→",
  larr: "←",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

// ── Tiny tokenizer → tree ───────────────────────────────────────────────────

interface ElNode {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface TextNode {
  type: "text";
  value: string;
}
type Node = ElNode | TextNode;

const VOID_TAGS = new Set(["br", "hr", "img", "iframe"]);

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const ATTR_RE = /([^\s/>=]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    if (!m[1]) continue;
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Build a DOM-lite tree from sanitized HTML. Unknown/unbalanced tags degrade
 *  gracefully (stray end tags ignored; open tags closed at EOF). */
function parse(html: string): Node[] {
  const root: ElNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElNode[] = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  const pushText = (text: string) => {
    if (!text) return;
    stack[stack.length - 1]!.children.push({ type: "text", value: decodeEntities(text) });
  };

  while ((m = TAG_RE.exec(html))) {
    pushText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const isEnd = m[0]![1] === "/";
    const tag = m[1]!.toLowerCase();
    if (isEnd) {
      // Close back to the nearest matching open tag (auto-balance).
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el: ElNode = { type: "element", tag, attrs: parseAttrs(m[2] ?? ""), children: [] };
    stack[stack.length - 1]!.children.push(el);
    const selfClosing = m[0]!.endsWith("/>");
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(el);
  }
  pushText(html.slice(last));
  return root.children;
}

// ── Inline rendering ─────────────────────────────────────────────────────────

const isElement = (n: Node): n is ElNode => n.type === "element";

function inlineText(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.value;
      return inlineText(n.children);
    })
    .join("");
}

function renderInline(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      // Collapse runs of whitespace (incl. newlines) to single spaces — Markdown
      // treats a single newline inside a paragraph as a space anyway, and the
      // source HTML may be pretty-printed.
      out += n.value.replace(/\s+/g, " ");
      continue;
    }
    const inner = () => renderInline(n.children).trim();
    switch (n.tag) {
      case "br":
        out += "  \n";
        break;
      case "strong":
      case "b": {
        const t = inner();
        out += t ? `**${t}**` : "";
        break;
      }
      case "em":
      case "i": {
        const t = inner();
        out += t ? `*${t}*` : "";
        break;
      }
      case "code": {
        const t = inlineText(n.children);
        out += t ? `\`${t}\`` : "";
        break;
      }
      case "a": {
        const t = inner() || n.attrs.href || "";
        const href = (n.attrs.href ?? "").trim();
        out += href ? `[${t}](${href})` : t;
        break;
      }
      case "img": {
        const alt = (n.attrs.alt ?? "").trim();
        const src = (n.attrs.src ?? "").trim();
        if (src) out += `![${alt}](${src})`;
        break;
      }
      default:
        // u, sup, sub, span and anything else → keep the text, drop the markup.
        out += renderInline(n.children);
    }
  }
  return out;
}

// ── Block rendering ──────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li", "blockquote", "pre", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "figure", "figcaption", "div",
]);

function renderList(el: ElNode, ordered: boolean, indent: string): string {
  const lines: string[] = [];
  let n = 1;
  for (const child of el.children) {
    if (!isElement(child) || child.tag !== "li") continue;
    const marker = ordered ? `${n}. ` : "- ";
    // Split the <li> into its inline lead and any nested lists.
    const nested: ElNode[] = [];
    const lead: Node[] = [];
    for (const c of child.children) {
      if (isElement(c) && (c.tag === "ul" || c.tag === "ol")) nested.push(c);
      else lead.push(c);
    }
    const text = renderInline(lead).trim() || renderBlocks(lead, indent).trim();
    lines.push(`${indent}${marker}${text}`);
    const childIndent = indent + (ordered ? "   " : "  ");
    for (const sub of nested) {
      lines.push(renderList(sub, sub.tag === "ol", childIndent));
    }
    n++;
  }
  return lines.join("\n");
}

function renderTable(el: ElNode): string {
  const rows: string[][] = [];
  let headerRows = 0;
  const walk = (node: ElNode, inHead: boolean) => {
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (c.tag === "thead") walk(c, true);
      else if (c.tag === "tbody" || c.tag === "tfoot") walk(c, false);
      else if (c.tag === "tr") {
        const cells: string[] = [];
        let isHeaderRow = inHead;
        for (const cell of c.children) {
          if (isElement(cell) && (cell.tag === "td" || cell.tag === "th")) {
            if (cell.tag === "th") isHeaderRow = isHeaderRow || inHead;
            cells.push(renderInline(cell.children).trim().replace(/\|/g, "\\|"));
          }
        }
        if (cells.length) {
          rows.push(cells);
          if (inHead) headerRows++;
        }
      }
    }
  };
  walk(el, false);
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };
  // If no explicit thead, treat the first row as the header (GFM needs one).
  const headerCount = headerRows > 0 ? headerRows : 1;
  const out: string[] = [];
  const header = rows.slice(0, headerCount);
  const body = rows.slice(headerCount);
  out.push(pad(header[header.length - 1] ?? rows[0]!));
  out.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
  for (const r of body) out.push(pad(r));
  return out.join("\n");
}

function renderBlock(el: ElNode, indent: string): string {
  switch (el.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(el.tag[1]);
      return `${"#".repeat(level)} ${renderInline(el.children).trim()}`;
    }
    case "p":
      return renderInline(el.children).trim();
    case "hr":
      return "---";
    case "ul":
      return renderList(el, false, indent);
    case "ol":
      return renderList(el, true, indent);
    case "blockquote": {
      const inner = renderBlocks(el.children, "").trim();
      return inner
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    }
    case "pre": {
      const text = inlineText(el.children).replace(/\n+$/, "");
      return "```\n" + text + "\n```";
    }
    case "table":
      return renderTable(el);
    case "figure": {
      const parts: string[] = [];
      for (const c of el.children) {
        if (!isElement(c)) continue;
        if (c.tag === "figcaption") {
          const cap = renderInline(c.children).trim();
          if (cap) parts.push(`*${cap}*`);
        } else {
          const b = renderBlock(c, indent) || renderInline([c]).trim();
          if (b) parts.push(b);
        }
      }
      return parts.join("\n\n");
    }
    case "figcaption": {
      const cap = renderInline(el.children).trim();
      return cap ? `*${cap}*` : "";
    }
    case "div":
      return renderBlocks(el.children, indent).trim();
    default:
      // Unknown block — render children; falls through to inline for inline tags.
      return renderBlocks(el.children, indent).trim();
  }
}

function renderBlocks(nodes: Node[], indent: string): string {
  const blocks: string[] = [];
  let inlineRun: Node[] = [];
  const flushInline = () => {
    if (inlineRun.length === 0) return;
    const text = renderInline(inlineRun).trim();
    inlineRun = [];
    if (text) blocks.push(text);
  };
  for (const n of nodes) {
    if (isElement(n) && (BLOCK_TAGS.has(n.tag) || n.tag === "img")) {
      flushInline();
      if (n.tag === "img") {
        const md = renderInline([n]).trim();
        if (md) blocks.push(md);
      } else {
        const b = renderBlock(n, indent);
        if (b.trim()) blocks.push(b);
      }
    } else {
      inlineRun.push(n);
    }
  }
  flushInline();
  return blocks.join("\n\n");
}

/** Convert sanitized body HTML to Markdown. */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  const tree = parse(html);
  return renderBlocks(tree, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Full post document ───────────────────────────────────────────────────────

/** Human date (UTC), e.g. "March 5, 2026"; falls back to the raw ISO string. */
function formatDateUTC(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function faqMarkdown(faqs: BlogFaq[] | undefined | null): string {
  const clean = (faqs ?? []).filter((f) => f?.q?.trim() && f?.a?.trim());
  if (clean.length === 0) return "";
  const lines = ["## Frequently asked questions", ""];
  for (const f of clean) {
    lines.push(`### ${f.q.trim()}`, "", f.a.trim(), "");
  }
  return lines.join("\n").trim();
}

/**
 * Render a published post as a single clean Markdown document for AI ingestion:
 * H1 title, byline + dates, key takeaways, the body as Markdown, FAQs, and a
 * canonical link back to the HTML article. `siteUrl` is the absolute origin
 * (no trailing slash), e.g. https://gradethread.com.
 */
export function buildPostMarkdown(post: PublicPost, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  const canonical = `${base}/blog/${post.slug}`;
  const out: string[] = [];

  out.push(`# ${post.title.trim()}`);

  const author =
    post.author_entity?.name?.trim() || post.author?.trim() || "GradeThread Team";
  const metaBits: string[] = [`By ${author}`];
  const published = formatDateUTC(post.published_at);
  if (published) metaBits.push(`Published ${published}`);
  const updatedDiffers =
    post.updated_at && post.published_at &&
    post.updated_at.slice(0, 10) > post.published_at.slice(0, 10);
  if (updatedDiffers) metaBits.push(`Updated ${formatDateUTC(post.updated_at)}`);
  out.push(`_${metaBits.join(" · ")}_`);

  if (post.excerpt?.trim()) out.push(`> ${post.excerpt.trim()}`);

  const takeaways = (post.key_takeaways ?? []).map((t) => t.trim()).filter(Boolean);
  if (takeaways.length) {
    out.push(["## Key takeaways", "", ...takeaways.map((t) => `- ${t}`)].join("\n"));
  }

  const body = htmlToMarkdown(post.body_html);
  if (body) out.push(body);

  const faq = faqMarkdown(post.faqs);
  if (faq) out.push(faq);

  out.push("---");
  out.push(`Canonical: [${canonical}](${canonical})`);

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
