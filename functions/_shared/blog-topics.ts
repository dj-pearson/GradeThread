// US-9037: the curated topic registry behind /blog/tag/<tag>.
//
// WHY A REGISTRY AND NOT A THRESHOLD.
//
// Every /blog/tag/* URL has been served `noindex, follow` since the archives
// were 138 URLs against ~61 published posts. That was the right call then and
// it is the wrong call now: measured on prod 2026-09-14 there are 196
// published posts across 259 tags, and while 209 of those tags still carry one
// or two posts, 23 carry eight or more and `defect-taxonomy` carries 71.
//
// The tempting fix is to drop the blanket noindex and let a post count decide.
// It does not work. An archive page that is an <h1> plus three cards has
// nothing on it that is not already on the posts, so Google crawls it and
// declines to index it, and the URLs move from "Excluded by noindex" to
// "Crawled - currently not indexed" without a single one of them ranking.
//
// So indexing is EDITORIAL here, not arithmetic. A topic gets indexed when
// somebody has written a name, a description and an intro for it: copy that
// exists on no other page on the domain and tells a reader what the archive
// collects. The post-count floor below is a second gate, not the first one, and
// it only ever removes topics from the set.
//
// Adding a topic means writing real copy for it. If there is nothing to say
// about a tag beyond its own name, that tag should stay noindexed.
//
// LOCKSTEP: three places read this module and must agree.
//   1. functions/blog/[[path]].ts renderTag   - the robots directive + the copy
//   2. functions/_shared/sitemap.ts blogUrls  - which topic URLs are listed
//   3. src/test/blog-topics.test.ts           - the guard over both
// Listing a URL in the sitemap that the page itself noindexes tells Google two
// contradictory things, so the floor is enforced at render time and the
// registry is kept to topics comfortably above it.

/**
 * Minimum live published posts before a curated topic may be indexed.
 *
 * Five is the floor, not the target. Every topic in the registry sits at five
 * or more as of 2026-09-14 and most sit far above it. The check exists for the
 * case where posts are unpublished later: a topic that falls under the floor
 * silently reverts to `noindex, follow` rather than becoming a two-card page
 * that still claims to be worth ranking.
 */
export const MIN_INDEXABLE_TOPIC_POSTS = 5;

export interface BlogTopic {
  /** Display name, used as the <h1> and in the breadcrumb. Not the slug. */
  name: string;
  /** <title> text, before the " | GradeThread Blog" suffix. */
  title: string;
  /** Meta description and og:description. Unique per topic. */
  description: string;
  /** Lead paragraph, rendered above the post cards. Plain text, no markup. */
  intro: string;
}

/**
 * Tag slug -> curated copy. Slug is the URL segment, lowercase, as stored in
 * blog_post_tags.tag.
 *
 * Deliberately absent: `gradethread` (a brand tag with no search intent, and an
 * archive of our own name answers nothing) and `ebay` (eight posts, but
 * `ebay-selling` and `ebay-listing-optimization` already cover the subject with
 * 13 and 31 posts, and a third generic eBay archive would only split them).
 * `reseller-strategy` and `reseller-workflow` are out for the same reason
 * against `reseller-operations`.
 */
export const BLOG_TOPICS: Record<string, BlogTopic> = {
  "defect-taxonomy": {
    name: "Defect taxonomy",
    title: "Clothing defect taxonomy",
    description:
      "How GradeThread names and classifies garment defects: pilling, pulls, staining, seam failure, hardware wear, and what each one costs a condition grade.",
    intro:
      "A defect you cannot name is a defect you cannot price or disclose. These articles work through the vocabulary GradeThread uses for garment damage, what separates one defect from a similar-looking one, and how each type moves a condition score.",
  },
  "condition-grading": {
    name: "Condition grading",
    title: "Condition grading for pre-owned clothing",
    description:
      "Articles on grading used clothing to a repeatable 1.0 to 10.0 scale: what each factor measures, how photos change the result, and where graders disagree.",
    intro:
      "Grading is the part of reselling that most sellers do by feel, which is why two listings of the same shirt can read \"excellent\" and \"good\" on the same day. These posts cover the method behind a repeatable grade, factor by factor.",
  },
  "condition-vocabulary": {
    name: "Condition vocabulary",
    title: "Condition vocabulary for resale listings",
    description:
      "The words resale listings use for condition, what buyers actually hear when they read them, and which phrases cause returns.",
    intro:
      "\"Good used condition\" means something different to every buyer who reads it, and the gap between what a seller meant and what a buyer expected is where most condition disputes start. These articles pin the terms down.",
  },
  "reseller-finances": {
    name: "Reseller finances",
    title: "Reseller finances, fees and taxes",
    description:
      "Cost of goods, platform fees, payout reconciliation, 1099-K reporting and margin math for people who resell clothing.",
    intro:
      "Most reselling advice stops at what sold. These posts cover what was left afterwards: fee structures, cost basis, quarterly tax, payout reconciliation and the margin math that decides whether a flip was worth doing.",
  },
  "category-grading": {
    name: "Category grading",
    title: "Grading by garment category",
    description:
      "How condition grading changes by garment type, from denim and knitwear to outerwear, footwear, swimwear and tailoring.",
    intro:
      "A pill on a cashmere sweater and a pill on a fleece are not the same finding, and a scuff means something different on a boot than on a blazer. These articles cover what to look at first in each garment category.",
  },
  "inventory-ops": {
    name: "Inventory operations",
    title: "Reseller inventory operations",
    description:
      "SKU systems, bin organization, storage, aging inventory and the physical side of running a clothing resale operation.",
    intro:
      "Inventory that cannot be found is inventory that cannot be sold, and the death pile is a storage problem before it is a motivation problem. These posts cover SKUs, bins, labelling and keeping stock findable as volume grows.",
  },
  "ebay-listing-optimization": {
    name: "eBay listing optimization",
    title: "eBay listing optimization for clothing",
    description:
      "Titles, item specifics, photos and condition fields that affect how eBay's search surfaces a clothing listing.",
    intro:
      "eBay's search reads item specifics as retrieval data, not decoration, so an incomplete listing is invisible for the queries it should win. These articles cover the fields that matter and the ones that do not.",
  },
  "vintage-clothing": {
    name: "Vintage clothing",
    title: "Vintage clothing condition and resale",
    description:
      "Dating, grading and pricing vintage garments, where age-appropriate wear stops being a defect and starts being provenance.",
    intro:
      "Vintage breaks the usual grading rules because some of the wear is the point. These posts cover dating garments, telling as-made character from actual damage, and pricing pieces whose condition is part of what a buyer wants.",
  },
  flipdesk: {
    name: "FlipDesk",
    title: "FlipDesk workflows for resellers",
    description:
      "How FlipDesk handles sourcing, cataloging, measuring, photographing, comping, listing and reconciling a clothing inventory.",
    intro:
      "FlipDesk is the reseller side of GradeThread, running an item from the moment it is sourced to the moment its payout reconciles. These posts cover the workflow and the decisions built into it.",
  },
  mercari: {
    name: "Mercari",
    title: "Selling clothing on Mercari",
    description:
      "Listing, pricing, shipping and condition disclosure on Mercari, and how the platform differs from eBay and Poshmark.",
    intro:
      "Mercari rewards different behaviour than eBay does, from how listings surface to how disputes resolve. These articles cover selling clothing there specifically rather than treating every marketplace as one.",
  },
  "returns-reconciliation": {
    name: "Returns and reconciliation",
    title: "Resale returns, disputes and reconciliation",
    description:
      "Handling not-as-described claims, chargebacks and refunds, and reconciling what a platform actually paid against what it said it would.",
    intro:
      "A return is two problems: the item coming back and the money that has to be traced. These posts cover disputes, seller protection, chargebacks and matching platform payouts to the sales they belong to.",
  },
  crosslisting: {
    name: "Crosslisting",
    title: "Crosslisting clothing across marketplaces",
    description:
      "Listing the same garment on eBay, Poshmark, Mercari, Depop and Vinted without duplicating work or overselling stock.",
    intro:
      "Crosslisting multiplies reach and it multiplies mistakes, because one item now has five descriptions that can drift apart and one stock count that five platforms can sell. These articles cover doing it without either.",
  },
  "reseller-operations": {
    name: "Reseller operations",
    title: "Running a clothing resale operation",
    description:
      "Process, tooling and throughput for resellers moving past a handful of listings a week.",
    intro:
      "The jump from a side hustle to a real operation is mostly process. These posts cover batching, tooling, throughput and the parts of the job that stop scaling first.",
  },
  "reseller-tips": {
    name: "Reseller tips",
    title: "Practical tips for clothing resellers",
    description:
      "Short practical advice on sourcing, listing, photographing, pricing and shipping pre-owned clothing.",
    intro:
      "Smaller pieces that did not need a full guide: things worth knowing about sourcing, listing, shipping and customer service, collected in one place.",
  },
  "ebay-selling": {
    name: "eBay selling",
    title: "Selling clothing on eBay",
    description:
      "Account health, fees, listing formats, disputes and shipping for clothing sellers on eBay.",
    intro:
      "eBay is still the largest secondhand clothing market and the one with the most rules. These articles cover selling there: fees, formats, account health, and what happens when something goes wrong.",
  },
  poshmark: {
    name: "Poshmark",
    title: "Selling clothing on Poshmark",
    description:
      "Listing, sharing, offers, bundles and condition disclosure on Poshmark, and where it diverges from other marketplaces.",
    intro:
      "Poshmark is a social marketplace before it is a search marketplace, which changes what a good listing looks like. These posts cover selling clothing there on its own terms.",
  },
  "structural-integrity": {
    name: "Structural integrity",
    title: "Garment structural integrity",
    description:
      "Seams, stitching, linings, hems and construction: the condition factor that decides whether a garment will survive being worn.",
    intro:
      "Structural integrity is the 25 percent of a GradeThread score that asks whether the garment still holds together. These articles cover seam failure, lining damage, hem loss and repairs, and how to judge them from photos.",
  },
  "fabric-condition": {
    name: "Fabric condition",
    title: "Fabric condition in used clothing",
    description:
      "Pilling, thinning, fading, dye loss and fibre breakdown across cotton, wool, denim, leather and synthetics.",
    intro:
      "Fabric is the heaviest factor in a GradeThread score at 30 percent, and it behaves differently in every fibre. These posts cover what wear looks like material by material and how far along it has to be to matter.",
  },
  "grading-standards": {
    name: "Grading standards",
    title: "Condition grading standards",
    description:
      "What a grading standard has to do to be usable across sellers: defined factors, fixed weights, repeatable scores and published criteria.",
    intro:
      "A standard that two people apply differently is not a standard. These articles cover what makes a condition scale repeatable, how GradeThread's factors are weighted, and where published criteria beat seller judgement.",
  },
  "thrift-sourcing": {
    name: "Thrift sourcing",
    title: "Thrift and wholesale sourcing",
    description:
      "Finding resellable clothing at thrift stores, estate sales, bins and wholesale lots, and judging condition before you buy.",
    intro:
      "Sourcing is a condition assessment done in bad light with thirty seconds per item. These posts cover where to look, what to pick up, and how to spot the damage that kills a flip before it is in your cart.",
  },
  "denim-grading": {
    name: "Denim grading",
    title: "Grading used denim",
    description:
      "Whiskering, honeycombs, fades, blowouts, hem wear and hardware on used jeans, and which of it is design rather than damage.",
    intro:
      "Denim is the category where design and damage look most alike: distressing sold that way, fading that took five years, and a blowout that ends the garment. These articles separate the three.",
  },
  "trust-psychology": {
    name: "Buyer trust",
    title: "Buyer trust in secondhand clothing",
    description:
      "Why buyers hesitate on used clothing, what disclosure actually buys a seller, and how condition evidence changes conversion and returns.",
    intro:
      "Every secondhand purchase asks a buyer to accept a described condition sight unseen. These posts cover what makes that easier, what disclosure costs and returns, and why over-describing a flaw usually sells better than hiding it.",
  },
  "functional-elements": {
    name: "Functional elements",
    title: "Zippers, buttons and hardware condition",
    description:
      "Zips, buttons, snaps, drawstrings, elastic and closures: the condition factor a buyer tests first and photos hide best.",
    intro:
      "Hardware is 15 percent of a GradeThread score and close to 100 percent of what a buyer touches in the first ten seconds. These articles cover zips, closures and elastic, and how to check them before listing.",
  },
  "price-by-grade": {
    name: "Price by grade",
    title: "Pricing pre-owned clothing by condition grade",
    description:
      "What a condition grade is worth in dollars, and how the same garment prices across the range from near-new to well-worn.",
    intro:
      "Condition is the variable most comp tools ignore, which is why a sold comp can be off by half. These posts cover what each grade band is actually worth and how to price against comps that were graded differently.",
  },
  "pricing-strategy": {
    name: "Pricing strategy",
    title: "Resale pricing strategy",
    description:
      "Comping, markdowns, offers, bundles and clearance timing for pre-owned clothing inventory.",
    intro:
      "Pricing is a schedule, not a number: what a garment lists at, what it drops to, and when it stops being worth the shelf space. These articles cover comping and the markdown decisions that follow it.",
  },
  "cosmetic-appearance": {
    name: "Cosmetic appearance",
    title: "Cosmetic condition of used clothing",
    description:
      "Stains, marks, print cracking, discoloration and the surface flaws buyers notice first in photos.",
    intro:
      "Cosmetic appearance is the factor a buyer grades from the listing photos whether or not a seller mentions it. These posts cover staining, print condition, discoloration, and what photographs worse than it looks in person.",
  },
  "vintage-jeans": {
    name: "Vintage jeans",
    title: "Vintage jeans condition and resale",
    description:
      "Dating, grading and pricing vintage denim, from selvedge and single-stitch tells to repairs that add value rather than subtract it.",
    intro:
      "Vintage denim is priced on a mix of age, cut, fabric and wear, and the wear can push the price either direction. These articles cover dating a pair, grading it honestly, and knowing which repairs buyers accept.",
  },
  "vintage-outerwear": {
    name: "Vintage outerwear",
    title: "Vintage outerwear condition and resale",
    description:
      "Grading vintage jackets and coats: leather and shell condition, linings, insulation, zips, and age-appropriate wear.",
    intro:
      "Outerwear carries more failure points than any other category, and vintage pieces have had decades to find them. These posts cover linings, insulation, hardware and shell condition on jackets and coats.",
  },
};

/** Curated topic slugs, in registry order. */
export const BLOG_TOPIC_SLUGS = Object.keys(BLOG_TOPICS);

/** The curated entry for a tag slug, or null if the tag is not curated. */
export function blogTopic(tag: string): BlogTopic | null {
  return BLOG_TOPICS[tag.toLowerCase()] ?? null;
}

/**
 * Whether a tag archive may be indexed: curated AND at or above the post floor.
 *
 * Both gates, always. The registry alone would let a topic keep claiming to be
 * worth ranking after its posts were unpublished; the floor alone is the
 * arithmetic approach that produces "crawled - currently not indexed".
 */
export function isIndexableTopic(tag: string, publishedPostCount: number): boolean {
  return blogTopic(tag) !== null && publishedPostCount >= MIN_INDEXABLE_TOPIC_POSTS;
}
