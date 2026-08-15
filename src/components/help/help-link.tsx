import { Link } from "react-router";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useHelpReaderArticle } from "@/hooks/use-help-center";
import type { ProductHelpSlugKey } from "@/lib/help-slugs";

// US-2584: the contextual help button.
//
// Documentation nobody can find from inside the product is documentation nobody
// reads, and the help somebody needs is almost always about the screen they are
// already looking at. So the answer opens in a side sheet, not a new tab: a new
// tab loses the half-filled form they were stuck in, which is the exact moment
// they went looking.
//
// It reads /api/help, so a members-only article is readable here by a signed-in
// customer. It is only rendered on authenticated surfaces.
//
// A slug with no article yet renders NOTHING — no button, no dead end. That is
// what lets the slug registry ship ahead of the writing: a half-written help
// centre degrades to the product it already was, rather than to a product full
// of question marks that open empty sheets.

interface HelpLinkProps {
  /** Typed against PRODUCT_HELP_SLUGS, so a typo is a build error. */
  slug: ProductHelpSlugKey;
  /** Accessible name. Defaults to a generic one; pass something specific. */
  label?: string;
  className?: string;
}

export function HelpLink({ slug, label, className }: HelpLinkProps) {
  const [open, setOpen] = useState(false);
  // Fetched eagerly so the button can hide itself before anybody clicks it.
  // One small authed GET per surface, cached by TanStack for the session.
  const { data, isLoading, isError } = useHelpReaderArticle(slug);
  const article = data?.article;

  // No article, or we could not tell: render nothing. A question mark that
  // opens an apology is worse than no question mark.
  if (isLoading || isError || !article) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={className}
        aria-label={label ?? `Help: ${article.title}`}
        onClick={() => setOpen(true)}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{article.title}</SheetTitle>
            {article.summary && <SheetDescription>{article.summary}</SheetDescription>}
          </SheetHeader>

          {isLoading ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div
              className="prose prose-slate mt-6 max-w-none text-sm dark:prose-invert"
              // Server-authored article body from the admin editor, sanitised at
              // write time. Never user-submitted.
              dangerouslySetInnerHTML={{ __html: article.body_html }}
            />
          )}

          {(article.faq ?? []).length > 0 && (
            <section className="mt-8">
              <h3 className="text-sm font-semibold">Frequently asked</h3>
              <dl className="mt-3 space-y-3 text-sm">
                {(article.faq ?? []).map((f, i) => (
                  <div key={i}>
                    <dt className="font-medium">{f.question}</dt>
                    <dd className="mt-1 text-muted-foreground">{f.answer}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <p className="mt-8 text-sm text-muted-foreground">
            <Link
              to={`/dashboard/help/${article.slug}`}
              className="underline"
              onClick={() => setOpen(false)}
            >
              Open the full article
            </Link>
            {" · "}
            <Link to="/dashboard/support" className="underline" onClick={() => setOpen(false)}>
              Open a support ticket
            </Link>
          </p>
        </SheetContent>
      </Sheet>
    </>
  );
}
