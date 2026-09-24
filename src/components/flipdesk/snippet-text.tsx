import type { SnippetSegment } from "@/lib/flipdesk-search";

// A ts_headline snippet as React text. Highlighted words come back from the RPC
// wrapped in <mark>; parseSnippet splits them out and this renders every
// segment as a text child, never as HTML, so markup in a seller's own notes is
// shown rather than run. Shared by the Search page and the Cmd+K palette.
export function SnippetText({
  segments,
  className,
}: {
  segments: SnippetSegment[];
  className?: string;
}) {
  if (segments.length === 0) return null;
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark
            key={i}
            className="rounded-sm bg-brand-red/15 px-0.5 font-medium text-foreground dark:bg-brand-red/30"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}
