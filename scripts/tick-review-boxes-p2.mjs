#!/usr/bin/env node
// US-2089 triage, web P2 slice. Same mechanics as tick-review-boxes.mjs — see
// that file for why this is a script and not inline shell.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NOTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "vault",
  "90-archive",
  "code-review-2026-07-04.md",
);

const CLOSURES = [
  [
    "**Stripe checkout/portal buttons re-enable before the redirect",
    "✅ **CLOSED** by US-1631: `useRedirectStore` latches `isRedirecting` the moment we navigate to Stripe and never resets it (the page unloads), so redirect buttons stay disabled through the nav instead of re-enabling when the mutation resolves.",
  ],
  [
    "**Billing page has no error state",
    "✅ **CLOSED**: `billing.tsx` now handles `isError`.",
  ],
  [
    "**Submission-detail fetch: no cancellation + five swallowed Supabase errors",
    "✅ **CLOSED** by the US-163x pass on `submission-detail.tsx` (5 markers in-file), which added cancellation and surfaced the swallowed `{ error }` returns.",
  ],
  [
    "**`linkInventoryItem` failure toast is dead code",
    "✅ **CLOSED** by US-1632: the call site now checks the returned `{ error }` rather than relying on a throw supabase-js never performs.",
  ],
  [
    "**Bulk submission fetches the auth token once before a long batch",
    "✅ **CLOSED** by US-1632: each row now goes through `edgeFetch`, which mints a fresh token per request and handles the 401-refresh, so a long batch can't 401 mid-run.",
  ],
  [
    "**Grade/status sort only sorts the current page",
    "✅ **CLOSED**: sorting is applied server-side in the paginated query rather than to the fetched page.",
  ],
  [
    "**Snap-to-Value uploads the raw uncompressed file",
    "✅ **CLOSED** by the US-163x pass on `snap.tsx`: the file is compressed before upload and the full data URI is no longer pushed into router history state.",
  ],
  [
    "**eBay sync completion compares client clock to server timestamp",
    "✅ **CLOSED** by the US-163x pass on `marketplaces.tsx` (3 markers in-file): completion no longer depends on client-vs-server clock skew and a failure path ends the toast.",
  ],
  [
    "**Kanban drag optimistic update: no `cancelQueries`",
    "✅ **CLOSED** by the US-163x pass on `pipeline.tsx`: the optimistic update now cancels in-flight queries and rolls back precisely rather than replacing the whole array.",
  ],
  [
    "**Photo-reconcile commit counts failed uploads",
    "✅ **CLOSED** by the US-163x pass on `use-reconcile-commit.ts` (3 markers in-file): failed uploads are no longer counted as successes and a partial commit no longer marks the session committed.",
  ],
  [
    "**`useUpdateBlogPost` caches the tag-less PATCH response",
    "✅ **CLOSED** by the US-163x pass on `use-content.ts`: the tag-less PATCH response is no longer written into the cache, so the next save can't wipe tags.",
  ],
  [
    "**`useBulkPublish` polls in an unbounded `for(;;)`",
    "✅ **CLOSED** by US-1633: `cancelledRef` stops the poll loop on unmount (the server-side batch is durable and continues regardless).",
  ],
  [
    "**Admin content/changelog/sheet/Shopify hooks send a possibly-expired token",
    "✅ **CLOSED** by US-1634: these hooks route through `edgeFetch`, which mints a fresh token per request and retries once on 401.",
  ],
];

let src = readFileSync(NOTE, "utf8");
let ticked = 0;
const missed = [];

for (const [prefix, closure] of CLOSURES) {
  const needle = `- [ ] ${prefix}`;
  const at = src.indexOf(needle);
  if (at === -1) {
    missed.push(prefix);
    continue;
  }
  const lineEnd = src.indexOf("\n", at);
  const line = src.slice(at, lineEnd === -1 ? undefined : lineEnd);
  const updated = line.replace("- [ ] ", "- [x] ") +
    ` — ${closure} Verified against source 2026-07-19 (US-2089).`;
  src = src.slice(0, at) + updated + (lineEnd === -1 ? "" : src.slice(lineEnd));
  ticked++;
}

if (missed.length > 0) {
  console.error("✗ could not find these findings (text drifted?):");
  for (const m of missed) console.error(`   ${m}`);
  process.exit(1);
}

writeFileSync(NOTE, src);
const remaining = (src.match(/^- \[ \]/gm) ?? []).length;
const done = (src.match(/^- \[x\]/gm) ?? []).length;
console.log(`✓ ticked ${ticked}; note now ${done} checked / ${remaining} unchecked`);
