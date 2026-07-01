# iOS Deep-Dive Audit — 2026-07-01

Follow-up to `IOS_APP_REVIEW_AUDIT_2026-06-30.md` (US-1405…US-1412, mostly fixed).
Seven parallel read-only static sweeps over the ~550-file iOS app plus the edge
routes it talks to, targeting the runtime/UX bug classes App Review keeps
finding. Every finding was verified with file:line evidence against the current
tree; already-fixed items from the prior audit were re-verified and NOT
re-reported. Findings are bundled into **prd.json stories US-1491…US-1523**
(priorities 2400→2368 = recommended fix order); the stories carry the full
file:line detail, so this doc is just the index.

## Sweep dimensions → stories

| Sweep | Headline findings | Stories |
|---|---|---|
| Cross-form field carry-over (canvas ↔ eBay) | Column aspects (brand/size/color/material) DO project correctly (`InventoryAspectSync`), but **description, condition note, category, price, measurements, and grade** are shadowed forever by the publish-time `listings` snapshot; locale parse divergence can push a 100× price to a live listing | US-1491, 1500–1504, 1514 |
| Auth / session persistence | Password-reset link signs in but never asks for a new password; auth-callback failures fully silent (`try?`); stale workspace scope survives sign-out (wrong-tenant next login); sign-out not local-first; Apple name never reaches the profile; supabase-swift unpinned (no `Package.resolved`) | US-1492, 1493, 1499, 1521, 1523 |
| Dead / silently-failing controls | Settings "Help & FAQ" → confirmed-dead `/help` (404); publish & bulk-grade double-tap duplication; `try?`-swallowed settings/expense/team mutations; dead search rows | US-1497, 1498, 1522 |
| UI/UX polish | Comma-decimal locales break price/counter/measurement entry; dirty-form loss via swipe-back (specifics editor, publish composer, canvas); loading/empty/error states otherwise excellent | US-1491, 1513, 1514, 1522 |
| Performance | O(n²) view derivations (Sales, global search, Money); inventory thumbnails download full 1600px JPEGs (nothing writes `thumbnail_url` outside AutoLister); per-shutter main-thread I/O; serial 6–10-RTT sync pull | US-1517–1520 |
| Offline sync integrity | Expense `spent_on` clobbered to *now* on every merge (1-line); `hasLocalChanges` never cleared after flush (items frozen vs server forever); queue reordering resurrects old edits; Retry bypasses create-deferral; server edits to sales/photos/expenses never reach iOS; tenant races on switch/sign-out; member-created items land in the personal tenant | US-1493–1496, 1508, 1515, 1516 |
| eBay lifecycle | Template specifics string-vs-`string[]` publish dead-end; End "succeeds" with no active connection while the listing stays live; multi-account always uses the primary connection; Relist offered on eBay-originated listings (duplicate live listings); send-offer is a guaranteed-fail button until US-1421 scopes land; iOS Disconnect never revokes | US-1505–1512 |

## Verified clean (regression checks that HOLD)

1h refresh fix, Apple `.notFound`≠revoked, email-unverified mapping,
uppercase-UUID minting, photo-link serialization, `.failed`-terminal extract
gate, idempotent End (except the no-connection over-match), condition remap at
publish+revise, drop-safe watermarks, US-1208 create-deferral (except the Retry
bypass), StoreKit purchase guards, keychain classes, 429 handling, deep-link
queueing, thumbnail decode pipeline (`CachedThumbnail`), photo compressor,
eBay-origin locks at every layer, publish preflight/validate UX.

## Method note

Static analysis only (no macOS toolchain on this host). Device/simulator-gated
confirmations (capture-hitch feel, VoiceOver walk, swipe-back reproduction) are
flagged inside the relevant stories. Edge-side portions (US-1502, 1505, 1506,
1507, 1515) are fully verifiable on this host via the deno test suite.
