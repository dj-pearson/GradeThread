# Off-page authority — runbook (US-1695)

Entity-confirming, low/zero-cost off-page assets so search engines and LLMs
anchor the GradeThread entity. Priority-ordered; mostly operator tasks, with the
one code hook noted.

## Code hook (done)

`Organization.sameAs` is config-driven (`src/lib/seo/social.ts`
`socialProfileUrls()`): GitHub is hard-wired, and X, LinkedIn, Instagram,
Crunchbase, YouTube (US-1677), and **Wikidata** (US-1695) each flow into the
site-wide Organization JSON-LD when their `VITE_SOCIAL_*` env var holds a real
URL. Only real URLs ever appear — no placeholders. So the moment a profile or the
Wikidata item exists, set the env var and it's referenced everywhere the
Organization node renders (every prerendered page).

## 1. Directory / integration listings (do first — zero cost, entity-confirming)

Claim and complete high-authority profiles, each linking back to
gradethread.com. When live, set the matching `VITE_SOCIAL_*` where one exists:

- **Shopify App Store** listing (FlipDesk integrates Shopify) — high authority.
- **eBay-compatible-app** listing / developer directory.
- **Product Hunt** launch.
- **G2** and **Capterra** profiles (category: reseller / inventory software).
- **Crunchbase** (`VITE_SOCIAL_CRUNCHBASE`), **LinkedIn** company page
  (`VITE_SOCIAL_LINKEDIN`), **X** (`VITE_SOCIAL_X`), **YouTube**
  (`VITE_SOCIAL_YOUTUBE`).

## 2. Wikidata entity (after 3–4 independent citations exist)

Per the SEO plan (§3, §7.7): claim a Wikidata item for GradeThread **only once
3–4 independent, reliable citations exist** (press coverage of the data report,
directory listings, podcast/YouTube mentions). Then:

1. Create the item with `instance of` = software / company, label, description,
   and `official website` = gradethread.com.
2. Add `sameAs`-equivalent statements (official social profiles) on the item.
3. Set `VITE_SOCIAL_WIKIDATA` to the item URL (`https://www.wikidata.org/wiki/Q…`)
   so Organization.sameAs references it.

Claiming it prematurely (no independent citations) risks deletion and wasted
signal — hence the gate.

## 3. Earned links (the compounding, legitimate channel)

- **The certificate mesh** (already shipped, US-1665): live-listing links/embeds
  back to certs — the link source competitors can't clone.
- **Data-driven PR**: pitch the "State of Resale Condition" report (US-976) to
  resale-trade press and reseller newsletters. Original data is the only
  reliably link-worthy asset a bootstrapped SaaS can manufacture.
- **Reseller podcast/YouTube circuit**: founder guest spots on the returns /
  grading-standard story (not a product pitch).
- **Tool-roundup inclusion**: pitch inclusion in "best crosslisting app / reseller
  tools" listicles.

## AVOID (per plan §7 IGNORE — these backfire at our domain authority)

- **Paid link buying and PBNs** — existential risk, no upside.
- **Mass generic guest-posting** on marketing blogs — wrong neighborhood; we want
  resale-world relevance, not DR arithmetic.
- **A premature Wikipedia article** — notability isn't there yet; it'll be
  deleted and can backfire. (Wikidata ≠ Wikipedia; Wikidata is fine per §2.)
