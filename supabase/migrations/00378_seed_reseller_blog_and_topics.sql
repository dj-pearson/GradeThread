-- Seed reseller blog drafts + topic bank from the July 2026 Reddit-derived
-- research titles (blog-topics-clothing-reselling-app).
--
-- Two parts, both idempotent + additive (no schema change):
--   1. FOUR fully-written draft blog_posts (status='draft', generated_by='human')
--      that an admin reviews in /admin/content/blog/editor and publishes. Bodies
--      are stored in body_html (the public SSR renderer and the Tiptap admin
--      editor both read body_html; body_json stays at its '{}' default and is
--      populated by Tiptap on first edit). Adapted to GradeThread/FlipDesk's
--      differentiated angle (condition grading, authentication, comps, pipeline)
--      rather than the generic competitor-framed source titles.
--   2. ~40 remaining research titles seeded into the content_topics bank as
--      'queued' so the autonomous scheduler generates them over time. Titles
--      re-angled to what GradeThread/FlipDesk uniquely answers; deduped against
--      the existing bank (00192) by (surface, product_focus, lower(primary_keyword)).
--
-- Idempotent: blog_posts INSERT ... ON CONFLICT (slug) DO NOTHING; topics
-- INSERT ... WHERE NOT EXISTS on the primary_keyword dedup key. Safe to re-run.
-- Aggregate marketing content — no PII, no tenant data.

-- ══════════════════════════════════════════════════════════
-- PART 1 — Draft blog posts (developed articles)
-- ══════════════════════════════════════════════════════════

-- 1/4 · How to Start Reselling Clothes (pillar, top-funnel, product='both')
INSERT INTO public.blog_posts
  (slug, title, excerpt, body_html, product_focus, status,
   seo_title, seo_description, primary_keyword, secondary_keywords,
   reading_time_min, generated_by)
VALUES (
  'how-to-start-reselling-clothes-beginners-guide',
  'How to Start Reselling Clothes: A Beginner''s Guide to Sourcing, Grading, and Listing',
  'Everything a first-time clothing reseller needs: where to source, how to judge condition honestly, how to price with real comps, and how to list without burning out.',
  $html$<p>Reselling clothes is one of the lowest-barrier businesses you can start — you can begin with the closet you already own. But the gap between a $20 side hustle and a repeatable operation comes down to a handful of skills: sourcing well, judging condition honestly, pricing against real data, and listing fast enough to build momentum. Here is the whole loop, in order.</p>
<h2>1. Decide what you will sell</h2>
<p>You do not need a niche on day one, but a loose focus makes you faster. Most beginners start with women's contemporary brands, menswear basics, or activewear because they turn over reliably. Sell what you can source cheaply and recognize on a rack. As you learn which categories actually pay your time, tighten in.</p>
<h2>2. Source inventory</h2>
<p>Start with what is free or cheap: your own closet, friends and family, then thrift stores, estate sales, and clearance racks. Before you buy anything to resell, get in the habit of checking sold comps from your phone — if a jacket has not sold at your target price recently, the rack price does not matter. Sourcing discipline is where most of your profit is actually made.</p>
<h2>3. Inspect and grade condition — honestly</h2>
<p>Condition is the single biggest driver of returns and disputes, and it is where sloppy sellers lose money. Inspect every garment against five factors before you list it:</p>
<ul>
<li><strong>Fabric</strong> — pilling, thinning, holes, snags.</li>
<li><strong>Structure</strong> — seams, hems, stretched cuffs and collars.</li>
<li><strong>Cosmetic</strong> — stains, fading, discoloration (check underarms and collars).</li>
<li><strong>Functional</strong> — zippers, buttons, clasps, elastic.</li>
<li><strong>Odor and cleanliness</strong> — smoke, must, and the "thrift smell" that drives returns.</li>
</ul>
<p>Turning that judgment into a single, objective number is exactly what GradeThread's 1.0–10.0 condition grade does — so buyers read the same thing you meant, and an honest disclosure protects you if a case is opened.</p>
<h2>4. Photograph the item well</h2>
<p>Good light and a clean background beat an expensive camera every time. Shoot the front, back, tag, and a close-up of any flaw. Photographing defects honestly does not lower your sell-through — it raises it, because the buyers who purchase already trust what they will receive.</p>
<h2>5. Price with comps, not vibes</h2>
<p>Look at <em>sold</em> listings, not active ones, and filter by a condition close to yours. Active listings tell you what sellers hope to get; sold listings tell you what buyers actually paid. Price to sell within your target window, and remember that under-pricing a great-condition item costs you just as surely as over-pricing a worn one.</p>
<h2>6. Write a listing that sells</h2>
<p>Lead the title with the brand, item type, size, and a keyword or two. Fill in every item specific the platform offers — blank fields are filters buyers use to find you. Keep the description skimmable: brand, size, measurements, condition grade, and a short list of any flaws.</p>
<h2>7. List where the buyers are</h2>
<p>eBay has the broadest clothing demand; Poshmark, Mercari, Depop, and Grailed each have their own audiences. Cross-listing multiplies your views but multiplies your busywork too — which is the problem FlipDesk exists to solve: one item, listed and synced across channels, so a sale on one takes it down on the others.</p>
<h2>8. Ship promptly, then reconcile</h2>
<p>Ship within your stated handling time — fast shipping quietly improves your standing on every platform. Afterward, track what each sale actually netted after fees and shipping. Your gross is not your profit, and knowing your real per-item margin is what turns reselling from a hobby into a business.</p>
<h2>Set realistic expectations</h2>
<p>Reselling rewards consistency more than intensity. A steady cadence of well-photographed, honestly-graded listings compounds; sporadic dumps of poorly-described items do not. Start with what you own, learn your numbers, and let the pile of skills — sourcing, grading, pricing — build one item at a time.</p>
<p>When you are ready to move faster, GradeThread grades condition for you and FlipDesk runs the whole source-to-sold pipeline in one place.</p>$html$,
  'both',
  'draft',
  'How to Start Reselling Clothes: A Beginner''s Guide',
  'A step-by-step beginner''s guide to reselling clothes — how to source inventory, grade condition honestly, price with real comps, and list faster.',
  'how to start reselling clothes',
  ARRAY['reselling clothes for beginners','how to resell clothes','start a clothing reselling business'],
  7,
  'human'
)
ON CONFLICT (slug) DO NOTHING;

-- 2/4 · How to Price Used Clothes to Sell Faster (FlipDesk, comps angle)
INSERT INTO public.blog_posts
  (slug, title, excerpt, body_html, product_focus, status,
   seo_title, seo_description, primary_keyword, secondary_keywords,
   reading_time_min, generated_by)
VALUES (
  'how-to-price-used-clothes-to-sell-faster',
  'How to Price Used Clothes to Sell Faster (Without Leaving Money on the Table)',
  'Pricing is the fastest lever a reseller controls. Here is how to read sold comps, price by condition, and use offers and markdowns to move inventory without giving it away.',
  $html$<p>Of every variable a reseller controls, price moves the needle fastest. A great photo cannot save an item priced 40% above its comps, and a bargain buried on page nine will not sell either. The good news: pricing is learnable, and most of it comes down to reading the right data.</p>
<h2>Read sold comps, not active listings</h2>
<p>The most common pricing mistake is anchoring to <em>active</em> listings — the ones that have not sold yet. Those tell you what other sellers <em>hope</em> to get. Instead, filter for <strong>sold</strong> listings of the same brand and item, then narrow to a condition close to yours. The median of recent solds is your honest market price; the spread tells you how much room you have.</p>
<h2>Price by condition, deliberately</h2>
<p>Two identical hoodies in different condition are not the same product, and buyers price them differently. A near-new piece can command the top of the comp range; a visibly worn one belongs at the bottom, disclosed clearly. This is why a consistent condition grade is a pricing tool as much as a trust tool — once you can say a garment is a 9.0 versus a 6.5, you can price against comps in the same band instead of guessing.</p>
<h2>Decide: price to sell, or price to maximize</h2>
<p>Every item sits on a spectrum. Price at the low-to-mid of the comp range and it moves quickly; price at the top and you wait for the one buyer who wants exactly that. Neither is wrong — but choose on purpose. Fast-moving basics reward volume pricing; rare or designer pieces reward patience.</p>
<h2>Use offers and markdowns as a system</h2>
<p>Accepting or sending offers is not "losing" — it is how a large share of resale sales actually close. Set a floor you will not go below (your cost plus fees plus a minimum margin), then let buyers meet you above it. Enable offers on items you are happy to move, and reserve firm pricing for pieces you can afford to hold.</p>
<h2>Let aging inventory tell you the truth</h2>
<p>An item that has sat unsold and un-watched for weeks is priced wrong for the demand it is getting — full stop. Rather than let it age indefinitely, mark it down on a schedule (for example, a small drop every couple of weeks) until it either sells or you cut it loose. Money tied up in stale inventory cannot buy your next flip.</p>
<h2>Compress the research</h2>
<p>Reading comps by hand is accurate but slow, and slow research is why most sellers skip it. FlipDesk pulls sold comps for an item in seconds, so condition-aware pricing takes moments instead of minutes — which means you actually do it on every listing, not just the expensive ones. Consistent, data-backed pricing across your whole catalog beats agonizing over a handful of items.</p>
<p>Price against real solds, adjust for condition honestly, and give aging items a nudge on a schedule. Do that consistently and your sell-through — and your cash flow — take care of themselves.</p>$html$,
  'flipdesk',
  'draft',
  'How to Price Used Clothes to Sell Faster',
  'Learn how to price used clothes to sell faster: read sold comps, price by condition, and use offers and markdowns to move inventory without underselling.',
  'how to price used clothes to sell faster',
  ARRAY['pricing used clothes','how to price clothes to sell','reseller pricing strategy'],
  5,
  'human'
)
ON CONFLICT (slug) DO NOTHING;

-- 3/4 · How to Authenticate Designer Clothes (GradeThread, authenticity angle)
INSERT INTO public.blog_posts
  (slug, title, excerpt, body_html, product_focus, status,
   seo_title, seo_description, primary_keyword, secondary_keywords,
   reading_time_min, generated_by)
VALUES (
  'how-to-authenticate-designer-clothes-before-reselling',
  'How to Authenticate Designer Clothes Before Reselling',
  'Selling designer means the authenticity bar is higher. Here is a practical checklist — tags, stitching, hardware, materials, and provenance — plus when to bring in an expert.',
  $html$<p>Reselling designer and luxury clothing is where the margins are — and where the risk is. Listing a counterfeit, even unknowingly, can get your account suspended, trigger a chargeback, and cost you the item and the sale. Authenticating before you list is not optional at this tier. Here is a practical, repeatable process.</p>
<h2>Start with the tags and labels</h2>
<p>Brand and care tags are the fastest tell. Check the font, spacing, and stitching of the main label against a verified reference for that brand and era — logos drift over the decades, and counterfeiters rarely get the current details exactly right. Care tags should list accurate fabric content, a country of origin consistent with the brand, and often a style or RN number you can cross-reference.</p>
<h2>Inspect stitching and construction</h2>
<p>Luxury construction is consistent. Look for straight, even stitching with no loose threads, matched patterns across seams, and clean interior finishing. Sloppy or uneven stitching, glue where there should be stitches, or a rushed interior are strong red flags.</p>
<h2>Examine the hardware</h2>
<p>Zippers, buttons, rivets, and clasps are expensive to fake well. Genuine hardware feels substantial, operates smoothly, and is usually branded with crisp, correctly-spelled engraving. Lightweight, rough, or misspelled hardware is a common giveaway.</p>
<h2>Check the materials</h2>
<p>Real leather, wool, and quality cotton have a distinct hand and smell that synthetics imitating them do not. If a piece claims a premium material but feels plasticky or reeks of chemicals, treat the claim skeptically.</p>
<h2>Look for provenance</h2>
<p>Original receipts, dust bags, authenticity cards, and serial numbers add confidence — though none is proof on its own, since packaging is faked too. Provenance is a supporting signal, strongest when it lines up with everything else you have inspected.</p>
<h2>Know the red flags</h2>
<p>A price that is too good to be true usually is. Be wary of sellers who cannot photograph tags and hardware, "authentic inspired" language, or details that contradict each other (a modern logo on a supposedly vintage piece). When two or more signals disagree, walk away.</p>
<h2>When to bring in an expert</h2>
<p>For high-value pieces, a paid third-party authentication service is cheap insurance against a suspended account. For everything else, document your own inspection thoroughly and disclose exactly what you checked.</p>
<h2>Disclose your confidence honestly</h2>
<p>Authentication is rarely 100% certain from photos alone, and buyers respect a seller who says so. This is the same principle behind GradeThread's premium authenticity signal, which surfaces a counterfeit-risk read alongside the condition grade — a supporting data point, distinct from the condition score, that you disclose rather than overstate. Whatever tools you use, the rule is the same: verify before you list, and never claim more certainty than you have.</p>$html$,
  'gradethread',
  'draft',
  'How to Authenticate Designer Clothes Before Reselling',
  'A practical checklist to authenticate designer clothes before reselling — tags, stitching, hardware, materials, and provenance — plus when to use an expert.',
  'how to authenticate designer clothes',
  ARRAY['authenticate designer clothing','spot fake designer clothes','designer resale authentication'],
  6,
  'human'
)
ON CONFLICT (slug) DO NOTHING;

-- 4/4 · How to Clean and Prepare Used Clothes for Resale (GradeThread, cleanliness)
INSERT INTO public.blog_posts
  (slug, title, excerpt, body_html, product_focus, status,
   seo_title, seo_description, primary_keyword, secondary_keywords,
   reading_time_min, generated_by)
VALUES (
  'how-to-clean-and-prepare-used-clothes-for-resale',
  'How to Clean and Prepare Used Clothes for Resale',
  'Presentation sells, and odor is a top return reason. Here is how to clean, de-odorize, de-pill, and steam used clothes for resale — without damaging vintage.',
  $html$<p>A clean, well-presented garment photographs better, sells for more, and comes back less often. Odor and dirt are among the most common reasons a buyer opens a return — and they are almost entirely preventable. Here is how to prepare used clothing so it arrives the way your listing promised.</p>
<h2>Clean according to the fabric</h2>
<p>Read the care tag first, then respect it. Most cottons and synthetics are safe to machine wash cold and hang or lay flat to dry. Wool, silk, and structured pieces often need hand-washing or dry cleaning. When a tag is missing or illegible, err on the gentle side — you cannot un-shrink a sweater.</p>
<h2>Kill odors, do not just mask them</h2>
<p>Smoke, must, and the general "thrift smell" need neutralizing, not perfume over the top. An airing-out in fresh air, a wash with an odor-eliminating additive, or a stint with baking soda in a sealed bag all work better than fabric spray. Confirm the smell is actually gone before you photograph — odor is something buyers cannot see in your listing but absolutely notice on arrival.</p>
<h2>De-pill, de-lint, and steam</h2>
<p>A fabric shaver removes the pilling that makes a good garment look tired, and a lint roller clears the fuzz and pet hair that cameras love to highlight. A quick steam relaxes wrinkles and makes a piece look cared-for in photos — a small step that noticeably lifts perceived value.</p>
<h2>Spot-treat stains carefully</h2>
<p>Address minor marks with an appropriate spot treatment for the fabric, and test on a hidden area first. If a stain will not come out, do not hide it — photograph and disclose it, and price accordingly. A disclosed flaw is a fair sale; a concealed one is a return waiting to happen.</p>
<h2>Know when not to alter</h2>
<p>Vintage is the exception. Aggressive cleaning, pressing, or repairs can strip value from a genuinely old garment, and some distressing is a feature buyers want, not damage to fix. When in doubt on a vintage piece, clean minimally and let the condition speak for itself.</p>
<h2>Do a final inspection — then grade</h2>
<p>Cleaning is also your best chance to catch flaws you missed at sourcing: a small hole, a stressed seam, a faded panel. Give every prepared garment one last look against the condition factors — fabric, structure, cosmetic, functional, and cleanliness — before it goes in the photo queue. That is precisely the inspection GradeThread turns into an objective 1.0–10.0 grade, so the condition you worked to achieve is the condition your buyer reads.</p>
<h2>Photograph while it is fresh</h2>
<p>Shoot immediately after prep, while the garment is clean, steamed, and lint-free. A well-prepared item in honest light is the single cheapest upgrade you can make to your sell-through — and it starts the buyer's experience on the same note it will end on.</p>$html$,
  'gradethread',
  'draft',
  'How to Clean and Prepare Used Clothes for Resale',
  'How to clean and prepare used clothes for resale: washing by fabric, killing odors, de-pilling, steaming, spot-treating stains, and protecting vintage.',
  'how to clean clothes for resale',
  ARRAY['preparing clothes for resale','clean thrifted clothes','remove odor from used clothes'],
  5,
  'human'
)
ON CONFLICT (slug) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- PART 2 — Remaining research titles → content_topics bank (queued)
-- ══════════════════════════════════════════════════════════
-- Re-angled to GradeThread/FlipDesk. Deduped vs the existing bank (00192) on
-- (surface, product_focus, lower(primary_keyword)). All surface='blog'.

WITH candidates (surface, product_focus, title, angle, primary_keyword, secondary_keywords, search_intent) AS (
  VALUES
  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$The Best App for Selling Used Clothes in 2026: An Honest Comparison$t$,
   $t$Comparison post that meets the highest-intent query head-on. Weigh eBay/Poshmark/Mercari/Depop by audience, fees, and effort — then position a grading-backed, cross-listing workflow as the layer that sits above whichever apps you choose.$t$,
   'best app for selling used clothes',
   ARRAY['best resale app','where to sell used clothes online','clothing resale apps compared'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Depop vs Poshmark: Which Should You Use (and Why Not Both)?$t$,
   $t$Head-to-head for the two social-resale giants: audience, demographics, fee structure, and listing culture. Land on cross-listing to both, with a mapping of how the same garment's condition should be described on each.$t$,
   'depop vs poshmark',
   ARRAY['depop or poshmark','poshmark vs depop fees','best app for selling clothes'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Can You Actually Make Money Reselling Clothes Online?$t$,
   $t$Honest answer to the skeptic's query. What drives the margin (sourcing cost, fees, time), what a realistic first-90-days looks like, and why consistency beats luck. No invented income figures.$t$,
   'can you make money reselling clothes',
   ARRAY['is reselling clothes worth it','reselling clothes income','make money selling used clothes'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Best Places to Find Clothes to Resell (Beyond the Thrift Store)$t$,
   $t$Sourcing map for beginners and plateaued sellers: thrift, estate sales, outlets, wholesale/bulk, liquidation, and your own closet. Emphasize checking comps before buying, whatever the source.$t$,
   'best places to find clothes to resell',
   ARRAY['where to source clothes to resell','sourcing inventory reselling','cheap clothes to flip'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How Much Money Can You Realistically Make Reselling Clothes?$t$,
   $t$Model the levers instead of promising numbers: items listed per week, sell-through, average sale price, and margin after fees. Give the reader a framework to estimate their own ceiling.$t$,
   'how much money reselling clothes',
   ARRAY['reselling clothes income','reseller earnings','average reseller profit'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Mercari vs Poshmark vs eBay for Clothing: Which Wins for You?$t$,
   $t$Three-way clothing-specific comparison: audience size, fees, shipping models, and buyer behavior. Recommend by seller type, then show how cross-listing removes the either/or.$t$,
   'mercari vs poshmark vs ebay clothing',
   ARRAY['best platform to sell clothes','ebay vs poshmark vs mercari','resale platform comparison'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Resell Clothes Around a Full-Time Job$t$,
   $t$Time-boxed systems for the 9-to-5 reseller: batch sourcing on weekends, photograph in bulk, draft with AI, publish on a daily cadence. Realistic throughput, not hustle-culture promises.$t$,
   'reselling clothes with a full time job',
   ARRAY['side hustle reselling clothes','part time reselling','reselling schedule'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$What Clothes Sell Best on Resale Apps Right Now?$t$,
   $t$Demand-side guide: categories and attributes with reliable turnover (activewear, denim, outerwear, specific brand tiers). Frame around checking comps rather than chasing hype.$t$,
   'what clothes sell best resale apps',
   ARRAY['best clothes to resell','what sells best on poshmark','high demand resale clothing'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   $t$How to Write Clothing Descriptions That Actually Sell$t$,
   $t$Copywriting for listings that convert: lead with brand/size/keywords, front-load measurements and condition, keep it skimmable. Contrast a wall-of-text blurb with a grade-plus-flaws format.$t$,
   'how to write clothing descriptions that sell',
   ARRAY['listing description tips','how to describe used clothes','ebay clothing description'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Is Reselling Clothes Still Profitable in 2026?$t$,
   $t$Address the "is the market saturated" fear directly. Where margin still lives (sourcing edge, condition trust, speed), and where it has thinned. Honest and current, no invented stats.$t$,
   'is reselling clothes profitable',
   ARRAY['is reselling clothes worth it 2026','resale market saturated','reselling profit margins'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Which Resale App Pays Out the Fastest?$t$,
   $t$Cash-flow-focused comparison of payout timing across the major platforms, and why reconciling payouts against your sales matters as volume grows.$t$,
   'resale app fastest payout',
   ARRAY['poshmark payout time','mercari payout','when do resale apps pay you'],
   'commercial'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   $t$How to Take Better Photos of Clothes to Sell$t$,
   $t$General product-photography guide (distinct from defect photography): light, background, flat-lay vs hanger vs model, the required shot list, and consistency across a catalog.$t$,
   'how to photograph clothes to sell',
   ARRAY['clothing photography tips','how to photograph clothes for resale','ebay photo tips'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Reselling Clothes Full-Time: What It Really Takes$t$,
   $t$For the career-change reader: the throughput, systems, and financial runway required to replace a salary. Sober math on listings/day and sell-through, plus the operational load automation removes.$t$,
   'reselling clothes full time',
   ARRAY['full time reseller','quit job to resell','reselling as a career'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Ship Clothes Cheaply and Protect Your Margins$t$,
   $t$Shipping tactics that preserve profit: right-sizing packaging, poly mailers vs boxes, weight-based service selection, and building shipping into your price. Margin-first framing.$t$,
   'how to ship clothes cheaply reselling',
   ARRAY['cheapest way to ship clothes','reseller shipping supplies','shipping costs reselling'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$What Brands Resell Best: A Tiered Bolo Guide$t$,
   $t$Brands-to-know reference organized by tier (entry, mid, premium, grail), with the construction and tag tells that separate a flip from a pass. Sourcing-floor decision aid.$t$,
   'best brands to resell',
   ARRAY['brands that resell well','bolo brands list','best clothing brands to flip'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How Long Does It Really Take to Sell Used Clothes?$t$,
   $t$Set expectations on time-to-sale: what drives it (price vs comps, photo quality, item specifics, demand), typical ranges by category, and when a slow item is really a pricing signal.$t$,
   'how long to sell used clothes',
   ARRAY['average time to sell on poshmark','sell through rate clothing','how fast do clothes sell online'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Should You Cross-List to Multiple Apps at Once?$t$,
   $t$The multi-platform question answered with tradeoffs: more views vs more busywork and the risk of double-selling. Make the case that cross-listing only works with sync that de-lists on sale.$t$,
   'reselling on multiple apps',
   ARRAY['cross listing clothes','crosslist poshmark mercari','multi platform reselling'],
   'commercial'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   $t$Best Resale Apps for Designer and Luxury Clothing$t$,
   $t$Platform guide for the high-end tier where authentication and condition trust decide the sale. Compare luxury-focused marketplaces and general apps, and why a documented condition + authenticity read raises price.$t$,
   'best resale apps designer clothing',
   ARRAY['where to sell designer clothes','luxury resale platforms','sell high end clothing online'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Handle Returns and Disputes When Reselling Clothes$t$,
   $t$Operational playbook for when a return or case happens (distinct from preventing them): reading the reason, responding, when to accept, and how timestamped condition evidence protects you.$t$,
   'how to handle returns reselling clothes',
   ARRAY['ebay return clothing','poshmark case','handling resale disputes'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Thrifting vs Online Sourcing: Where Should You Buy Inventory?$t$,
   $t$Compare in-person thrifting against online sourcing (liquidation, wholesale, other resellers) on cost, time, scalability, and risk. Help the reader pick a mix that fits their hours.$t$,
   'thrifting vs online sourcing',
   ARRAY['sourcing inventory to resell','online sourcing reselling','where to buy resale inventory'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Is Facebook Marketplace Good for Selling Clothes?$t$,
   $t$Evaluate FB Marketplace for clothing: local no-fee sales vs lowballers and no buyer protection. Where it fits (bulky, local, bundles) and where the dedicated resale apps win.$t$,
   'facebook marketplace selling clothes',
   ARRAY['sell clothes on facebook marketplace','facebook marketplace vs poshmark','local selling clothes'],
   'commercial'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   $t$How to Price Vintage and Thrifted Clothes Correctly$t$,
   $t$Valuation for pieces with thin or no comps: reading era/construction tells, rarity, and condition on the vintage scale (as-made vs acquired defects). Avoid both under- and over-pricing.$t$,
   'how to price vintage clothes',
   ARRAY['pricing vintage clothing','how to value thrifted clothes','vintage resale value'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$What Fees Do Clothing Resale Apps Charge? A Full Breakdown$t$,
   $t$Transparent per-platform fee comparison (selling fee, payment processing, shipping treatment) with a worked net-payout example. Ends on why tracking real net per item matters.$t$,
   'clothing resale app fees',
   ARRAY['poshmark fees','mercari fees','ebay selling fees clothing'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Ship Bulky and Heavy Clothing Without Killing Profit$t$,
   $t$Logistics for coats, boots, and heavy denim: compression, service selection by weight, calculated vs flat shipping, and pricing shipping realistically so a heavy item still nets.$t$,
   'shipping bulky heavy clothing',
   ARRAY['shipping heavy clothes','how to ship coats','reselling shipping heavy items'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Best Resale Platforms for Fast Fashion Brands$t$,
   $t$Where mainstream/fast-fashion labels actually move, given their lower price points. Volume-and-velocity strategy, bundling, and setting a realistic floor after fees.$t$,
   'best resale platform fast fashion',
   ARRAY['sell fast fashion online','reselling zara h&m','where to sell mall brands'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Resell Kids' Clothes Online (and Actually Profit)$t$,
   $t$Niche guide for the children's category: bundling by size, the brands that hold value, condition expectations for well-worn kidswear, and platforms where parents buy.$t$,
   'how to resell kids clothes',
   ARRAY['selling used baby clothes','reselling childrens clothing','bundle kids clothes to sell'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Can You Make Money Reselling Clothes on TikTok Shop?$t$,
   $t$Evaluate TikTok Shop and live selling for clothing: discovery upside, the content workload, fees, and how it complements — rather than replaces — a listing-based catalog.$t$,
   'reselling clothes on tiktok',
   ARRAY['tiktok shop clothes','selling clothes on tiktok live','tiktok reselling'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Spot Underpriced Clothes to Flip for Profit$t$,
   $t$Sourcing-eye training: brand/fabric/construction tells that signal value on a crowded rack, and the on-the-spot comp check that turns a hunch into a confident buy.$t$,
   'how to find underpriced clothes to resell',
   ARRAY['spotting valuable clothes thrifting','what to look for thrifting to resell','undervalued clothes to flip'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$What Documentation Do You Need to Resell Clothes Legally?$t$,
   $t$Plain-language overview of the paperwork side: business registration basics, sales tax considerations, and record-keeping for income and expenses. Explicit "not legal/tax advice" framing; cite official sources only.$t$,
   'documentation to resell clothes',
   ARRAY['do you need a business license to resell','reseller record keeping','legal requirements reselling clothes'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Build a Reselling Business From Your Own Closet$t$,
   $t$Zero-inventory-cost start: audit your closet, identify what has resale value, learn the full list-ship-reconcile loop on items you already own, then reinvest into sourcing.$t$,
   'start reselling from your closet',
   ARRAY['sell your own clothes online','declutter and resell','start reselling no money'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$The Best Time of Year to Sell Used Clothes Online$t$,
   $t$Seasonality guide: when demand peaks by category, listing ahead of the season, and using seasonal cadence to time both sourcing and markdowns.$t$,
   'best time to sell used clothes',
   ARRAY['seasonal reselling','when to list winter coats','best month to sell clothes online'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Avoid Scams When Sourcing Resale Inventory$t$,
   $t$Buyer-side safety for resellers: red flags in bulk/wholesale deals, counterfeit lots, payment-method protection, and verifying a supplier before wiring money.$t$,
   'avoid scams sourcing resale inventory',
   ARRAY['wholesale clothing scams','fake liquidation pallets','safe sourcing reselling'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Poshmark Closet vs Standalone Shop: Which Sells More?$t$,
   $t$Strategy post for Poshmark sellers weighing a personal closet against a more shop-like presentation: sharing, followers, and consistency, and how volume plus cross-listing compounds either way.$t$,
   'poshmark closet vs shop',
   ARRAY['grow poshmark closet','poshmark selling strategy','poshmark shares and sales'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Scale a Clothing Reselling Business Past the Side-Hustle$t$,
   $t$Growth systems for the plateaued reseller: batching, standard operating procedures, inventory location tracking, hiring help, and the tooling that raises listings-per-week without raising hours.$t$,
   'how to scale reselling business',
   ARRAY['grow reselling business','reseller systems and processes','scaling ebay store'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$What to Do With Clothes That Won't Sell$t$,
   $t$Dead-inventory playbook: diagnose why (price, photos, demand), then the exit ladder — reprice, refresh, bundle, cross-list, donate, or liquidate — so capital stops sitting still.$t$,
   'what to do with unsold clothes',
   ARRAY['unsold inventory reselling','clothes that wont sell','liquidate resale inventory'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Negotiate Better Prices When Sourcing Clothes$t$,
   $t$Buy-side negotiation for resellers: bulk and bundle asks at estate sales and with suppliers, reading a seller's motivation, and walk-away discipline that protects your margin.$t$,
   'negotiate prices sourcing resale',
   ARRAY['negotiate at estate sales','bulk buying clothes to resell','sourcing cost reduction'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Storage Solutions That Keep Reseller Inventory Findable$t$,
   $t$Physical-organization guide tied to digital tracking: bin-and-label systems, SKU-to-location mapping, and photographing intake so an item never gets lost between "sold" and "ship".$t$,
   'reseller inventory storage',
   ARRAY['organize reselling inventory','reseller bin system','inventory location tracking'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$Niche Clothing Categories That Quietly Resell Well$t$,
   $t$Beyond the obvious brands: overlooked categories (workwear, specialty athletic, uniforms, adaptive, big-and-tall) with steady demand and less competition.$t$,
   'niche clothing categories resell',
   ARRAY['underrated clothes to resell','profitable clothing niches','less competitive resale categories'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   $t$The Environmental Case for Reselling Clothes$t$,
   $t$Sustainability angle with substance: how resale extends garment lifecycles and displaces new production, and how honest condition grading keeps items in circulation instead of landfills by making used feel safe to buy.$t$,
   'environmental impact reselling clothes',
   ARRAY['sustainable fashion resale','is reselling clothes sustainable','circular fashion reselling'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   $t$How to Handle Difficult Buyers Without Losing Your Rating$t$,
   $t$Customer-service playbook: defusing lowball and complaint messages, when to hold your policy vs make it right, and how clear condition disclosure prevents most conflicts before they start.$t$,
   'how to handle difficult buyers reselling',
   ARRAY['dealing with difficult buyers','reseller customer service','protect seller rating'],
   'informational')
)
INSERT INTO public.content_topics
  (surface, product_focus, title, angle, primary_keyword, secondary_keywords,
   search_intent, status, generated_by, source)
SELECT
  c.surface, c.product_focus, c.title, c.angle, c.primary_keyword,
  c.secondary_keywords::text[], c.search_intent,
  'queued'::public.topic_status,
  'human'::public.content_generated_by,
  'manual'::public.content_topic_source
FROM candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM public.content_topics t
  WHERE t.surface = c.surface
    AND t.product_focus = c.product_focus
    AND lower(t.primary_keyword) = lower(c.primary_keyword)
);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00378')
ON CONFLICT (version) DO NOTHING;
