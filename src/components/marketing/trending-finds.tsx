import { Link } from "react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FindCard } from "@/components/showcase/find-card";
import { useFinds } from "@/hooks/use-showcase";

// US-1855 AC3: trending finds on the landing page.
//
// Renders NOTHING until real finds arrive — no skeleton, no empty heading. Two
// reasons: this page is prerendered, so an empty-state heading would land in the
// static HTML directly under the section above it (a heading-outline skip a
// crawler reads as a broken page), and a "Trending finds" band with no finds in
// it is an advertisement for an empty feature.

export function TrendingFinds({ limit = 3 }: { limit?: number }) {
  const { data } = useFinds({
    sort: "trending",
    brandSlug: null,
    category: null,
    minGrade: null,
    limit,
  });
  const finds = data?.finds ?? [];
  if (finds.length === 0) return null;

  return (
    <section className="px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-sm font-semibold text-brand-navy dark:bg-white/10 dark:text-foreground">
            <Sparkles className="h-4 w-4" />
            Trending finds
          </span>
          <h2 className="text-3xl font-extrabold font-display">
            What sellers are grading right now
          </h2>
          <p className="max-w-2xl text-muted-foreground">
            Real pieces, independently condition-graded and published by the
            people who found them. Every card opens the full certificate.
          </p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {finds.slice(0, limit).map((f) => (
            <FindCard key={f.id} find={f} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <Button variant="outline" asChild>
            <Link to="/finds">Browse the Finds feed</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
