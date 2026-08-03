import { Link } from "react-router";
import { GLOSSARY_ENTRIES } from "@/lib/seo/glossary";

// Shared "explore the standard" cross-link block for the cornerstone pillar
// pages (US-855). Every cornerstone page renders this so each one links out to
// the glossary spokes, the Condition Index, and the transparency report —
// building the interlinked authority hub the epic calls for.
//
// /condition-index is served by an edge Pages Function (NOT a SPA route), so it
// uses a plain <a> for a real navigation; the in-app routes use <Link>.

const TIER_GLOSSARY = GLOSSARY_ENTRIES.filter((e) => e.kind === "tier");
const FACTOR_GLOSSARY = GLOSSARY_ENTRIES.filter((e) => e.kind === "factor");

const chip =
  "rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground";

export function CornerstoneLinks() {
  return (
    <section className="border-t bg-card px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-3xl font-bold">Explore the grading standard</h2>
        <p className="mt-3 text-muted-foreground">
          These pages build on one published standard. Start with{" "}
          <Link
            to="/condition-grading"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            what condition grading is
          </Link>{" "}
          and the{" "}
          <Link
            to="/grading-standard"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            methodology behind every grade
          </Link>
          , see the published accuracy on our{" "}
          <Link
            to="/transparency"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            transparency report
          </Link>
          , or look up resale value by condition in the{" "}
          <a
            href="/condition-index"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            Condition Index
          </a>{" "}
          and the{" "}
          <Link
            to="/whats-it-worth"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            What's It Worth tool
          </Link>
          .
        </p>

        <h3 className="mt-8 text-lg font-semibold">Grade tiers</h3>
        <div className="mt-3 flex flex-wrap gap-3">
          {TIER_GLOSSARY.map((e) => (
            <Link key={e.slug} to={e.path} className={chip}>
              {e.term}
            </Link>
          ))}
        </div>

        <h3 className="mt-8 text-lg font-semibold">Grading factors</h3>
        <div className="mt-3 flex flex-wrap gap-3">
          {FACTOR_GLOSSARY.map((e) => (
            <Link key={e.slug} to={e.path} className={chip}>
              {e.term}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
