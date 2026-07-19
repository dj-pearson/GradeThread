# Poshmark Integration — Go/No-Go Decision (US-715)

> **Decision: NO-GO on Rithum/Brand Closet for now. Route Poshmark coverage to the
> user-side browser-extension path ([[US-716]]).** This is a `[NO-CODE]` BizDev/Decision
> deliverable — a documented founder decision, not shippable code. Revisit the go/no-go
> when (and only when) the threshold in §2 is met.

Source research: `vault/30-platform/cross-listing.md` §3 ("Poshmark — only the enterprise door, via
Rithum/DSCO") and Phase 2 ("Decide on Poshmark"). Feeds [[US-716]] (extension companion)
and [[US-718]] (Marketplaces UI / plan-copy truthfulness).

---

## 1. The situation (why this decision exists)

Poshmark has **no public developer write-API**. There are exactly two sanctioned ways to
reach it, and one unsanctioned way we refuse to build:

1. **Enterprise: Rithum / CommerceHub DSCO "Brand Closet" program.** The only path with a
   real developer API (developer.channeladvisor.com) that includes Poshmark. Enterprise-
   priced, ~2–3 week DSCO onboarding, listing creation stays largely manual.
2. **User-side browser extension** ("GradeThread Lister") that posts to Poshmark using the
   *user's own* logged-in session — the model Vendoo / List Perfectly use. Legally cleaner
   (the user automates their own account), but we own the engineering burden of tracking
   Poshmark's UI changes. This is [[US-716]].
3. **❌ Server-side scraping with stored user cookies — explicitly ruled out (see §4).**

---

## 2. Go/No-Go threshold and verdict

**Threshold to pursue Rithum (from `vault/30-platform/cross-listing.md` Phase 2 — ALL must hold):**

- [ ] ≥ **1 customer doing > $50k/year in Poshmark GMV**, AND
- [ ] that customer **commits to GradeThread for ≥ 12 months**, AND
- [ ] we can **charge them enough to cover the Rithum seat** — assume **$1,500–$3,000/month
      per customer**, or an equivalent revenue-share.

If all three are not simultaneously true, **skip Poshmark via Rithum entirely.**

### Verdict (as of 2026-06-13): **NO-GO**

| Threshold condition | Status today | Met? |
|---|---|---|
| ≥1 customer > $50k/yr Poshmark GMV | Pre-launch; no such customer identified | ❌ |
| ≥12-month commitment from that customer | No signed commitment exists | ❌ |
| Can charge ≥ Rithum seat ($1.5k–3k/mo) | No customer at a price tier that absorbs this | ❌ |

None of the three conditions is met. GradeThread is pre-launch with no enterprise Poshmark
seller under a 12-month, $1.5k–3k/mo (or rev-share) commitment. Committing to a Rithum seat
now would mean carrying a low-five-figures/yr enterprise cost (plus rev-share / GMV fees)
with no customer to cover it — a clear no.

**→ Poshmark coverage routes to the user-side extension path ([[US-716]]) instead** (see §5).

---

## 3. Rithum onboarding reality (acceptance criterion #2 — what we'd be signing up for)

Documented so a future re-evaluation starts from facts, not optimism:

- **Onboarding is slow and gated.** Apply to Poshmark Brand Closet → Poshmark runs
  enterprise-seller onboarding → **DSCO emails an invitation** → complete DSCO + CommerceHub
  onboarding (incl. "Gandalf" testing) → DSCO issues API keys → connection live. SellerChamp's
  docs put the integration at **~2–3 weeks**.
- **Listing creation stays largely manual.** Per SellerChamp: *"the listing process on
  Poshmark is largely manual due to DSCO integration limitations. While [the tool] can update
  quantity and price, other product details will need to be manually updated directly on
  Poshmark."* DSCO syncs **qty/price/orders** — it does **not** give us clean programmatic
  listing creation. Sellers download Poshmark reports, fill missing fields, and re-upload.
  So even with Rithum, we would NOT get the one-draft-fan-out experience we get from
  eBay/Shopify/Depop APIs.
- **It's enterprise-gated and discretionary.** The named partners on Poshmark's Brands page
  are Rithum/ChannelAdvisor and CommerceHub. Intended for brands, consignment stores, and
  large multi-brand resellers — **not** typical SaaS-side integrations. Even with Rithum as
  integrator, **Poshmark can decline to onboard a SaaS partner.** Plan for an approval
  conversation, not a self-service signup.
- **Pricing is enterprise / opaque.** Rithum publishes no price list. Sellers report **low
  five figures per year minimum, plus revenue-share / GMV fees**. Budget ~$1.5k–3k/mo per
  customer as the seat cost we'd need to recover (the §2 threshold).

---

## 4. Explicitly ruled OUT: server-side scraping / stored-cookie automation (acceptance criterion #3)

**We will NOT build server-side browser automation or stored-cookie scraping of Poshmark.**
This is a hard line, not a preference:

- **ToS violation.** Poshmark's Terms (§ User Conduct) explicitly forbid *"use [of] any
  automated means or interface not provided by us to access the Service."* Server-side
  automation of Poshmark is non-sanctioned automation by definition.
- **Legal exposure is real:** CFAA (unauthorized access), DMCA §1201 (if any access control
  is circumvented), and breach-of-contract under Poshmark's ToS. Running it on **our**
  servers with **stored user cookies** makes GradeThread the actor — the worst posture.
- **Operational fragility.** Poshmark actively bans automation and ships anti-automation
  checks; a server-side scraper breaks constantly and puts seller accounts at ban risk.
- The only tolerated automation model is **the user automating their own account in their own
  browser** — which is the extension path ([[US-716]]), not a server-side scraper.

This applies equally to Mercari and Grailed and is consistent with the project's
sanctioned-integration-first posture (eBay/Shopify/Depop all built against official APIs).

---

## 5. Consequence of NO-GO (acceptance criterion #4 — routing)

- **Poshmark coverage → user-side extension path ([[US-716]]).** The "GradeThread Lister"
  Chrome-extension companion runs in the seller's own browser, accepts a listing payload from
  the SaaS via `chrome.runtime.onMessageExternal`, and posts it to Poshmark using the user's
  own session. Same model extend-able to Mercari and Grailed ([[US-716]]).
- **Marketplaces UI / plan copy must tell the truth ([[US-718]]).** Poshmark must NOT be shown
  as a clean API integration alongside eBay/Shopify/Depop. It is **"via the GradeThread Lister
  extension (your browser)"** — not server-side, not one-click-from-the-cloud. Don't advertise
  capability we don't have.
- **No Rithum spend, no DSCO application, no Brand Closet application is initiated at this
  time.**

---

## 6. Re-evaluation trigger (when to reopen this decision)

Reopen and re-run §2 **only** when a concrete enterprise Poshmark seller appears:

- A customer (or signed LOI) doing **> $50k/yr Poshmark GMV**, willing to commit **≥ 12
  months**, at a price tier that **absorbs ≥ $1.5k–3k/mo** (or rev-share).

When that happens: (1) re-confirm Rithum/Brand Closet still gate Poshmark and current DSCO
terms; (2) start the Brand Closet → DSCO onboarding (~2–3 wks, listing creation still
partly manual); (3) flip this doc's verdict to GO with the customer named here.

| Field | Value |
|---|---|
| Decision date | 2026-06-13 |
| Decision | **NO-GO** (route to [[US-716]] extension) |
| Decided by | Founder (Dan Pearson) |
| Re-evaluation trigger | ≥1 customer > $50k/yr Poshmark GMV + ≥12-mo commit + price covers seat |
| Next review | When trigger is met (no scheduled date — demand-driven) |
