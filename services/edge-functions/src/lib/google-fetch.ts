// US-2321: the Google integration's deadline, in one place.
//
// Every other marketplace client — eBay, Etsy, Depop, Shopify, Whatnot — goes
// through `fetchWithTimeout` at 20-25s (US-499). The Google integration was
// never migrated and used bare `fetch` at 22 call sites: all of Sheets, the
// service-account token mint, the six OAuth/userinfo/refresh/create/check/revoke
// calls, all of Google Photos Picker, the sheet export, and Google Ads.
//
// A bare fetch in Deno has no socket-read deadline. The failure that matters is
// not a slow sheet — it is that the sheet-sync cron fans out per user every 5
// minutes, each call parks on a hung socket forever, and the ONE Deno container
// that also serves /api/grade/* and /api/payments/* fills up with stalled
// requests and stops answering. A Google regional slowdown becomes a grading and
// payments outage.
//
// 20s matches the marketplace clients. Google's own p99 for these endpoints is
// well under a second; anything past 20s is a hung socket, not a slow response.

import { fetchWithTimeout } from "./circuit-breaker.ts";

export const GOOGLE_FETCH_TIMEOUT_MS = 20_000;

/**
 * `fetch` with the Google deadline applied. Drop-in for `typeof fetch`, so it
 * can be the default value of every injectable `fetchFn` parameter rather than
 * something each call site has to remember to reach for — the thing that gets
 * forgotten is the thing that must not be optional.
 */
export const googleFetch: typeof fetch = (input, init) =>
  fetchWithTimeout(
    input as string | URL | Request,
    (init ?? {}) as RequestInit,
    GOOGLE_FETCH_TIMEOUT_MS,
  );
