import { HelpLink } from "@/components/help/help-link";
import type { ProductHelpSlugKey } from "@/lib/help-slugs";

// US-2862. The one spelling for a surface's help button.
//
// PRODUCT_HELP_SLUGS registered ten surfaces, all of them places a user reaches
// after they already know what they are doing: billing, API keys, the team
// page, the composer. Every one of those ten had its button, so the wiring was
// never the gap. The gap was that the surfaces somebody gets stuck on in their
// first week -- intake, AutoLister, sourcing, pricing, returns, the money page
// -- had no entry in the registry at all, and therefore nothing HelpLink could
// render even once the articles exist.
//
// THE PLACEMENT RULE, which this component exists to hold: the help button
// belongs in the page header, right-aligned, as the FIRST item in the action
// row. Fifteen call sites do not converge on that by intention, so there is one
// component and one rule, and src/test/help-contextual-links.test.ts asserts
// that <HelpLink> is never spelled directly outside this file and help-link.tsx
// itself.
//
// (PageHeader lives under src/components/ui/, which is shadcn-generated and
// guarded against hand-editing, so the slug cannot become a PageHeader prop.
// Hence a wrapper passed through `actions` rather than a prop.)
//
// Renders NOTHING when the slug has no article yet. That is what lets the
// registry ship ahead of the writing (US-2618): a half-written help centre
// degrades to the product it already was, rather than to a product full of
// question marks that open empty sheets.
export function PageHelp({ slug }: { slug: ProductHelpSlugKey }) {
  return <HelpLink slug={slug} />;
}
