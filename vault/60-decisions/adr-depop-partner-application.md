---
title: "ADR: Depop partner application"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-09-06
tags: [decision, marketplaces, depop, bizdev]
summary: The Depop API partnership application, what it requires and what it unlocks.
---
# Depop Selling API — Partner Program Application (US-712)

> **Status: DRAFTED — awaiting founder send.** This is a `[NO-CODE]` BizDev action.
> The agent has prepared the ready-to-send application below; **a human must send the
> email from a real GradeThread address and record the outcome in §3.** Approval is the
> gating step (Depop quotes 1–4 weeks) that unblocks the code stories **US-713** (Depop
> OAuth 2.0 + PKCE connector) and **US-714** (publish / order-sync / mark-as-shipped).

Source research: `vault/30-platform/cross-listing.md` §2 (Depop API path). The Depop Partner API is a real,
private RESTful API at `partnerapi.depop.com`; crosslisting tools are an explicitly
welcomed partner segment.

---

## 1. The ask (what we are requesting)

- The **OAuth 2.0 Authorization Code + PKCE multi-seller flow** — NOT a single-shop
  `pak_` bearer API key. GradeThread is a SaaS that lists on behalf of many independent
  sellers, so we need the multi-seller consent flow, not a per-shop key.
- Scopes: `products_read`, `products_write`, `orders_read`, `orders_write`,
  `offers_read`, `offers_write`, `shop_read`.
- A **sandbox API key / environment** (Depop documents one, with simulated purchases) so
  we can build and test US-713/US-714 against the OpenAPI spec at
  `https://partnerapi.depop.com/api-docs/openapi.yaml` before going live.
- The commercial terms (per the per-Order-Form arrangement referenced in
  `https://partnerapi.depop.com/api-docs/terms/`).

---

## 2. Email to send

**To:** business@depop.com
**Subject:** Partner API access request — GradeThread (AI grading SaaS + cross-listing for resellers)

> Hi Depop Partnerships team,
>
> I'm Dj Pearson, founder of **GradeThread** (Pearson Media LLC, gradethread.com) — a
> SaaS platform for pre-owned clothing resellers. We provide standardized, AI-powered
> condition grading (a 1.0–10.0 grade + condition report) and a full reselling workflow:
> source → catalog → measure → photograph → grade → comp → draft → list → sell → ship →
> reconcile.
>
> We already run a **live eBay integration** (OAuth 2.0 + token refresh, Inventory/Offer
> publish, Taxonomy/aspects, Browse comps, order & inventory webhooks for sale capture and
> auto-delist) and a **live Shopify integration** (GraphQL Admin API publish/update/delist
> + order/inventory webhooks). We are now building one-draft cross-listing fan-out across
> marketplaces, and **Depop is a top requested destination from our sellers.**
>
> We'd like to apply to the Depop Selling API partner program. Specifically:
>
> - We're requesting the **OAuth 2.0 Authorization Code + PKCE multi-seller flow** (not a
>   single-shop `pak_` key), since we publish on behalf of many independent sellers who
>   would each grant consent. Scopes: `products_read`, `products_write`, `orders_read`,
>   `orders_write`, `offers_read`, `offers_write`, `shop_read`.
> - We'd also like a **sandbox API key** to build and test against your OpenAPI spec
>   before production.
>
> A bit on scale:
>
> - Active sellers on GradeThread today: **[INSERT current active-seller count]**.
> - Projected Depop listing volume: **[INSERT projected monthly listing/order volume — e.g.
>   "~X new listings/month within the first quarter of launch, scaling with our seller base"]**.
> - We're a sanctioned-integration-first shop — we built eBay and Shopify against their
>   official APIs specifically to avoid ToS-risky scraping, and want to do the same with
>   Depop.
>
> Could you let us know the next steps, eligibility, commercial terms (we understand these
> are per-Order-Form), and whether a sandbox key can be issued so we can begin integration?
>
> Happy to share more about our seller base, roadmap, or a product walkthrough on a call.
>
> Thanks very much,
>
> Dj Pearson
> Founder, GradeThread (Pearson Media LLC)
> support@gradethread.com · gradethread.com

> **Before sending — fill the two `[INSERT ...]` placeholders** with real numbers. Do not
> send fabricated figures; if exact counts aren't handy, state a defensible range or
> "early-stage, pre-launch" honestly.

---

---

## 2b. Follow-up email (2026-09-06)

The §2 email was sent and Depop did not reply. That is their normal pattern for
`business@` and it is not a decline, so this chases it once, from a different
angle: the integration is no longer a plan, it is finished code waiting on a
key. That is the only new fact since the first email and it is the whole reason
to write again.

**Rules for a chase that works:** short, one question, easy to redirect, and it
must carry something the first email could not. Do not re-argue the original
ask. Do not apologise for following up. Reply in the same thread if you still
have it, because a threaded reply keeps the original detail one scroll away
without repeating it.

**To:** business@depop.com (reply in the original thread if it exists)
**Subject:** Re: Partner API access request — GradeThread
**If starting a new thread:** Partner API access — GradeThread, integration now built

> Hi,
>
> Following up on my note about Depop Selling API partner access for GradeThread
> (Pearson Media LLC, gradethread.com). One thing has changed since I wrote, and
> it is the reason I am writing again rather than just chasing.
>
> The Depop integration is built. Not planned: written, tested and sitting
> behind a feature flag waiting on credentials. OAuth 2.0 authorization code
> with PKCE, encrypted token storage with proactive refresh, product create and
> update, delete, order sync, seller addresses and shipping providers, parcel
> mark-as-shipped, and webhook receipt with signature and timestamp
> verification. It was built against your published OpenAPI spec. The day a
> client id lands it goes live; nothing else is in the way.
>
> Since the first email we have also shipped live integrations with eBay, Etsy
> and Shopify on the same pattern, all official APIs, no scraping anywhere in
> the product. For the marketplaces that publish no API we use a browser
> extension that fills their own form in the seller's own browser, and our
> servers never hold a marketplace password or session. We are the kind of
> integrator that stays inside the lines, which I think is the thing worth
> knowing about us.
>
> One question, and any answer is useful: is the partner program open right now?
> If it is closed or paused, I would rather know and check back later than keep
> emailing. If it is open and this is the wrong address, pointing me at the right
> one would be a real help.
>
> Thanks,
>
> Dj Pearson
> Founder, GradeThread (Pearson Media LLC)
> support@gradethread.com · gradethread.com

**Sender, settled 2026-09-06 by the founder: `support@gradethread.com`.** The
§2 draft above said `dan@gradethread.com`, which was never a real address, and
signed "Dan Pearson", which no other record in this repo uses. Both were
corrected to the verified identity so the two emails read as one thread. **If
"Dan" is what actually went out, change it back here rather than in the
follow-up** — a chase that renames the sender is worse than an inconsistent
archive. Use the same address on the Etsy application: a reviewer who searches
finds both, and two applications from one company under two addresses is a
question you have to answer instead of a fact they never notice. See
[[adr-etsy-api-application]].

One judgement call left to the founder, not a blocker: `support@` is a role
address, and some partner teams read a founder address as a stronger signal on a
BD email. The first email already went from `support@`, so the follow-up should
match it. If a third contact ever happens, that is the moment to switch.

⚠ **Nothing in the email above is a claim we cannot back.** Every capability
listed is real code in `services/edge-functions/src/lib/depop-api.ts` and
`depop-client.ts`. If that stops being true, this draft changes with it.

**If there is still no reply:** stop emailing. Two unanswered emails is a
closed door, and Depop is not load-bearing. Log it in §3 as "no response" and
revisit when Depop next announces partner news. The extension path
([[adr-poshmark-via-extension]]) already covers Depop for cross-listing if it
ever needs to.

## 3. Outcome (record here when Depop responds — this is acceptance criterion #3)

| Field | Value |
|---|---|
| Date application sent | sent, exact date not recorded (founder, 2026-09-06: "a while ago") |
| Sent from | `support@gradethread.com` (founder, 2026-09-06) |
| Date of Depop reply | **none as of 2026-09-06** |
| Outcome | ☐ Approved ☐ Waitlisted ☐ Declined ☑ No response |
| Flow granted | n/a |
| Sandbox key issued | ☐ Yes ☑ No |
| Commercial terms | n/a |
| Follow-up sent | _pending — draft in §2b_ |
| Notes | US-713/US-714 are BUILT and flag-off, so approval is the only remaining step. |

**Unblock logic:**
- **Approved (multi-seller + sandbox)** → confirm OpenAPI spec access at
  `https://partnerapi.depop.com/api-docs/openapi.yaml`, then proceed with **US-713 / US-714**.
- **Waitlisted / single-shop only / declined** → keep US-713 & US-714 deferred; revisit, or
  fall back to the browser-extension path (US-716) for Depop.

---

## 4. Spec / access checklist (acceptance criterion #4 — verify once approved)

- [ ] Sandbox API key received
- [ ] OpenAPI spec reachable: `https://partnerapi.depop.com/api-docs/openapi.yaml`
- [ ] Postman collection downloaded
- [ ] Multi-seller OAuth client credentials (client id/secret + redirect URI registration)
- [ ] Confirmed webhook support for order events

## Related

- [[adr-etsy-api-application]] — the same shape, one marketplace over
- [[adr-poshmark-via-extension]] — the contrasting call for no-API marketplaces
- [[cross-listing]] — where Depop sits in the channel model
- [[INDEX]]
