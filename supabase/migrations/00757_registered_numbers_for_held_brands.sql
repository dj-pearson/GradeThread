-- US-3125: registered numbers for 80 brands the KB already held without one.
--
-- Deepening run 2. 170 held brands seeded before 00480 had no registered
-- number, because scripts/ops/ftc-rn-lookup.mjs did not exist when they were
-- written. All 170 were looked up on 2026-09-07 and judged by the rules this
-- loop built across 00743 to 00755.
--
-- Result: 80 brands gain 91 numbers. 86 are refused, and the
-- refusals are as much the point as the acceptances.
--
-- -- HOW THE 80 WERE JUDGED, IN TWO TIERS -----------------------------------
--
-- TIER A (66 brands). The registrant is the label plus purely generic trade
-- words -- Inc, LLC, Ltd, Corp, Group, USA, North America, Apparel. Defensible
-- from the registrant string alone, which is the standard every earlier
-- migration in this series used.
--
-- TIER B (14 brands). Accepted using knowledge of the company's LEGAL NAME,
-- which the string alone does not establish. These are listed explicitly so a
-- reader can audit exactly these and no others:
--
--     Burberry            BURBERRY'S INTERNATIONAL LTD    the possessive-era name
--     Coach               COACH SERVICES, INC.            Coach's own IP entity
--     Dior                CHRISTIAN DIOR                  the label's full name
--     Dr. Martens         DR. MARTENS AIR WAIR USA        AirWair is the maker
--     Filson              C. C. FILSON                    the founder's initials
--     Hollister           JM HOLLISTER LLC                the A&F subsidiary
--     Kith                KITH RETAIL LLC
--     Madewell            MADEWELL USA INC
--     Mammut              MAMMUT SPORTS GROUP, INC
--     Marmot              MARMOT MOUNTAIN LLC
--     Nautica             Nautica OpCo LLC
--     New Balance         NEW BALANCE ATHLETIC SHOE, INC.
--     Pendleton           PENDLETON WOOLEN MILLS
--     The Children's Place  THE CHILDREN'S PLACE SERVICES COMPANY, LLC
--
-- A tier-B row is not a guess, but it IS a weaker claim than a tier-A row, and
-- collapsing the two would hide that.
--
-- -- MADEWELL IS THE VINTAGE RULE'S BEST CASE YET ----------------------------
--
-- The register returns four Madewells: MADEWELL CO at RN 24742, MADEWELL LTD at
-- 51284, MADEWELL MFG CO at 15401, and MADEWELL USA INC at 171548. The first
-- three are the ORIGINAL Madewell, a 1937 workwear manufacturer. The brand in
-- this KB is J.Crew's, relaunched in 2006 after buying the name. Only 171548 can
-- belong to it. Without the 00750 rule this is four indistinguishable hits; with
-- it there is one answer.
--
-- -- WHY 86 ARE REFUSED ------------------------------------------------------
--
-- 33 return NOTHING from the register at all.
--
-- The rest return hits that do not keep the label, and the pattern is that a
-- ONE-WORD brand name is nearly unusable in a substring register. Lee returns
-- LEE-KAY'S, MINDI-LEE, MARY-LEE and SAL-LEE. Express returns T-EXPRESS,
-- A-EXPRESS and PEOPLES MOVING & EXPRESS. Jordan, Brooks, Celine, Chanel,
-- Columbia, Mother, Paige, Palace, Pink, Supreme and Theory's competitors are
-- all the same shape. These are common words, so the register is full of
-- unrelated companies containing them, and none of it is evidence.
--
-- Three refusals are worth naming individually:
--
--   Levi's       -> LEVI'S PLAZA. That is a BUILDING in San Francisco, not a
--                   garment maker. The most convincing-looking hit in the batch.
--   Longchamp    -> LONGCHAMP FABRICS CORP at RN 17257, which is the trap this
--                   KB is already named after, and the number is far too early
--                   for the French house's US registration in any case.
--   American Eagle -> five registrants share the phrase (AMERICAN EAGLE LTD,
--                   OUTFITTERS, INDUSTRIES CORP, APPAREL GROUP, STAR IMPORTS).
--                   AMERICAN EAGLE OUTFITTERS, INC. is very probably right, and
--                   "very probably" is what this series refuses on.
--
-- -- THE NOT VALID CONSTRAINT, HANDLED THE SAME WAY 00748 DID ----------------
--
-- brand_knowledge_tag_eras_sourced never inspected the rows that already
-- existed, but Postgres checks any row an UPDATE touches -- so writing a
-- registered number to a 2026-07 brand row fails on a constraint about eras.
-- 00748 hit this with two rows; this migration touches 80.
--
-- Same narrow fix, same reasoning: each datable era inherits the source_url and
-- confidence the ROW already asserts, which restates an existing claim rather
-- than inventing a citation. Only rows this migration updates are touched.
-- US-3126 still owns the other 80-odd.

do $$
begin
  update public.brand_knowledge k
     set tag_eras = (
       select jsonb_agg(
                case when coalesce(e ->> 'years', '') ~ '(\d{4}|\d0s)'
                      and (coalesce(e ->> 'source_url', '') = ''
                           or jsonb_typeof(e -> 'confidence') is distinct from 'number')
                     then e || jsonb_build_object('source_url', k.source_url,
                                                  'confidence', k.confidence)
                     else e end)
         from jsonb_array_elements(k.tag_eras) e)
   where k.brand_key in ('7forallmankind','abercrombiefitch','adidas','aeropostale','anntaylor','aritzia','birkenstock','bogner','bonobos','brooksbrothers','burberry','calvinklein','canadagoose','champion','chromehearts','citizensofhumanity','coach','converse','crocs','denimtears','diesel','dior','dooneybourke','drmartens','fearofgod','fendi','fila','filson','gap','gildan','girlfriendcollective','guess','gymboree','harleydavidson','hellyhansen','hollister','janieandjack','jcrew','joesjeans','katespade','keen','kith','louisvuitton','madewell','mammut','marmot','michaelkors','moncler','mountainhardwear','nautica','newbalance','nike','oldnavy','orvis','outdoorresearch','pendleton','prada','puma','ragbone','ralphlauren','rebeccaminkoff','reebok','rhude','saucony','spanx','stevemadden','talbots','thechildrensplace','theory','timberland','tommyhilfiger','toryburch','tumi','underarmour','uniqlo','verabradley','versace','victoriassecret','vineyardvines','yeezy')
     and not public.tag_eras_all_sourced(k.tag_eras);

  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 115561']::text[]
   where brand_key = '7forallmankind' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 75654']::text[]
   where brand_key = 'abercrombiefitch' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 88387']::text[]
   where brand_key = 'adidas' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 121726']::text[]
   where brand_key = 'aeropostale' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 61422']::text[]
   where brand_key = 'anntaylor' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 122354']::text[]
   where brand_key = 'aritzia' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 146157']::text[]
   where brand_key = 'birkenstock' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 54198','RN 65625']::text[]
   where brand_key = 'bogner' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 128054']::text[]
   where brand_key = 'bonobos' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 99458']::text[]
   where brand_key = 'brooksbrothers' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 31750']::text[]
   where brand_key = 'burberry' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 41327','RN 42642']::text[]
   where brand_key = 'calvinklein' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 153934']::text[]
   where brand_key = 'canadagoose' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 97745']::text[]
   where brand_key = 'champion' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 97729']::text[]
   where brand_key = 'chromehearts' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 109670']::text[]
   where brand_key = 'citizensofhumanity' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 132154']::text[]
   where brand_key = 'coach' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 116304']::text[]
   where brand_key = 'converse' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 120446']::text[]
   where brand_key = 'crocs' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 162838']::text[]
   where brand_key = 'denimtears' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 84556','RN 93243']::text[]
   where brand_key = 'diesel' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 143628']::text[]
   where brand_key = 'dior' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 61689']::text[]
   where brand_key = 'dooneybourke' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 97497']::text[]
   where brand_key = 'drmartens' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 139190']::text[]
   where brand_key = 'fearofgod' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 146779']::text[]
   where brand_key = 'fendi' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 91175']::text[]
   where brand_key = 'fila' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 39126']::text[]
   where brand_key = 'filson' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 54023']::text[]
   where brand_key = 'gap' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 145424']::text[]
   where brand_key = 'gildan' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 149694']::text[]
   where brand_key = 'girlfriendcollective' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 62136']::text[]
   where brand_key = 'guess' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 70530']::text[]
   where brand_key = 'gymboree' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 103819']::text[]
   where brand_key = 'harleydavidson' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 73983']::text[]
   where brand_key = 'hellyhansen' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 102573']::text[]
   where brand_key = 'hollister' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 164971']::text[]
   where brand_key = 'janieandjack' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 137457']::text[]
   where brand_key = 'jcrew' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 106214']::text[]
   where brand_key = 'joesjeans' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 102760']::text[]
   where brand_key = 'katespade' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 131197']::text[]
   where brand_key = 'keen' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 140659','RN 163211']::text[]
   where brand_key = 'kith' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 167033']::text[]
   where brand_key = 'louisvuitton' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 171548']::text[]
   where brand_key = 'madewell' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 117481']::text[]
   where brand_key = 'mammut' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 67013','RN 79448']::text[]
   where brand_key = 'marmot' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 111818']::text[]
   where brand_key = 'michaelkors' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 105349','RN 116347']::text[]
   where brand_key = 'moncler' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 89674']::text[]
   where brand_key = 'mountainhardwear' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 67835','RN 167346']::text[]
   where brand_key = 'nautica' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 96937']::text[]
   where brand_key = 'newbalance' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 41996','RN 56323']::text[]
   where brand_key = 'nike' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 160476']::text[]
   where brand_key = 'oldnavy' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 70534']::text[]
   where brand_key = 'orvis' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 97085']::text[]
   where brand_key = 'outdoorresearch' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 29685']::text[]
   where brand_key = 'pendleton' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 98339']::text[]
   where brand_key = 'prada' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 62200']::text[]
   where brand_key = 'puma' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 108879']::text[]
   where brand_key = 'ragbone' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 41381']::text[]
   where brand_key = 'ralphlauren' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 129083']::text[]
   where brand_key = 'rebeccaminkoff' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 69421']::text[]
   where brand_key = 'reebok' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 163181']::text[]
   where brand_key = 'rhude' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 97075']::text[]
   where brand_key = 'saucony' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 112121']::text[]
   where brand_key = 'spanx' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 128692']::text[]
   where brand_key = 'stevemadden' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 76216']::text[]
   where brand_key = 'talbots' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 59284']::text[]
   where brand_key = 'thechildrensplace' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 98406']::text[]
   where brand_key = 'theory' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 57747']::text[]
   where brand_key = 'timberland' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 76922','RN 77806']::text[]
   where brand_key = 'tommyhilfiger' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 111395']::text[]
   where brand_key = 'toryburch' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 108996']::text[]
   where brand_key = 'tumi' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 96510']::text[]
   where brand_key = 'underarmour' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 115307','RN 139864']::text[]
   where brand_key = 'uniqlo' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 156007']::text[]
   where brand_key = 'verabradley' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 118621']::text[]
   where brand_key = 'versace' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 70817']::text[]
   where brand_key = 'victoriassecret' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 134578']::text[]
   where brand_key = 'vineyardvines' and cardinality(registered_numbers) = 0;
  update public.brand_knowledge
     set registered_numbers = ARRAY['RN 155534','RN 177983']::text[]
   where brand_key = 'yeezy' and cardinality(registered_numbers) = 0;
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00757') on conflict do nothing;
