import { Link, useLocation } from "react-router";
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
import { useHelpReaderArticle, useHelpReaderIndex } from "@/hooks/use-help-center";
import { helpHrefFrom } from "@/lib/surfaces";
import type { ProductHelpSlugKey } from "@/lib/help-slugs";
import { track } from "@/lib/analytics";
import { HelpArticleBody } from "@/components/help/help-article-body";
import { inAppHelpPath } from "@/lib/help/paths";

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
// Whether a surface HAS an article is read from the reader index (one cached
// GET that the Help page shares), not from an eager fetch of every article on
// every screen. The body is fetched only when the sheet opens.
//
// A slug with no article yet renders a plain Help link instead of nothing: it
// opens /dashboard/help?from=<this surface>, which leads with this screen's
// category. The screens with no article yet are the newest ones, which is
// exactly where somebody most needs a way in.

interface HelpLinkProps {
  /** Typed against PRODUCT_HELP_SLUGS, so a typo is a build error. */
  slug: ProductHelpSlugKey;
  /** Accessible name. Defaults to a generic one; pass something specific. */
  label?: string;
  className?: string;
}

export function HelpLink({ slug, label, className }: HelpLinkProps) {
  const [open, setOpen] = useState(false);
  const { pathname, search } = useLocation();
  const index = useHelpReaderIndex();
  const listed = index.data?.articles.find((a) => a.slug === slug);
  // Only once opened: a screen with a help button no longer costs a request.
  const { data, isLoading } = useHelpReaderArticle(slug, { enabled: open });
  const article = data?.article;

  if (!listed) {
    return (
      <Button asChild variant="ghost" size="icon" className={className}>
        <Link to={helpHrefFrom(pathname, search)} aria-label={label ?? "Help for this page"}>
          <HelpCircle className="h-4 w-4" />
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={className}
        aria-label={label ?? `Help: ${listed.title}`}
        onClick={() => {
          setOpen(true);
          // US-2592: which product surfaces send people looking for help is the
          // one thing this button can measure that a pageview cannot.
          track("help_contextual_open", { slug, category: listed.category_key });
        }}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{listed.title}</SheetTitle>
            {listed.summary && <SheetDescription>{listed.summary}</SheetDescription>}
          </SheetHeader>

          {isLoading || !article ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <HelpArticleBody
              html={article.body_html}
              className="mt-6 max-w-none text-sm"
              linkFor={inAppHelpPath}
            />
          )}

          {(article?.faq ?? []).length > 0 && (
            <section className="mt-8">
              <h3 className="text-sm font-semibold">Frequently asked</h3>
              <dl className="mt-3 space-y-3 text-sm">
                {(article?.faq ?? []).map((f, i) => (
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
              to={`/dashboard/help/${listed.slug}`}
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
