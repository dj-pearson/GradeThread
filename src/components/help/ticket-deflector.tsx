import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { edgeApiUrl } from "@/lib/edge-api";
import { useHelpReaderArticle, useHelpReaderSearch } from "@/hooks/use-help-center";

// US-2585: the answer offered before the ticket is written.
//
// Every ticket a good article answers is a ticket somebody has to answer twice,
// and deflection rate is the number that proves the help centre is worth
// maintaining. It sits ABOVE the submit button because a suggestion below it is
// a suggestion nobody reads.
//
// It searches /api/help, so a signed-in customer's members-only articles are
// eligible too — this only ever renders on an authenticated surface.
//
// The parent owns nothing but a callback: which articles were shown, and which
// one was opened, so the ticket row can carry them (US-2585 AC2).

const SUGGESTION_LIMIT = 3;
const DEBOUNCE_MS = 350;

interface TicketDeflectorProps {
  /** The subject line as it is being typed. */
  subject: string;
  /** Reports the shown slugs and the opened one, for the ticket row. */
  onSuggestions?: (state: { shown: string[]; opened: string | null }) => void;
}

export function TicketDeflector({ subject, onSuggestions }: TicketDeflectorProps) {
  const [debounced, setDebounced] = useState("");
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // Debounced so a search does not fire on every keystroke of a subject line.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(subject.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [subject]);

  const { data } = useHelpReaderSearch(debounced);
  const hits = (data?.hits ?? []).slice(0, SUGGESTION_LIMIT);
  const shown = hits.map((h) => h.slug);

  // Report upward. Keyed on the joined slug list so it fires on a real change
  // rather than on every render.
  const shownKey = shown.join(",");
  const reportRef = useRef(onSuggestions);
  reportRef.current = onSuggestions;
  useEffect(() => {
    reportRef.current?.({ shown: shownKey ? shownKey.split(",") : [], opened });
  }, [shownKey, opened]);

  // The deflection itself: they read something and did not submit. Sent on
  // page-hide with sendBeacon, because by the time we know they are not going
  // to submit, the page is already going away and a fetch would be cancelled.
  const beaconRef = useRef<{ subject: string; shown: string[]; opened: string | null }>({
    subject: "",
    shown: [],
    opened: null,
  });
  beaconRef.current = { subject: debounced, shown, opened };

  useEffect(() => {
    const send = () => {
      const s = beaconRef.current;
      if (!s.opened) return;
      const payload = JSON.stringify({
        subject: s.subject,
        articles_shown: s.shown,
        article_opened: s.opened,
      });
      navigator.sendBeacon?.(
        `${edgeApiUrl()}/api/help/deflected`,
        new Blob([payload], { type: "application/json" }),
      );
    };
    // visibilitychange, not unload: unload is unreliable on mobile Safari and
    // is ignored entirely when the tab is discarded from the background.
    const onHide = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  if (hits.length === 0) return null;

  return (
    <div className="space-y-2 rounded-lg bg-muted/50 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <LifeBuoy className="h-4 w-4" aria-hidden="true" />
        This might already be answered
      </p>
      <ul className="space-y-1">
        {hits.map((h) => (
          <li key={h.slug}>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-left"
              onClick={() => {
                setOpenSlug(h.slug);
                setOpened(h.slug);
              }}
            >
              {h.title}
            </Button>
            {h.summary && (
              <p className="text-sm text-muted-foreground">{h.summary}</p>
            )}
          </li>
        ))}
      </ul>

      <Sheet open={Boolean(openSlug)} onOpenChange={(o) => !o && setOpenSlug(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {openSlug && <DeflectorArticle slug={openSlug} onClose={() => setOpenSlug(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DeflectorArticle({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data } = useHelpReaderArticle(slug);
  const article = data?.article;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{article?.title ?? "Loading…"}</SheetTitle>
        {article?.summary && <SheetDescription>{article.summary}</SheetDescription>}
      </SheetHeader>
      {article && (
        <div
          className="prose prose-slate mt-6 max-w-none text-sm dark:prose-invert"
          // Server-authored article body from the admin editor, sanitised at
          // write time. Never user-submitted.
          dangerouslySetInnerHTML={{ __html: article.body_html }}
        />
      )}
      <p className="mt-8 text-sm text-muted-foreground">
        {article && (
          <>
            <Link
              to={`/dashboard/help/${article.slug}`}
              className="underline"
              onClick={onClose}
            >
              Open the full article
            </Link>
            {" · "}
          </>
        )}
        Still stuck? Close this and send the ticket.
      </p>
    </>
  );
}
