# eBay Developer Setup

Step-by-step to collect every environment variable the FlipDesk eBay
integration needs. Follow start-to-finish on a fresh setup; skim the
"Reference" sections later when something breaks.

At the end of this guide every variable in the `# FlipDesk: eBay integration`
block of [`.env.example`](.env.example) will have a value you can paste into
Coolify (Settings → Environment Variables, for the edge service).

---

## What you need before you start

- A regular consumer eBay account (sign in at https://www.ebay.com). The
  developer portal uses it as your login.
- Your deployed edge service URL — most likely
  `https://api.gradethread.com/api/flipdesk/ebay/oauth/callback`. eBay redirects
  the user's browser there after they consent.
- 10 minutes for Sandbox keys. Production keys take longer (eBay reviews
  the app before activating them — usually 1-2 business days).

---

## Step 1 — Create your eBay developer account

1. Go to https://developer.ebay.com/ and click **Join** (top right).
2. Sign in with your eBay account when prompted.
3. Accept the API License Agreement.
4. You'll land on the developer dashboard at
   https://developer.ebay.com/my/keys.

There's no fee and no credit card required for the developer program.

---

## Step 2 — Generate a Sandbox keyset

The Sandbox is a separate, isolated copy of eBay where listings and orders
are fake. **Always test here first.** Switching to Production is one env
var change (`EBAY_ENV=production`) once Sandbox works end-to-end.

1. Open https://developer.ebay.com/my/keys.
2. In the **Sandbox** column, click **Create a keyset**.
3. Give the app a name (e.g. `FlipDesk-Sandbox`). Anything works — it's
   only shown to you.
4. eBay generates three values. Copy each:

   | eBay label    | Goes into `.env`          | Treat as     |
   |---------------|---------------------------|--------------|
   | App ID (Client ID) | `EBAY_APP_ID`        | Public-ish   |
   | Cert ID (Client Secret) | `EBAY_CERT_ID`  | **Secret**   |
   | Dev ID        | `EBAY_DEV_ID`             | Semi-secret  |

   The Cert ID is shown **only once**. Copy it now into a password
   manager — eBay won't show it again, and the only recovery is to
   regenerate the entire keyset.

---

## Step 3 — Create a RuName and register the callback URL

This is the step everyone gets wrong. eBay's OAuth flow needs *two* pieces
of redirect configuration that look similar but are different things:

- **Auth Accepted URL** — the actual URL eBay redirects the browser to
  after consent. This is the public URL of our `/oauth/callback` endpoint.
- **RuName** — an opaque identifier (something like
  `PearsonM-FlipDesk-PRD-abcdefghi-123jklmn`) that eBay generates from the
  Auth URL. The OAuth `redirect_uri` parameter we send to eBay uses this
  string, **not the URL itself**. This trips up almost every first-time
  integration.

To set it up:

1. Still on https://developer.ebay.com/my/keys, find your **Sandbox**
   keyset row.
2. Under that keyset, click **User Tokens** (or "Get a Token from eBay
   via Your Application" — same destination).
3. Find the section labeled **Your branded eBay Production / Sandbox Sign
   In (OAuth)** and click **Add eBay Redirect URL**.
4. Fill in:
   - **Your auth accepted URL** →
     `https://api.gradethread.com/api/flipdesk/ebay/oauth/callback`
   - **Your auth declined URL** → same URL (the route handles the
     "user cancelled" case via the `?error=` query param).
   - **Your privacy policy URL** → `https://gradethread.com/privacy`
     (or any reachable URL — eBay just checks it's not empty).
5. Save. eBay displays a generated **RuName** string. Copy it.

   | eBay label | Goes into `.env`     |
   |------------|----------------------|
   | RuName     | `EBAY_RU_NAME`       |
   | Auth Accepted URL | `EBAY_REDIRECT_URI` (informational; the code uses RuName for OAuth itself) |

> **Heads-up:** if the deployed callback URL changes (e.g. you move from
> `api.gradethread.com` to a different host), come back here and edit the
> Auth Accepted URL. The RuName stays the same.

---

## Step 4 — Generate the encryption key for stored tokens

OAuth tokens are encrypted at rest in `marketplace_connections` using
AES-256-GCM. The key lives in `EDGE_ENCRYPTION_KEY` as a base64-encoded
32-byte value.

On any machine with `openssl`:

```bash
openssl rand -base64 32
```

If you don't have OpenSSL (uncommon on Windows), PowerShell works:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Copy the output. This is `EDGE_ENCRYPTION_KEY`.

> **Once set, do not change it.** Rotating the key makes every existing
> encrypted token in the database unrecoverable. If you need to rotate,
> plan for users to reconnect their marketplaces.

---

## Step 5 — Set every variable in Coolify

In the Coolify UI for the edge service, paste this block into
**Environment Variables** (substituting your values):

```dotenv
# Sandbox first. Switch to "production" only after Sandbox flow works.
EBAY_ENV=sandbox

# From Step 2 (Sandbox keyset)
EBAY_APP_ID=PearsonM-FlipDesk-SBX-...
EBAY_CERT_ID=SBX-...                   # secret
EBAY_DEV_ID=...

# From Step 3 (the RuName, NOT the URL)
EBAY_RU_NAME=PearsonM-FlipDesk-SBX-...
EBAY_REDIRECT_URI=https://api.gradethread.com/api/flipdesk/ebay/oauth/callback

# OAuth scopes — defaults match what the Week 1 / Week 3 code needs.
# Leave commented to use the defaults baked into ebay-client.ts.
# EBAY_SCOPES=https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.account

# Marketplace + taxonomy tree the Taxonomy API uses. US is "0".
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_CATEGORY_TREE_ID=0

# From Step 4
EDGE_ENCRYPTION_KEY=...                # secret

# So /oauth/callback can redirect back to the SPA after success.
FLIPDESK_APP_ORIGIN=https://gradethread.com
```

Coolify → redeploy the edge service so it picks up the new env.

> The following block can wait. Leave them blank for now and revisit when
> the corresponding feature is wired:
>
> - `EBAY_VERIFICATION_TOKEN` — only used for inbound eBay account-deletion
>   webhooks (Week 3+ — flipdesk-webhooks.ts).
> - `FLIPDESK_INTERNAL_JOB_SECRET` — only used by the scheduled
>   `/oauth/refresh` job (Week 2-3).

---

## Step 6 — Apply the migration

```bash
# from supabase/migrations
psql "$DATABASE_URL" -f 00030_ebay_taxonomy.sql
```

Or apply it via the Supabase dashboard SQL editor. This adds the
`ebay_category_id` / `ebay_aspects` columns to `inventory_items`, the
shared `ebay_category_aspects` cache, and the `oauth_states` CSRF table.

---

## Step 7 — Smoke-test it

1. Sign in to FlipDesk and open `/dashboard/flipdesk/marketplaces`.
2. The "eBay — API connection" card should show **Setup required** with
   an enabled **Connect eBay account** button.
3. Click it. The browser navigates to
   `https://auth.sandbox.ebay.com/oauth2/authorize?...`. Sign in with a
   Sandbox test user (see [Sandbox test users](#reference-sandbox-test-users)
   below if you don't have one yet).
4. After consenting, eBay redirects back to your edge callback, which
   redirects to `/dashboard/flipdesk/marketplaces?ebay=connected`. The
   card now shows a green **Connected** badge.
5. Open any item in the composer (`/dashboard/flipdesk/items/<id>/composer`).
   Type "men's blazer" in the eBay category search. Within ~300ms you
   should see eBay category suggestions. Pick one — the required and
   recommended item-specific fields should render.

If the consent screen comes up but the callback errors, walk back through
[Step 3](#step-3--create-a-runame-and-register-the-callback-url) — almost
every callback failure is a RuName/URL mismatch.

---

## Reference: scopes we request

The defaults in `ebay-client.ts:getScopes()` are:

| Scope                                                            | Why we ask for it                                  |
|------------------------------------------------------------------|----------------------------------------------------|
| `https://api.ebay.com/oauth/api_scope`                           | Baseline. Required by Browse + Taxonomy APIs.      |
| `https://api.ebay.com/oauth/api_scope/sell.inventory`            | Creating inventory items, offers, and listings.    |
| `https://api.ebay.com/oauth/api_scope/sell.marketing`            | Promoting listings (Promoted Listings — Week 3+).  |
| `https://api.ebay.com/oauth/api_scope/sell.account`              | Reading business policies (shipping/return/payment) needed to publish an offer. |

Override via `EBAY_SCOPES` (space-separated) if you need to add or
remove any. Reducing scopes means re-consenting the user.

---

## Reference: Sandbox test users

eBay's Sandbox doesn't accept your real eBay account. You need a Sandbox
test user.

1. Go to https://developer.ebay.com/sandbox/register.
2. Generate a test user. You'll get a username + password — save them.
3. Use these credentials when the Sandbox auth page asks you to sign in.

Two test users is convenient: one acts as the seller (gets connected),
the other can act as a buyer once you start pushing listings in Week 3.

---

## Reference: Marketplace Insights API (sold-price data)

This API powers Week 2's "real sold-comp prices" feature. eBay gates it
behind a manual review. Submit the application **now** while you're in
the developer portal:

1. https://developer.ebay.com/develop/apis/restful-api → find **Marketplace
   Insights** → click **Apply**.
2. Fill in the business-justification form. Mention the use case:
   "Display sold-price comparables to resellers cataloging inventory."
3. Approval takes 1-2 weeks. Until it lands, the comps endpoint falls
   back to Browse API "ended listings" — less precise but functional.

No env var changes are required when approval comes through — the same
Sandbox/Production keysets gain the new entitlement automatically.

---

## Reference: switching to Production

When Sandbox is working end-to-end:

1. https://developer.ebay.com/my/keys → in the **Production** column,
   click **Create a keyset**. Generate a Production keyset.
2. Repeat [Step 3](#step-3--create-a-runame-and-register-the-callback-url)
   on the Production side to get a Production RuName.
3. In Coolify, change:
   ```dotenv
   EBAY_ENV=production
   EBAY_APP_ID=...           # new Production App ID
   EBAY_CERT_ID=...          # new Production Cert ID
   EBAY_DEV_ID=...           # new Production Dev ID
   EBAY_RU_NAME=...          # new Production RuName
   ```
4. Redeploy. Existing user connections will need to reconnect — they were
   linked to Sandbox tokens, which Production won't accept.

---

## Reference: where each variable is used

| Variable | Used in |
|---|---|
| `EBAY_ENV` | `ebay-client.ts:authHost()` / `apiHost()` |
| `EBAY_APP_ID`, `EBAY_CERT_ID` | `ebay-client.ts:basicAuthHeader()` |
| `EBAY_RU_NAME` | `ebay-client.ts:buildConsentUrl()` + `exchangeCodeForTokens()` |
| `EBAY_SCOPES` | `ebay-client.ts:getScopes()` |
| `EBAY_MARKETPLACE_ID`, `EBAY_CATEGORY_TREE_ID` | `ebay-client.ts:suggestCategories()` + `getCategoryAspects()` |
| `EDGE_ENCRYPTION_KEY` | `crypto-aes.ts:loadKey()` |
| `FLIPDESK_APP_ORIGIN` | `flipdesk-ebay.ts:appUrl()` (post-callback redirect) |
