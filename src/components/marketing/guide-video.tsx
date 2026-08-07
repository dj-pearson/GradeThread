import { ExternalLink } from "lucide-react";
import {
  publishedShort,
  shortTitle,
  shortTranscript,
  shortEmbedUrl,
  shortWatchUrl,
} from "@/lib/seo/grading-videos";

// US-1689: the on-page embed for a garment guide's YouTube grading short.
//
// Renders NOTHING until the short has been filmed and its youtubeId set in
// grading-videos.ts — publishedShort() is the single gate, shared with the
// VideoObject markup in marketing-jsonld.ts. So the section and its structured
// data appear together or not at all.
//
// The transcript is rendered as visible page text, not just markup. That is
// deliberate on two counts: Google's structured-data policy requires marked-up
// content to be visible, and a transcript on the page is the surface AI answer
// engines actually read — the whole reason these shorts exist.

export function GuideVideo({ guideSlug }: { guideSlug: string }) {
  const short = publishedShort(guideSlug);
  if (!short) return null;

  const title = shortTitle(short);

  return (
    <section className="border-t px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-2xl font-bold sm:text-3xl">Watch: the 60-second version</h2>
        {/* 9:16 — these are vertical Shorts, so a 16:9 frame would letterbox
            them into a thin strip on mobile. Capped so it doesn't dominate. */}
        <div className="mt-6 flex justify-center">
          <div className="w-full max-w-xs overflow-hidden rounded-xl bg-brand-night">
            <iframe
              className="aspect-[9/16] w-full"
              src={shortEmbedUrl(short.youtubeId)}
              title={title}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        </div>

        <details className="mt-6 rounded-lg border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Read the transcript
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {shortTranscript(short)}
          </p>
        </details>

        <a
          href={shortWatchUrl(short.youtubeId)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-navy hover:underline dark:text-foreground"
        >
          Watch on YouTube
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </a>
      </div>
    </section>
  );
}
