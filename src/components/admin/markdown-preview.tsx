import { createElement, Fragment, type ReactNode } from "react";

// Lightweight, dependency-free markdown preview for the support KB editor
// (US-840). It renders a useful SUBSET — headings, paragraphs, bold/italic,
// inline code, links, lists, blockquotes, code fences, horizontal rules — to
// real React elements (never dangerouslySetInnerHTML), so it is XSS-safe by
// construction: text becomes text nodes and only http(s)/mailto/relative link
// hrefs are honoured. It is a fidelity-best-effort PREVIEW, not a spec-complete
// CommonMark renderer; the assistant reads the raw markdown, not this HTML.

const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith("/")) return u;
  return null;
}

// Parse a single line of inline markdown into React nodes.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  let i = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const url = token.slice(split + 2, -1);
      const href = safeHref(url);
      nodes.push(
        href
          ? (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-navy underline underline-offset-2"
            >
              {label}
            </a>
          )
          : <Fragment key={key}>{token}</Fragment>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isUnorderedItem(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}
function isOrderedItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

export function MarkdownPreview({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block.
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-4 border-border" />);
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      const sizes = [
        "text-2xl font-bold",
        "text-xl font-bold",
        "text-lg font-semibold",
        "text-base font-semibold",
        "text-sm font-semibold",
        "text-sm font-medium",
      ];
      blocks.push(
        createElement(
          `h${level}`,
          { key: key++, className: `mt-4 mb-2 ${sizes[level - 1]}` },
          renderInline(text, `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Blockquote (consecutive '>' lines).
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 border-l-2 border-brand-navy/30 pl-3 text-muted-foreground"
        >
          {renderInline(buf.join(" "), `bq${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list.
    if (isUnorderedItem(line)) {
      const items: string[] = [];
      while (i < lines.length && isUnorderedItem(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-2 list-disc space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (isOrderedItem(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrderedItem(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-2 list-decimal space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-structural lines.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        l.trim() === "" ||
        l.trim().startsWith("```") ||
        /^(#{1,6})\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        isUnorderedItem(l) ||
        isOrderedItem(l) ||
        /^\s*([-*_])\1{2,}\s*$/.test(l)
      ) {
        break;
      }
      buf.push(l);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-2 leading-relaxed">
        {renderInline(buf.join(" "), `p${key}`)}
      </p>,
    );
  }

  if (blocks.length === 0) {
    return (
      <p className="text-sm italic text-muted-foreground">Nothing to preview.</p>
    );
  }
  return <div className="text-sm">{blocks}</div>;
}
