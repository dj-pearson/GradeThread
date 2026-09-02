---
title: Email deliverability
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/email-transport.ts
reviewed: 2026-09-02
tags: [email, ses, deliverability]
summary: SES/SMTP configuration, warmup, DMARC alignment and what to check when mail stops landing.
---
# Email Deliverability (US-915)

> **Re-reviewed 2026-09-02.** Drift flagged `email-transport.ts` for `f905cb2ba`
> (the eBay post-sale batch), which touches the transport only where the
> post-sale notifications hand it a message. No sender domain, DKIM/SPF claim,
> suppression rule or retry policy below changed.


How GradeThread keeps autonomous marketing mail (newsletter, drip, win-back,
journeys, north-star digests) landing in the inbox — and keeps a marketing
reputation hit from ever harming account-critical (transactional) mail.

> **TL;DR for launch:** verify a **dedicated marketing subdomain**
> (`news.gradethread.com`) in SES with its own DKIM + SPF + DMARC, attach an SES
> **Configuration Set** that publishes bounce/complaint events to SNS, set the
> edge env vars below, and confirm the boot log shows **no** `[BOOT]
> deliverability:` warnings.

---

## 1. Identity separation: transactional vs marketing

Two distinct sending identities, so a marketing reputation problem can never
degrade password resets, receipts, or grade-ready mail:

| Class | Examples | From identity | Env |
|---|---|---|---|
| **Transactional** | grade-ready, receipts, payment-failed, security/admin alerts, eBay lifecycle | `support@gradethread.com` (apex / transactional subdomain) | `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` |
| **Marketing** | newsletter, trial drip, win-back, journeys, north-star weekly/milestone, broadcasts | `news@news.gradethread.com` (**dedicated marketing subdomain**) | `SES_MARKETING_FROM_EMAIL`, `SES_MARKETING_FROM_NAME`, `SES_MARKETING_REPLY_TO` |

The split is enforced in code: `resolveIsMarketing()`
(`services/edge-functions/src/lib/email-transport.ts`) **hard-guards** every
known transactional category (`TRANSACTIONAL_CATEGORIES`) so it can never be sent
on the marketing identity, even if a caller mistakenly passes `marketing: true`.
Regression: `src/tests/email-transport_test.ts` (AC6).

Use a **subdomain** (`news.`), not the apex, for marketing so its reputation is
tracked separately by mailbox providers.

---

## 2. DNS authentication (SPF · DKIM · DMARC)

Publish for the **marketing subdomain** `news.gradethread.com` (repeat the
equivalent for the transactional identity):

### SPF / custom MAIL FROM
Set a custom MAIL FROM domain in SES (e.g. `bounce.news.gradethread.com`) so SPF
aligns, then publish:

```
bounce.news.gradethread.com.  TXT   "v=spf1 include:amazonses.com -all"
bounce.news.gradethread.com.  MX    10 feedback-smtp.<region>.amazonses.com
```

### DKIM
SES (Easy DKIM) gives three CNAMEs — publish all three:

```
<token1>._domainkey.news.gradethread.com.  CNAME  <token1>.dkim.amazonses.com
<token2>._domainkey.news.gradethread.com.  CNAME  <token2>.dkim.amazonses.com
<token3>._domainkey.news.gradethread.com.  CNAME  <token3>.dkim.amazonses.com
```

### DMARC
Start at `p=none` (monitor), then tighten to `quarantine` → `reject` once reports
are clean:

```
_dmarc.news.gradethread.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@gradethread.com; fo=1; adkim=s; aspf=s"
```

DNS records can't be read from the edge, so once the records are **live and
verified in SES** flip the attestation flags (`SES_DKIM_VERIFIED=true`,
`SES_SPF_ALIGNED=true`, `SES_DMARC_POLICY=quarantine`). The boot pre-flight
(below) warns until they're set.

---

## 3. SES Configuration Set + event publishing

Create a Configuration Set (e.g. `gt-marketing`) with an **event destination**
that publishes `bounce`, `complaint`, `reject`, and `delivery` events to an SNS
topic. The SNS subscription posts to the SES webhook, which feeds the suppression
list (`isEmailSuppressed`, US-914/US-1057) so hard-bounced/complained addresses
are never mailed again — the single fastest way to protect sender reputation.

The Configuration Set name is attached to every marketing send:
- **SES API transport** → `ConfigurationSetName` in the SendEmail request.
- **SMTP transport** → `X-SES-CONFIGURATION-SET` header.

Env: `SES_CONFIGURATION_SET` (shared) and/or `SES_MARKETING_CONFIGURATION_SET`
(marketing-specific, preferred for marketing) / `SES_TRANSACTIONAL_CONFIGURATION_SET`.

---

## 4. Transport: SES API vs raw SMTP

`deliverEmail()` (`services/edge-functions/src/lib/email.ts`) chooses per send via
`resolveTransportKind()`:

- **Default:** marketing volume → **SES v2 HTTP API** (SigV4 via `aws4fetch`,
  `lib/ses-api.ts`) when AWS creds are present, because the API carries the
  Configuration Set and `List-Unsubscribe` headers as first-class fields.
  Transactional → SMTP.
- **Override:** `EMAIL_TRANSPORT=ses_api|smtp` forces the choice.
- **Fallback:** the SES API path falls back to SMTP on *any* error, so a bug
  there can never drop mail. With no AWS creds the service simply keeps using
  SMTP (today's behaviour).

Env for the SES API path: `SES_AWS_REGION`, `SES_AWS_ACCESS_KEY_ID`,
`SES_AWS_SECRET_ACCESS_KEY` (or the standard `AWS_*` names);
`SES_AWS_SESSION_TOKEN` optional.

---

## 5. One-click unsubscribe (RFC 8058)

Every marketing message carries:
- `List-Unsubscribe: <https://…/u/{token}>, <mailto:unsubscribe@gradethread.com>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`

so Gmail/Apple Mail render the native unsubscribe affordance. The https target is
the same no-login link the rendered footer already uses (`marketingUnsubscribeUrl`),
minted by the marketing coordinator (the single marketing chokepoint). The mailto
target comes from `MARKETING_UNSUBSCRIBE_MAILTO`. Built by
`buildListUnsubscribeHeaders()`; the in-body CAN-SPAM unsubscribe + postal address
(US-516) remain regardless.

---

## 6. Warmup ramp + send-rate pacing

A freshly-warmed SES identity must not be hit with a full list on day one. The
ramp lives in the **settings registry** (seeded `00292`, tunable without a
deploy) — `lib/email-warmup.ts`:

| Setting | Meaning |
|---|---|
| `marketing_warmup_enabled` | master switch (off by default — behaviour unchanged until you opt in) |
| `marketing_warmup_schedule` | per-day send ceilings, index = days since start (`[50, 100, 500, 1000, …]`) |
| `marketing_warmup_start_date` | `YYYY-MM-DD` the ramp began |
| `marketing_max_send_rate_per_sec` | SES account max send rate; bounds the daily ceiling (`rate × 86400`) |
| `marketing_send_batch_limit` | per-tick burst cap (US-925) |

The bulk broadcast dispatcher folds the **remaining daily warmup budget**
(today's ceiling − marketing sends already logged today, across all programs)
into the per-tick batch limit, so a large list drains over many ticks **and**
respects the day's ramp ceiling. When warmup is off or complete, the cap is
unlimited and only the per-tick limit applies.

To start warmup at launch: set `marketing_warmup_start_date` to today and
`marketing_warmup_enabled=true`.

---

## 7. Boot pre-flight (what to check after deploy)

`warnDeliverability()` runs at boot (`lib/env-validation.ts`) and logs once per
gap. A correctly configured deploy logs **nothing**. You'll see warnings like:

```
[BOOT] deliverability: No SES Configuration Set (SES_CONFIGURATION_SET) — bounce/complaint events won't publish to SNS.
[BOOT] deliverability: No dedicated marketing identity (SES_MARKETING_FROM_EMAIL) — ...
[BOOT] deliverability: DKIM not attested (set SES_DKIM_VERIFIED=true once DKIM CNAMEs are live).
[BOOT] deliverability: SPF not attested (set SES_SPF_ALIGNED=true once the SPF/MAIL FROM record is live).
[BOOT] deliverability: No DMARC policy recorded (set SES_DMARC_POLICY to your published p= policy).
```

Clear every line before enabling autonomous weekly sends.

---

## Env var reference

| Var | Purpose |
|---|---|
| `SES_MARKETING_FROM_EMAIL` / `SES_MARKETING_FROM_NAME` / `SES_MARKETING_REPLY_TO` | dedicated marketing identity |
| `SES_CONFIGURATION_SET` / `SES_MARKETING_CONFIGURATION_SET` / `SES_TRANSACTIONAL_CONFIGURATION_SET` | event-publishing config set(s) |
| `SES_AWS_REGION` / `SES_AWS_ACCESS_KEY_ID` / `SES_AWS_SECRET_ACCESS_KEY` / `SES_AWS_SESSION_TOKEN` | SES v2 API creds (fall back to `AWS_*`) |
| `EMAIL_TRANSPORT` | `ses_api` \| `smtp` force-override |
| `MARKETING_UNSUBSCRIBE_MAILTO` | mailto target for `List-Unsubscribe` |
| `SES_DKIM_VERIFIED` / `SES_SPF_ALIGNED` / `SES_DMARC_POLICY` | DNS-auth attestations read by the boot pre-flight |
| `SMTP_HOST/PORT/USER/PASS/ADMIN_EMAIL/SENDER_NAME/REPLY_TO` | SMTP transport + transactional identity |

See also `vault/10-ops/env-reference.md`, `vault/10-ops/launch-checklist.md`, and the CAN-SPAM/consent path
in `services/edge-functions/src/lib/marketing-coordinator.ts`.

## Related

- [[newsletter-tuning]] — the sending side
- [[env-reference]] — the SES/SMTP variables, including ones documented nowhere else
- [[INDEX]]
