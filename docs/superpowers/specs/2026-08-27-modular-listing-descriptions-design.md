# Modular listing descriptions

Date: 2026-08-27
Status: approved design, ready for an implementation plan

## The problem

A FlipDesk listing description is one opaque string. The AI writes the whole
thing in a single pass, and the prompt tells it to include "a clean opening
line, then attribute bullets, then the condition statement, then measurements"
(`services/edge-functions/src/lib/ai-listing.ts:421`). Four marker-delimited
blocks are then appended to that string: disclosure, seller credentials,
measurements, and the machine-readable facts block.

The result is that the same fact appears in up to three places, and only one of
them can be updated. A real listing from 2026-08:

```
Veronica Beard jogger-style pants, new with tags.

- Brand: Veronica Beard
- Size: 8
- Measurements (approx, laid flat): Waist 18" across, Length 41.5"   <- prose, frozen
...
<!--gradethread-measurements-->
- Waist (flat): 30 in (15 in flat)                                   <- block, updates
- Length: 39.5 in
<!--/gradethread-measurements-->
<!--gradethread-facts--><ul>...Measurements (flat, inches): ...</ul> <- block, updates
```

Editing the measurements updates two of the three. The prose keeps advertising
a 41.5 inch length next to a block that says 39.5. The only way to clear it is a
full AI rewrite, which throws away every other edit the seller made.

Brand, size, color, material and condition have the same shape of problem. Any
change to a field means either living with a contradiction or regenerating
everything.

## What we are building

The description becomes an ordered list of named blocks. Facts live in exactly
one block each. The AI writes only the parts that are genuinely prose. Changing
a field re-renders the one block that shows it. Removing a redundant section is
a toggle, not a rewrite.

## Decisions

These were settled during brainstorming and are not open in the plan.

1. **Blocks are the source of truth.** `listings.listing_description` survives
   as render output only and is never edited directly.
2. **The composer gets a block list** with per-block on/off, drag reorder, and a
   live preview of the exact string eBay will receive.
3. **Legacy descriptions convert when opened**, not by backfill. No stored row
   is rewritten until the seller saves.
4. **The AI writes three blocks** (intro, features, condition) in one call, each
   independently regenerable, and is barred from restating field facts.
5. **Standing lines live on the account** as reusable snippets, referenced by
   id, with a per-listing override.
6. **The renderer lives in the edge service only.** Clients hold blocks and ask
   the server for the rendered text.
7. **Web ships first.** iOS and Android follow as separate stories in the epic.

## Why `listing_description` has to stay

Three features read that column directly:

- Full-text search weights it (`supabase/migrations/00016_full_text_search.sql:28`).
- Fuzzy search history reads it (`00248_fuzzy_search_history.sql:101`).
- Return attribution matches a defect's text against it (`00655_flipdesk_return_attribution.sql:17`).

Dropping the column would mean rewriting all three against a jsonb array, which
is worse in every dimension. Keeping it is not a cache in the sense of a second
editable copy. It is derived state, written by one function, in the same update
as the blocks it was rendered from, so the two cannot disagree.

## Data model

### `listings.description_blocks jsonb`

An ordered array. Order is render order.

```json
[
  { "key": "intro",        "on": true,  "src": "ai",      "text": "..." },
  { "key": "features",     "on": true,  "src": "ai",      "text": "..." },
  { "key": "attributes",   "on": true,  "src": "item",    "fields": ["brand","size","color","material"] },
  { "key": "condition",    "on": true,  "src": "ai",      "text": "..." },
  { "key": "measurements", "on": true,  "src": "item",    "unit": "in" },
  { "key": "grade",        "on": false, "src": "grade" },
  { "key": "snippet",      "on": true,  "src": "account", "ref": "8f2c-..." },
  { "key": "credentials",  "on": true,  "src": "seller" },
  { "key": "facts",        "on": true,  "src": "system" }
]
```

Fields on every block: `key` (the block type), `on` (boolean), `src` (who owns
the content). Then per-type extras: `text` for anything free-form, `fields` for
`attributes`, `unit` for `measurements`, `ref` for `snippet`.

`null` in this column means the listing predates the feature. That is the signal
to parse the legacy string on open.

### Block types

| key | src | Content comes from | Editable |
| --- | --- | --- | --- |
| `intro` | ai | AI, stored `text` | yes |
| `features` | ai | AI, stored `text` | yes |
| `condition` | ai | AI, stored `text` | yes |
| `attributes` | item | `inventory_items` columns named in `fields` | no, edit the field |
| `measurements` | item | `inventory_items.measurements` | no, edit the field |
| `grade` | grade | `grade_reports.overall_score` | no |
| `disclosure` | grade | `buildDisclosure()` | no |
| `credentials` | seller | `loadSellerCredentialBlock()` | no, server-gated |
| `facts` | system | `buildListingFactsBlock()` | no |
| `snippet` | account | `listing_snippets.body`, by `ref` | yes, as an override |
| `text` | user | stored `text` | yes |

Derived blocks store no text. That is what makes drift impossible.

### Pinned positions

`facts` renders last and is not draggable. US-2682 requires a fixed position so
that a revise on a live listing can replace it rather than accumulate a second
copy (`listing-facts-block.ts:248`). `disclosure` is pinned immediately after
`condition` for the same replace-in-place reason.

Everything else is free to move.

### `listing_snippets`

New table, one row per saved standing block.

```sql
CREATE TABLE IF NOT EXISTS public.listing_snippets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  body        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

RLS mirrors `flipdesk_settings` (`00134_cross_listing_dispatch.sql:34`): the
owner selects, inserts, updates and deletes their own rows; the edge service
reads through the service-role client during render.

A listing's `snippet` block stores only `ref`. Editing the snippet changes every
listing that references it, on the next render. A block that also carries `text`
uses that text instead, which is the per-listing override.

Migration follows the US-1108 triple: idempotent SQL, `EXPECTED_SCHEMA_VERSION`
bumped in the same commit, self-recording footer.

## The renderer

New pure module: `services/edge-functions/src/lib/description-blocks.ts`. No
I/O, unit-tested directly, same discipline as `listing-facts-block.ts`.

```ts
renderDescription(blocks: Block[], ctx: RenderContext): string
parseLegacyDescription(description: string): Block[]
defaultBlocks(): Block[]
scrubRestatedFacts(text: string, ctx: RenderContext): string
```

`RenderContext` carries the item row, the grade report row (or null), the
resolved seller credential HTML (or null), the resolved snippet bodies, and the
length unit. The module resolves nothing itself; the caller loads and passes.

### `renderDescription`

Walks the block array in order, skipping `on: false`. Each block type has one
render function. Blocks that render to an empty string are dropped along with
their spacing, so an item with no measurements does not leave a heading over
nothing. `facts` is moved to the end regardless of its array position, as a
safety net against a client that reordered it.

The existing block builders are reused rather than reimplemented:
`buildMeasurementsBlock` (`measurements.ts:246`), `buildDisclosure`,
`buildSellerCredentialBlock` (`seller-credentials.ts:66`), and
`buildListingFactsBlock` (`listing-facts-block.ts:132`). Their markers stay in
the output, which keeps every existing parser and the credentials refresh cron
working during rollout.

### `parseLegacyDescription`

Splits an old description into blocks:

- Text before the first known marker becomes one `text` block, verbatim.
- `<!--gradethread-measurements-->` becomes a `measurements` block.
- `<!--gradethread-disclosure-->` becomes a `disclosure` block.
- `<!--gradethread-seller-credentials-->` becomes a `credentials` block.
- `<!--gradethread-facts-->` becomes a `facts` block.
- Anything between marker blocks becomes another `text` block, in place.

The parse never discards characters. A description that fails to parse cleanly
degrades to a single `text` block holding the whole string, which renders
byte-identical to what is stored today. That is the safety property: the worst
case is exactly the current behaviour.

The parse result is returned but not persisted. The seller's first save is what
writes it.

### `scrubRestatedFacts`

Applied to AI block text at generation and at redo. Removes a line that restates
a field the derived blocks already carry: a line matching `Brand:`, `Size:`,
`Color:`, `Material:`, `Condition:`, or a measurements heading followed by
numeric lines. It removes whole lines only, never edits inside a sentence, so it
cannot mangle prose. Anything it removes is logged so we can see whether the
prompt or the scrubber is doing the work.

## Persistence

One helper writes descriptions, in the edge service:

```ts
renderAndPersistDescription(listingId: string, ownerId: string): Promise<string>
```

It loads the item, grade report, seller credential and snippets for that
listing, renders, and writes `description_blocks` and `listing_description` in a
single `.update()`. Both columns always agree because one function writes both.

Five callers replace five separate assembly sites:

1. **Generation** (`ai-listing.ts:2388-2478`). The chain of
   `applyMeasurementsBlock`, disclosure string concatenation and
   `upsertListingFactsBlock` collapses into building a block array.
2. **Composer save.** `saveDraft()` writes item and listing fields as it does
   today, then calls the save route last, so derived blocks read the values that
   just landed.
3. **Item page measurement save.** Same route, so measurements stay in step
   without the composer being open.
4. **Credentials refresh cron** (`jobs-credentials-refresh.ts:142`). Re-renders
   instead of walking `<div>` depth. `findSellerCredentialBlock` and its
   `MAX_TAG_SCAN` bail-out (`seller-credentials.ts:173`) are no longer on the
   write path.
5. **Snippet edit.** "Apply to open drafts" re-renders every draft that
   references the edited snippet.

## Routes

All under `/api/flipdesk/description/`, on the edge service
(`functions.gradethread.com`, not `api.`).

| Route | Does |
| --- | --- |
| `GET /:listingId/blocks` | Returns blocks. When `description_blocks` is null, parses the legacy string and returns that without saving. |
| `POST /preview` | Renders an unsaved block array against a listing's context. Returns the string. |
| `POST /:listingId/save` | Persists blocks, renders, writes both columns. |
| `POST /:listingId/regenerate` | Regenerates one AI block. Body names the block key. |

Every route is service-role against multi-tenant tables, so every route scopes
on `c.get("workspaceOwnerId") ?? c.get("userId")` and every route gets a case in
`services/edge-functions/src/tests/tenant-isolation_test.ts` (US-268).

`POST /preview` takes a listing id for context, so it is ownership-checked like
the rest. It does not accept a free-floating item payload.

## AI generation

The `create_ebay_listing` tool schema gains three string fields in place of the
single `description`:

- `description_intro` - one or two sentences naming the garment and what makes
  it worth buying.
- `description_features` - the construction and styling details a photo shows:
  closure, pockets, trim, cuffs, lining, hardware.
- `description_condition` - an honest condition narrative.

Prompt rules added to both `LISTING_GEN_SYSTEM_PROMPT` and
`LISTING_GEN_SYSTEM_PROMPT_V2`:

> Do not state brand, size, color, material, condition grade, or any
> measurement as a labelled fact in these three fields. Those are rendered
> separately from the item's own data, and repeating them creates a
> contradiction the seller cannot fix. Describe the garment; do not list it.

Cost is unchanged: one call returns all three. `POST /:listingId/regenerate`
makes a smaller call that returns one field.

`description` stays in the tool schema as an optional fallback for one release,
mapped to `intro` when the three new fields come back empty, so a model that
ignores the change still produces a working listing.

## Composer UI

`src/components/flipdesk/composer/description-card.tsx` (124 lines) is replaced
by a block list. `@dnd-kit/sortable` is already a dependency and is reused for
reordering.

Row anatomy, as rows inside the existing card rather than cards inside a card:

```
[::]  (o) Intro           AI       Veronica Beard jogger-style pants...   [edit] [redo]
[::]  (o) Features        AI       Pull-on with elastic drawstring...     [edit] [redo]
[::]  (o) Attributes      Item     Brand, Size, Color, Material           [go to field]
[::]  (o) Condition       AI       Brand new, never worn, tags...         [edit] [redo]
[::]  (o) Measurements    Item     6 values, inches                       [go to field]
[::]  ( ) Grade badge     Grade    8.3 / 10
[::]  (o) Policy note     Snippet  Please review measurements and...      [edit]
      (o) Verified seller Seller   23 items, 8.3 average           locked
      (o) Item facts      System   fixed, last
```

- Toggling off dims the row and drops it from the render. The row keeps its
  place, so toggling back on restores the order.
- Edit opens a textarea in place. No modal, no page jump.
- Redo regenerates that block alone.
- "Go to field" scrolls to and focuses the real input in the Item Details or
  Measurements card on the same page.
- The last two rows have no drag handle.

A collapsible preview panel sits below the list, closed by default. It calls
`POST /preview` debounced at 400ms and shows the exact string eBay receives plus
a character count.

`autolister-bulk-edit.tsx` gets the toggle set only, no per-block text. Turning
`measurements` off across forty drafts is a bulk operation; typing forty intros
is not.

### What gets removed

The composer's stale-description warning (`composer.tsx:1596`,
`descriptionMentions` at line 272) exists because an item specific could drift
from the prose that restated it. With `attributes` derived from the same
columns, drift cannot happen, and the warning is deleted rather than left to
fire on nothing.

### Craft floor

`npm run ui:check` has a zero baseline. Rows carry no colored left border,
source tags are plain small text rather than badges, there are no cards inside
the card, and no gradient. The drag handle is a `lucide-react` icon.

## Snippets settings page

New route `/dashboard/flipdesk/settings/blocks`, registered in
`src/routes/index.tsx`. Name, body, reorder, delete. Reads and writes
`listing_snippets` directly through the browser Supabase client under RLS, like
the other FlipDesk settings surfaces.

Saving a snippet offers "apply to N open drafts". That action only touches rows
with `listing_status = 'draft'`. A published listing is never rewritten without
the seller pushing it.

## Testing

**Edge unit tests** (`description-blocks_test.ts`), on the pure module:

- Render order follows array order, `facts` always last.
- A disabled block contributes nothing, including its spacing.
- An empty derived block leaves no orphan heading.
- Render is idempotent: rendering twice from the same blocks gives the same
  string.
- `parseLegacyDescription` round-trips the real 2026-08 Veronica Beard
  description above, and re-rendering the parse output equals the input.
- A description with no markers parses to a single `text` block that renders
  byte-identical to the input.
- A malformed marker pair degrades to a single `text` block rather than losing
  characters.
- `scrubRestatedFacts` removes a `- Size: 8` line and leaves a sentence
  containing the word "size" alone.
- Snippet `ref` resolves; a `ref` pointing at a deleted snippet renders nothing
  and does not throw.
- Per-listing `text` overrides the referenced snippet body.

**Edge route tests:**

- Each of the four routes gets a `tenant-isolation_test.ts` case proving another
  user's listing id returns 404, not data.
- `GET /blocks` on a legacy listing returns parsed blocks and does not write.
- `POST /save` writes both columns in one update, and the rendered column
  matches `renderDescription` of the saved blocks.

**Web tests** (vitest):

- Toggling a block off and on restores its position.
- Reorder produces the expected block array.
- Preview is debounced and the last response wins on out-of-order replies.
- The bulk-edit toggle set applies to every selected draft.

**Manual, on the throwaway local stack:** open a real legacy draft, confirm the
preview matches the stored description byte for byte before any edit. That is
the check that convert-on-open is safe.

## Rollout

1. Migration and `listing_snippets`, behind no flag. Adding a nullable column
   and a new table changes nothing on its own.
2. Edge module, routes and the persist helper. Generation still writes the old
   string path.
3. Generation switches to blocks. New listings get `description_blocks`; old
   ones stay null.
4. Composer block list ships. Legacy listings convert on open.
5. Snippets settings page.
6. iOS and Android editors, as separate stories.

No feature flag. Each step is inert until the next one uses it, and step 4 is
the only one a seller can see. If step 4 has to be reverted, the descriptions it
already saved are ordinary strings that the old composer edits fine.

## Risks

**A legacy parse loses text.** Mitigated by the degrade-to-one-text-block rule
and by the byte-identical round-trip test. The parse is also never persisted
without a save, so a bad parse is visible in the preview before it is stored.

**The model ignores the three-field prompt change.** Mitigated by keeping
`description` as an optional fallback for one release and by `scrubRestatedFacts`
catching restated facts regardless of which field they land in.

**A live listing's description changes shape on the next revise.** The seller
sees the preview before pushing, and `facts` and `disclosure` stay pinned so
their replace-in-place behaviour is unchanged. Published listings are never
re-rendered by a background job except the credentials refresh cron, which
already rewrites them today.

**Preview round trips feel slow.** Debounced at 400ms, and only AI and snippet
blocks can change without a save anyway. If it reads badly in use, the fallback
is rendering plain text blocks locally and asking the server only for derived
ones.

## Out of scope

- iOS and Android block editors. Same epic, separate stories.
- Cross-marketplace description variants. Blocks make this straightforward
  later; nothing here assumes eBay beyond the existing block builders.
- Removing the marker comments from the rendered output. They stay, because
  other code reads them.
- Templates per garment group. `DESCRIPTION_TEMPLATES`
  (`src/lib/listing-templates.ts:10`) keeps working as a way to seed block text;
  it is not replaced in this epic.
