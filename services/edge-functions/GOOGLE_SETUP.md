# Google Cloud Setup

Step-by-step to stand up the Google Cloud project that backs every Google
integration in GradeThread, and to collect the environment variables they
need. Follow start-to-finish on a fresh project (e.g. when moving to a new
Google Cloud project before OAuth verification); skim the "Reference" sections
later when something breaks.

There are **three** Google integrations, and they split across **two** credential
types. Keep that split straight — it's the single most important thing in this
guide, because only one of the two credential types goes through OAuth
verification:

| Integration | Credential type | Verification? |
|---|---|---|
| **Google Sign-In** ("Continue with Google") | OAuth client (web) | Non-sensitive scopes — no review |
| **Google Photos import** (AutoLister) | **same** OAuth client (web) | **Sensitive scope — triggers verification** |
| **Search Console** (SEO admin) | **Service account** (separate) | Bypasses the consent screen entirely |

So: **one OAuth client** is shared by Sign-In + Photos, and **one service
account** handles Search Console on its own auth path. The service account never
appears on the consent screen and never needs verification — you just enable its
API and share the property with it.

At the end of this guide these `.env` values (edge service, set in Coolify) will
have values:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# GOOGLE_PHOTOS_REDIRECT_URI=   (optional override; defaults to functions.* callback)
GSC_SERVICE_ACCOUNT_EMAIL=
GSC_SERVICE_ACCOUNT_PRIVATE_KEY=
```

…plus the Supabase `auth.external.google` client id/secret (the **same** OAuth
client as `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).

---

## What you need before you start

- A Google account with rights to create a Cloud project (or an existing
  project you're migrating into).
- The two redirect URIs the OAuth client must allow:
  - `https://api.gradethread.com/auth/v1/callback` — Supabase Google sign-in.
    (`api.*` is self-hosted Supabase/GoTrue; this is GoTrue's callback.)
  - `https://functions.gradethread.com/api/flipdesk/google/photos/oauth/callback`
    — Photos import. (`functions.*` is the Hono edge service. Pointing Google at
    `api.*` for this one will 404 — that host is Supabase Kong, not the edge.)
- Ownership/admin of the `gradethread.com` Search Console property (to add the
  service account to it).
- A privacy-policy URL and a terms-of-service URL on `gradethread.com`
  (required to publish the consent screen and to pass verification).

---

## Step 1 — Create / select the Cloud project

1. Go to https://console.cloud.google.com/ and create a new project (top-left
   project picker → **New Project**). Name it e.g. `gradethread-prod`.
2. Note the project — every step below happens inside it.

---

## Step 2 — Enable the APIs

APIs & Services → **Library**, search and **Enable** each:

1. **Photos Picker API** (`photospicker.googleapis.com`) — AutoLister photo
   import.
2. **Google Search Console API** (`searchconsole.googleapis.com`, listed as
   "Search Console API") — SEO performance/sitemaps in the admin.

That's all you need to enable. Notes:

- **Google Sign-In needs no API enabled** — "Continue with Google" is plain
  OpenID Connect; it only needs the OAuth client + consent screen from Step 3.
- **Google Analytics (GA4)** in the app is client-side `gtag` and needs nothing
  here.
- **IndexNow** (search-engine ping) is Bing/Yandex, not Google — unrelated.

---

## Step 3 — Configure the OAuth consent screen

APIs & Services → **OAuth consent screen**.

1. **User type: External.** (Internal is only for Google Workspace-internal
   apps; our users are public.)
2. App information:
   - App name: `GradeThread`
   - User support email: your support address.
   - App logo: upload `logo_icon_512.png` (optional but recommended; required
     for a polished verification).
3. **App domain:**
   - Application home page: `https://gradethread.com`
   - Privacy policy: `https://gradethread.com/privacy` (use the live URL)
   - Terms of service: `https://gradethread.com/terms`
4. **Authorized domains:** add `gradethread.com`.
5. Developer contact email: your address.
6. **Scopes** — Add or remove scopes, then add these four:

   | Scope | For | Class |
   |---|---|---|
   | `openid` | Sign-in | Non-sensitive |
   | `.../auth/userinfo.email` | Sign-in | Non-sensitive |
   | `.../auth/userinfo.profile` | Sign-in | Non-sensitive |
   | `.../auth/photospicker.mediaitems.readonly` | Photos import | **Sensitive** |

   The Photos scope is what flips the app into needing verification. Do **not**
   add the Search Console scope here — that belongs to the service account
   (Step 5), not the consent screen.

7. **Test users:** while unverified, add the Google accounts you'll test with.
   Only test users can complete the Photos flow until verification is granted
   (the 100-external-user cap does **not** apply to test users).

8. Save. Leave the app in **Testing** until you've finished Steps 4–6 and
   tested end-to-end; then **Publish** and submit for verification.

---

## Step 4 — Create the OAuth client (Sign-In + Photos)

APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.

1. Application type: **Web application**.
2. Name: `GradeThread Web`.
3. **Authorized redirect URIs** — add **both**:
   - `https://api.gradethread.com/auth/v1/callback`
   - `https://functions.gradethread.com/api/flipdesk/google/photos/oauth/callback`
   (Authorized JavaScript origins are **not** needed — both flows are
   server-side code exchanges, not browser token flows.)
4. Create. Copy the **Client ID** and **Client secret**.

Set the values in two places — they're the **same** client, reused (one OAuth
client can serve multiple scopes and redirect URIs, so don't make a second one):

- **Edge service** (Coolify env on the edge container):
  - `GOOGLE_CLIENT_ID` = the client ID
  - `GOOGLE_CLIENT_SECRET` = the client secret
- **Supabase** (`supabase/config.toml` → `[auth.external.google]`, or the
  self-hosted GoTrue env):
  - `client_id` = the same client ID
  - `secret` = the same client secret
  - `redirect_uri` = `https://api.gradethread.com/auth/v1/callback`

> The code reads `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` by default. The
> per-service overrides `GOOGLE_PHOTOS_CLIENT_ID`/`GOOGLE_PHOTOS_CLIENT_SECRET`
> exist only if Photos ever needs a *different* client than the shared one —
> leave them unset for the shared setup.

The Photos redirect defaults to the `functions.*` callback above. Only set
`GOOGLE_PHOTOS_REDIRECT_URI` if your edge host differs.

---

## Step 5 — Create the Search Console service account (separate auth)

This is a **different** credential from the OAuth client above. It does not use
the consent screen, has no user-facing scope prompt, and needs no verification.

1. APIs & Services → **Credentials** → **Create credentials** → **Service
   account**.
2. Name: `gradethread-gsc`. Create; no project roles are required (it gets
   access by being added to the Search Console *property*, not via IAM).
3. Open the service account → **Keys** → **Add key** → **Create new key** →
   **JSON**. A JSON file downloads — keep it secret.
4. From that JSON, set the edge env:
   - `GSC_SERVICE_ACCOUNT_EMAIL` = the `client_email` field (looks like
     `gradethread-gsc@<project>.iam.gserviceaccount.com`).
   - `GSC_SERVICE_ACCOUNT_PRIVATE_KEY` = the `private_key` field. When pasting
     into Coolify, keep the literal `\n` escape sequences — the code converts
     `\n` back to real line breaks (PKCS#8 PEM).
5. **Grant it access to the property:** Search Console
   (https://search.google.com/search-console) → your `gradethread.com` property
   → Settings → **Users and permissions** → **Add user** → paste the service
   account email → role **Full** (or **Restricted** — read is enough; the code
   uses `webmasters.readonly`).

The service account uses scope `.../auth/webmasters.readonly` internally (it
signs its own RS256 JWT and trades it for a token at
`oauth2.googleapis.com/token`). You don't configure that scope anywhere in the
console — it's in the code (`gsc-client.ts`).

---

## Step 6 — Test before publishing

With the app still in **Testing** and your account added as a test user:

1. **Sign-In:** log into GradeThread with "Continue with Google".
2. **Photos:** AutoLister → **Import from Google Photos** → consent → pick a few
   photos → confirm they stage in. (The button only shows when
   `GOOGLE_CLIENT_ID`/`SECRET` are set on the edge; otherwise the endpoint
   returns 503 and the button is hidden.)
3. **Search Console:** open the admin SEO page and confirm GSC data loads (or
   that `gscConfigured` is true).

---

## Step 7 — Publish & submit for verification

Once testing passes:

1. OAuth consent screen → **Publish app** (moves from Testing to In production).
2. Because of the **sensitive** Photos Picker scope, Google will require
   **verification**. Prepare:
   - Verified ownership of `gradethread.com` (the authorized domain).
   - A short **demo video** (often a YouTube unlisted link) showing the exact
     OAuth consent screen and how the Photos scope is used (user picks photos →
     they import into a listing). Google's reviewers want to see the scope in
     action.
   - A written justification: the app imports user-selected photos via the
     Photos **Picker** so sellers can create listings; it reads only the items
     the user explicitly picks, server-side, transiently, and stores no
     long-lived Google token.
3. Submit. Sensitive (not *restricted*) scopes do **not** require a third-party
   CASA security assessment — that's only for restricted Gmail/Drive scopes —
   so this is the lighter review. Turnaround is typically days to a few weeks.

Until verification completes, everything works for **test users**; new external
users would hit the "unverified app" screen, so keep launch scoped to test
users until approved.

---

## Reference — what reads what

| Env var | Read by | File |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Photos import OAuth | `src/routes/flipdesk-google-photos.ts` |
| `GOOGLE_PHOTOS_CLIENT_ID` / `_SECRET` | Optional per-service override | same |
| `GOOGLE_PHOTOS_REDIRECT_URI` | Optional callback override | same |
| `[auth.external.google]` client id/secret | Google sign-in | `supabase/config.toml` / GoTrue |
| `GSC_SERVICE_ACCOUNT_EMAIL` / `_PRIVATE_KEY` | Search Console | `src/lib/gsc-client.ts` |

| Google API | Why | Verification impact |
|---|---|---|
| Photos Picker API | AutoLister import | Sensitive scope → app verification |
| Search Console API | SEO admin | None (service account) |
| *(none — OIDC)* | Google sign-in | Non-sensitive scopes |
