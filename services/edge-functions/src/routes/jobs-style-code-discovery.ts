// US-2784: the nightly brand-first style-code crawl.
//
// The US-2690 sweep asks the market about codes we have already met. This tick
// runs the other direction — page a brand's live eBay listings and keep the
// codes sellers already typed into structured fields — so the index holds
// garments nobody here has ever listed.
//
// SEQUENTIAL ON PURPOSE. These calls come out of the same app-level eBay
// allowance the comps ladder and the seller Add flow draw on. A fan-out here is
// how one overnight tick starves somebody listing at 3am.
//
// MOST OF A TICK IS DECIDING WHAT NOT TO CRAWL. pickDiscoveryTargets drops
// brands inside their cooldown and brands that have gone several passes without
// a new code, then the budget takes the top slice and the rest are reported as
// deferred rather than silently dropped.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  getBrowseItemAspects,
  searchBrowseByBrand,
  searchBrowseCategoryPage,
} from "../lib/ebay-client.ts";
import { brandKeyForRaw } from "../lib/brand-normalize.ts";
import { aspectNameConfidence } from "../lib/style-code-aspects.ts";
import {
  canonicalStyleCode,
  recordStyleCodeObservations,
} from "../lib/style-code-observations.ts";
import {
  DEFAULT_PROSPECT_LOOKUPS,
  emptyProspectOutcome,
  harvestSighting,
  poolExhausted,
  type ProspectOutcome,
  type ProspectSighting,
  tallyCandidates,
} from "../lib/style-code-prospect.ts";
import {
  type BrandOutcome,
  crawlBrand,
  DEFAULT_BRANDS_PER_RUN,
  DEFAULT_LOOKUPS_PER_BRAND,
  DISCOVERY_PAGE_SIZE,
  type DiscoveryBrandRow,
  type DiscoveryDeps,
  type DiscoveryListing,
  type DiscoveryStateRow,
  type DiscoveryWrite,
  EBAY_CLOTHING_CATEGORY_ID,
  MAX_DISCOVERY_OFFSET,
  nextCursor,
  planDiscoveryWrites,
  pickDiscoveryTargets,
  summarizeDiscovery,
} from "../lib/style-code-discovery.ts";

/** Brands pulled from the rotation RPC per tick. Far larger than the budget on
 *  purpose: most are filtered by cooldown before the budget applies, so a scan
 *  the size of the budget would crawl the same few brands forever. */
const BRAND_SCAN_LIMIT = 500;

/** Own-listing ids read per tick. The crawl searches by BRAND, so it meets far
 *  more of our own inventory than the sweep does. */
const OWN_LISTING_SCAN_LIMIT = 20_000;

/** How long one tick may hold the lock. Generous: the budget bounds the work,
 *  and a lock expiring mid-tick lets a second worker duplicate eBay calls. */
const LOCK_TTL_SECONDS = 1800;

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The brand rotation and its cursors, in one read.
 *
 * The obvious version is "select from brand_knowledge, select from
 * discovery_state, join in JS". 00627's candidate scan already paid for that
 * shape: a limit applied client-side bounds ROWS, and whichever brands sort
 * late never make it into a tick while the job reports success.
 */
async function scanBrands(): Promise<{
  brands: DiscoveryBrandRow[];
  state: DiscoveryStateRow[];
}> {
  const { data, error } = await supabaseAdmin.rpc(
    "style_code_discovery_brands",
    { p_limit: BRAND_SCAN_LIMIT },
  );
  if (error) {
    console.error("[style-code-discovery] brand scan failed:", error.message);
    return { brands: [], state: [] };
  }
  const rows = (data ?? []) as Array<{
    brand_key: string;
    brand_label: string | null;
    page_offset: number | null;
    last_run_at: string | null;
    empty_passes: number | null;
  }>;
  if (rows.length >= BRAND_SCAN_LIMIT) {
    // Say it. A bound that binds is the point at which "we considered every
    // brand" stops being true, and nothing else in the output would show it.
    console.warn(
      `[style-code-discovery] brand scan hit the ${BRAND_SCAN_LIMIT} cap — ` +
        "some brands were not considered this tick; raise the cap",
    );
  }
  return {
    brands: rows.map((r) => ({
      brandKey: r.brand_key,
      brandLabel: r.brand_label ?? r.brand_key,
    })),
    state: rows.map((r) => ({
      brand_key: r.brand_key,
      page_offset: r.page_offset ?? 0,
      last_run_at: r.last_run_at,
      empty_passes: r.empty_passes ?? 0,
    })),
  };
}

/**
 * Our OWN eBay listings, so the crawl cannot learn our guesses back.
 *
 * A read failure returns an EMPTY set, which fails toward counting our own
 * listings rather than toward skipping the tick — the same trade the sweep
 * makes, and logged for the same reason.
 */
async function ownEbayListingIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id")
    .eq("platform", "ebay")
    .not("platform_listing_id", "is", null)
    .limit(OWN_LISTING_SCAN_LIMIT);
  if (error) {
    console.error(
      "[style-code-discovery] own-listing read failed:",
      error.message,
    );
    return new Set();
  }
  return new Set(
    ((data ?? []) as Array<{ platform_listing_id: string | null }>)
      .map((r) => (r.platform_listing_id ?? "").trim())
      .filter(Boolean),
  );
}

function makeLiveDeps(): DiscoveryDeps {
  return {
    page: async ({ brandLabel, offset, limit }) => {
      const res = await searchBrowseByBrand({
        brand: brandLabel,
        categoryId: EBAY_CLOTHING_CATEGORY_ID,
        offset,
        limit,
      });
      return res.listings;
    },

    aspects: async (itemId) => {
      const listing = await getBrowseItemAspects(itemId);
      return listing ? { ...listing, url: null } : null;
    },

    canonicalize: (brandKey, raw) => canonicalStyleCode(brandKey, raw),

    knownCodes: async (brandKey, codes) => {
      if (codes.length === 0) return new Set<string>();
      const { data, error } = await supabaseAdmin
        .from("style_code_observations")
        .select("style_code_norm")
        .eq("brand_key", brandKey)
        .in("style_code_norm", codes as string[]);
      if (error) {
        // An empty set reads as "all of these are new", which over-reports the
        // yield. Wrong in the direction that is visible in the numbers rather
        // than the one that quietly marks a productive brand exhausted.
        console.error(
          "[style-code-discovery] known-code read failed:",
          error.message,
        );
        return new Set<string>();
      }
      return new Set(
        ((data ?? []) as Array<{ style_code_norm: string }>).map(
          (r) => r.style_code_norm,
        ),
      );
    },

    writeCode: async (brandKey, write: DiscoveryWrite) => {
      await recordStyleCodeObservations({
        brandKey,
        styleCodeRaw: write.codeRaw,
        titles: write.titles,
        source: "discovery",
      });
    },

    writeName: async (brandKey, write: DiscoveryWrite) => {
      if (!write.name) return;
      const { error } = await supabaseAdmin.rpc("record_style_code_name", {
        p_brand_key: brandKey,
        p_style_code_norm: write.codeNorm,
        p_style_code_raw: write.codeRaw,
        p_name: write.name,
        // The same evidence the sweep records under this source: a structured
        // code that matches plus a structured name, from a seller who typed
        // both. Below a seller correction and below a decoder hit, so a
        // discovered name populates the index and never overrules it.
        p_source: "consensus",
        p_supporting: write.supporting,
        p_confidence: aspectNameConfidence(write.supporting),
        p_evidence_url: write.evidenceUrl,
      });
      if (error) throw error;
    },

    markCrawled: async ({
      brandKey,
      nextOffset,
      listingsSeen,
      codesFound,
      newCodes,
    }) => {
      const { error } = await supabaseAdmin.rpc(
        "record_style_code_discovery",
        {
          p_brand_key: brandKey,
          p_next_offset: nextOffset,
          p_listings_seen: listingsSeen,
          p_codes_found: codesFound,
          p_new_codes: newCodes,
        },
      );
      if (error) throw error;
    },
  };
}

/**
 * Where the unfiltered survey stopped paging, as one row.
 *
 * A read failure returns offset 0, which re-reads a page rather than skipping
 * the pass. Wasteful once; the alternative silently walks past inventory.
 */
async function readProspectCursor(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("style_code_prospect_state")
    .select("page_offset")
    .eq("id", "clothing")
    .maybeSingle();
  if (error) {
    console.error(
      "[style-code-discovery] prospect cursor read failed:",
      error.message,
    );
    return 0;
  }
  const offset = (data as { page_offset?: number } | null)?.page_offset ?? 0;
  return offset >= MAX_DISCOVERY_OFFSET ? 0 : Math.max(0, offset);
}

/**
 * US-2786: survey eBay's clothing category for brands nobody has curated.
 *
 * Runs ONLY when every curated brand has been crawled and gone flat, or when an
 * operator forces it. That gate is the story's first requirement and it is the
 * right one: a pool with one never-crawled brand left may be hiding the best
 * brand in it, and spending the survey budget first is the expensive way to
 * find that out.
 *
 * Codes found here ARE kept, for brands we hold no knowledge on. A brand with
 * no decoder cannot canonicalize its spellings, so those rows are filed under
 * the plain normalized code and a later decoder re-keys them the way US-2714
 * re-keys Lululemon's four spellings.
 */
async function runProspectPass(args: {
  ownItemIds: ReadonlySet<string>;
  knownBrandKeys: ReadonlySet<string>;
  lookups: number;
}): Promise<ProspectOutcome> {
  const offset = await readProspectCursor();
  const out = emptyProspectOutcome(offset);
  out.ran = true;

  try {
    const page = await searchBrowseCategoryPage({
      categoryId: EBAY_CLOTHING_CATEGORY_ID,
      offset,
      limit: DISCOVERY_PAGE_SIZE,
    });
    out.scanned = page.listings.length;

    const foreign = page.listings.filter((l) => !args.ownItemIds.has(l.itemId));
    out.ownSkipped = page.listings.length - foreign.length;

    const sightings: ProspectSighting[] = [];
    for (const listing of foreign.slice(0, Math.max(0, args.lookups))) {
      out.inspected++;
      const detail = await getBrowseItemAspects(listing.itemId);
      if (!detail) continue;
      const full: DiscoveryListing = { ...detail, url: listing.url };
      const sighting = harvestSighting({
        listing: full,
        // Plain normalization, not a decoder: an uncurated brand has no
        // brand_style_codes spec to resolve against.
        canonicalize: (raw) => canonicalStyleCode("", raw),
        ownItemIds: args.ownItemIds,
      });
      if (!sighting) continue;
      out.branded++;
      if (sighting.declaredCode) out.declared++;
      sightings.push(sighting);
    }

    const tallies = tallyCandidates({
      sightings,
      brandKeyFor: (label) => brandKeyForRaw(label),
      knownBrandKeys: args.knownBrandKeys,
    });
    out.candidates = tallies.length;

    for (const tally of tallies) {
      const { error } = await supabaseAdmin.rpc(
        "record_style_code_brand_candidate",
        {
          p_brand_key: tally.brandKey,
          p_brand_label: tally.brandLabel,
          p_listings_seen: tally.listingsSeen,
          p_listings_with_code: tally.listingsWithCode,
        },
      );
      if (error) {
        console.error(
          `[style-code-discovery] candidate write failed for ${tally.brandKey}:`,
          error.message,
        );
      }
    }

    // Keep the codes too. A code read off a tag is worth having whether or not
    // anyone has curated the brand it belongs to.
    const byBrand = new Map<string, ProspectSighting[]>();
    for (const s of sightings) {
      if (!s.declaredCode || !s.codeRaw) continue;
      const key = brandKeyForRaw(s.brandLabel);
      if (!key) continue;
      const list = byBrand.get(key);
      if (list) list.push(s);
      else byBrand.set(key, [s]);
    }
    for (const [brandKey, group] of byBrand) {
      const writes = planDiscoveryWrites(
        group.map((s) => ({
          itemId: "",
          codeNorm: canonicalStyleCode("", s.codeRaw),
          codeRaw: s.codeRaw!,
          name: s.name,
          title: s.title,
          url: s.url,
        })),
      );
      for (const write of writes) {
        await recordStyleCodeObservations({
          brandKey,
          styleCodeRaw: write.codeRaw,
          titles: write.titles,
          source: "discovery",
        });
        out.codes++;
      }
    }

    out.nextOffset = nextCursor({
      offset,
      requested: DISCOVERY_PAGE_SIZE,
      returned: page.listings.length,
    });
  } catch (err) {
    out.failed = true;
    console.error(
      "[style-code-discovery] prospect pass failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { error } = await supabaseAdmin.rpc("record_style_code_prospect", {
    p_next_offset: out.nextOffset,
    p_listings_seen: out.scanned,
    p_brands_seen: out.candidates,
  });
  if (error) {
    console.error(
      "[style-code-discovery] prospect cursor write failed:",
      error.message,
    );
  }

  return out;
}

/** The lock is a seam so the concurrency guarantee is a test, not a claim. */
export type LockAcquirer = typeof acquireJobLock;

export interface DiscoveryRunOptions {
  deps?: DiscoveryDeps | null;
  acquire?: LockAcquirer;
  /** US-2787: crawl these brands regardless of cooldown. What an operator means
   *  by "run it on adidas now". Empty for the nightly cron. */
  forceBrandKeys?: readonly string[];
  /** Overrides the env budget. Used by the admin single-brand run. */
  budget?: number;
  /** US-2786: run the uncurated-brand survey even if the curated pool is not
   *  used up yet. Operator-only; the cron never sets it. */
  forceProspect?: boolean;
}

/**
 * One discovery tick, with no Hono Context anywhere in it.
 *
 * US-2787 pulled this out of the cron handler so the admin "run now" button and
 * the 3am cron are the SAME code path. A second implementation of a tick is a
 * second place for the budget, the lock or the own-listing exclusion to be
 * wrong, and the manual one is the copy nobody would notice drifting.
 */
export async function runStyleCodeDiscovery(
  opts: DiscoveryRunOptions = {},
): Promise<Record<string, unknown>> {
  const deps = opts.deps ?? null;
  const acquire = opts.acquire ?? acquireJobLock;

  // A second tick arriving while the first runs must do NOTHING — not a smaller
  // crawl, not a retry. Both would spend the shared eBay budget on the same
  // offsets of the same brands. This is also what stops an impatient operator
  // clicking "run now" three times from tripling the eBay spend.
  const lock = await acquire("style-code-discovery", LOCK_TTL_SECONDS);
  if (!lock.acquired) {
    return { ok: true, skipped: true, reason: lock.reason };
  }

  try {
    const { brands, state } = await scanBrands();
    const forceBrandKeys = new Set(
      (opts.forceBrandKeys ?? []).map((k) => k.trim()).filter(Boolean),
    );
    const work = pickDiscoveryTargets({
      brands,
      state,
      budget: opts.budget ??
        envInt("STYLE_CODE_DISCOVERY_BRANDS", DEFAULT_BRANDS_PER_RUN),
      now: new Date(),
      forceBrandKeys,
    });

    const effectiveDeps = deps ?? makeLiveDeps();
    const ownItemIds = deps ? new Set<string>() : await ownEbayListingIds();
    const lookups = envInt(
      "STYLE_CODE_DISCOVERY_LOOKUPS",
      DEFAULT_LOOKUPS_PER_BRAND,
    );

    const outcomes: BrandOutcome[] = [];
    for (const target of work.targets) {
      outcomes.push(
        await crawlBrand({
          target,
          deps: effectiveDeps,
          ownItemIds,
          lookups,
        }),
      );
    }

    const summary = summarizeDiscovery(outcomes);

    // US-2786: only after the curated pool has nothing left to give, and never
    // on a single-brand manual run, which is somebody asking one question.
    const singleBrandRun = forceBrandKeys.size > 0;
    const prospect = deps || singleBrandRun
      ? emptyProspectOutcome(0)
      : (opts.forceProspect || poolExhausted(state))
      ? await runProspectPass({
        ownItemIds,
        knownBrandKeys: new Set(brands.map((b) => b.brandKey)),
        lookups: envInt(
          "STYLE_CODE_PROSPECT_LOOKUPS",
          DEFAULT_PROSPECT_LOOKUPS,
        ),
      })
      : emptyProspectOutcome(0);

    // Say what was left behind. A job reporting only what it did reads as "we
    // covered everything" on a run that reached three brands out of forty.
    console.log(
      `[style-code-discovery] considered=${work.considered} ` +
        `crawled=${summary.crawled} deferred=${work.deferred} ` +
        `cooldown=${work.skippedCooldown} exhausted=${work.skippedExhausted} ` +
        `scanned=${summary.scanned} inspected=${summary.inspected} ` +
        `declared=${summary.declared} codes=${summary.codes} ` +
        `new=${summary.newCodes} names=${summary.names} ` +
        `own_skipped=${summary.ownSkipped} failed=${summary.failed} ` +
        `prospect=${prospect.ran ? "ran" : "skipped"}` +
        (prospect.ran
          ? ` prospect_inspected=${prospect.inspected} ` +
            `prospect_candidates=${prospect.candidates} ` +
            `prospect_codes=${prospect.codes}`
          : ""),
    );

    return {
      ok: true,
      considered: work.considered,
      deferred: work.deferred,
      skipped_cooldown: work.skippedCooldown,
      skipped_exhausted: work.skippedExhausted,
      ...summary,
      prospect,
      brands: outcomes.map((o) => ({
        brand_key: o.brandKey,
        scanned: o.scanned,
        inspected: o.inspected,
        declared: o.declared,
        codes: o.codes,
        new_codes: o.newCodes,
        names: o.names,
        next_offset: o.nextOffset,
        failed: o.failed,
      })),
    };
  } finally {
    await lock.release();
  }
}

export async function handleStyleCodeDiscoveryCron(
  c: Context,
  deps: DiscoveryDeps | null = null,
  acquire: LockAcquirer = acquireJobLock,
): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json(await runStyleCodeDiscovery({ deps, acquire }));
}
