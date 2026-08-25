import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, BookOpen } from "lucide-react";
import { SEO } from "@/components/seo";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { termsAlphabetical } from "@/lib/product-terms";

// US-2864: every word GradeThread invented, in one place, in plain English.
//
// The public glossary at /grading/glossary covers GRADING vocabulary -- pilling,
// crocking, hand -- and none of the product's own nouns. A signed-in user who
// wants to know what a Comp or a Passport or Thrift Radar is had nowhere to
// look except the marketing pages they stopped visiting after signup.
//
// Same source as the <Term> popovers, so a definition can never be right in one
// place and stale in the other.
export function GlossaryPage() {
  const [query, setQuery] = useState("");
  const all = useMemo(() => termsAlphabetical(), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q) ||
        (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  }, [all, query]);

  return (
    <div className="space-y-6">
      <SEO title="Glossary" noindex />
      <PageHeader
        icon={BookOpen}
        title="Glossary"
        subtitle="Every word GradeThread made up, in one sentence each."
      />

      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="glossary-search">Search terms</Label>
        <Input
          id="glossary-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Comp, Passport, AutoLister…"
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No term matches that"
          description="Try a shorter word, or clear the search to see all of them."
          secondaryAction={{ label: "Clear search", onClick: () => setQuery("") }}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((t) => (
            <Card key={t.term}>
              <CardContent className="space-y-2 py-4">
                <p className="font-semibold">{t.term}</p>
                <p className="text-sm text-muted-foreground">{t.definition}</p>
                {t.to && (
                  <Link
                    to={t.to}
                    className="inline-flex items-center text-xs font-medium text-primary hover:underline"
                  >
                    Open it
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Looking for words about the condition of a garment instead?{" "}
        <Link to="/grading/glossary" className="underline">
          The grading glossary
        </Link>{" "}
        covers pilling, crocking, hand and the rest.
      </p>
    </div>
  );
}
