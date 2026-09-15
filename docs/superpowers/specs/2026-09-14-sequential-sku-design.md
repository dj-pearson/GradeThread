# Sequential SKU numbering

Date: 2026-09-14
Status: approved design, not yet implemented
Owner decision on record: one counter per tenant; seed the counter from the
highest existing SKU and never rewrite a saved row.

## The problem

`inventory_items.sku` is a free-text box. It is typed by hand in
`src/pages/flipdesk/intake.tsx:702` and
`src/components/flipdesk/bulk-intake.tsx:424`, and nothing in the product ever
fills it in. A seller who numbers their inventory 1 to 1031 has to remember
that the next one is 1032, has to type it, and has to not fat-finger it.

Uniqueness is already correct and does not change: `idx_inventory_items_user_sku`
in `supabase/migrations/00008_flipdesk_schema.sql:75` is
`UNIQUE (user_id, sku) WHERE sku IS NOT NULL`. Two different tenants may hold
the same SKU string. Within one tenant a SKU is unique. That is exactly the
rule this feature has to keep.

`inventory_items.user_id` is the workspace OWNER's id, not the acting member's
(`services/edge-functions/src/middleware/workspace.ts:24-27`: "tenant writes
should use this, not userId"). So the tenant is one column on the row being
inserted, and the counter can key off it directly.

## Scope

In scope: assign a SKU to a newly created inventory item when the seller left
the SKU blank and has turned numbering on.

Out of scope, deliberately:

- Renumbering items that already exist. The seed reads them; it never writes
  them.
- Per-bucket counters (per category, per source, per consignor). One counter
  per tenant was chosen explicitly over a "leave room for buckets later" shape,
  so there is no reserved bucket column. Adding buckets later means widening the
  primary key, and that is the correct cost to pay then rather than carrying a
  column that is always the empty string now.
- `listings.inventory_sku`. That column is a snapshot taken at publish time
  (`00477_listings_inventory_sku.sql`) and this feature does not touch it.
- Barcode or label printing.

## Where the number is assigned

A `BEFORE INSERT` trigger on `public.inventory_items`.

Items are created from thirteen places today: `composer.tsx`, `intake.tsx`,
`bulk-intake.tsx`, `snap-catalog.tsx`, `ebay-sku-match.tsx`,
`use-reconcile-commit.ts`, `persist-groups-as-items.ts`, plus edge-side
`closet-import-run.ts`, `buyer-closet.ts`, `flipdesk-google-sync.ts`,
`flipdesk-import.ts` and `flipdesk-scout.ts`, plus the iOS and Android capture
paths. A trigger covers all of them, covers every path added later, and is the
only option that is atomic without a second round trip.

The two alternatives were rejected:

- A shared TypeScript helper called at each insert site needs thirteen edits, a
  Swift port and a Kotlin port, and a forgotten call site fails silently and
  invisibly.
- An edge endpoint that hands out the next value still needs every client to
  remember to call it, and it burns numbers when a draft is abandoned.

### Trigger contract

The trigger fires when ALL of these hold. Any one failing means the trigger
returns `NEW` untouched:

1. `NEW.sku IS NULL OR btrim(NEW.sku) = ''`
2. A `flipdesk_sku_sequences` row exists for `NEW.user_id` with `enabled = true`
3. That row has `exhausted = false`

A SKU the caller supplied is never overwritten, under any setting.

### Claiming a value

Two statements, inside the caller's transaction:

```sql
SELECT pattern, counters, date_stamp, reset_on_date_change
  FROM public.flipdesk_sku_sequences
 WHERE user_id = NEW.user_id
   FOR UPDATE;            -- the lock

-- advance in memory, skipping taken candidates, then write the result once

UPDATE public.flipdesk_sku_sequences
   SET counters = <final>, date_stamp = <stamp>, updated_at = now()
 WHERE user_id = NEW.user_id;
```

It is a `SELECT ... FOR UPDATE` and not a single `UPDATE ... RETURNING` because
the collision skip below may have to advance more than once, and the final
counters are only known after the loop. Both shapes take the same row lock; this
one holds it across the loop, which is what makes the skip safe.

The lock is on the tenant's single sequence row, so two concurrent inserts
serialize and cannot receive the same value. It is held for microseconds. A bulk
import of 500 rows inside one transaction takes 500 sequential claims, which is
fine.

### Collisions with hand-typed SKUs

After rendering a candidate, the trigger checks `inventory_items` for
`(user_id, candidate)`. If it is taken, it advances and tries again, bounded at
`1000` attempts. This is what makes a manually typed `J1235` safe: the
generator walks past it rather than raising a 23505 at the seller.

If 1000 consecutive candidates are all taken, the trigger treats it as
exhaustion (below). 1000 is chosen because it is far past any realistic run of
hand-typed SKUs and still bounded enough that a pathological pattern cannot
spin.

Because of the skip, there is deliberately NO "advance the counter when the
seller types a SKU by hand" rule. It would be a second place for the invariant
to live and it buys nothing.

## The pattern model

A pattern is an ordered array of segments, rendered left to right. Four kinds:

| kind | fields | renders | counts |
|---|---|---|---|
| `text` | `value` | the literal | no |
| `number` | `width`, `min`, `max` | the counter, zero-padded to `width` | yes |
| `letter` | `alphabet`, `width` | counter mapped through `alphabet` | yes |
| `date` | `format` (`YYYY`, `YY`, `MM`, `DD`) | today's value | no |

`width: 0` on a `number` means no padding, so the counter `1032` renders as
`1032` and not `01032`. `alphabet` defaults to `ABCDEFGHIJKLMNOPQRSTUVWXYZ` and
is editable, so a seller can drop `I` and `O` if they confuse them with 1 and 0.

`counters` is a parallel array of integers, one per COUNTING segment (`number`
and `letter`), in the same left-to-right order. `text` and `date` segments
consume no counter slot.

### Advance (the odometer)

Increment the rightmost counting segment. If it passes its max, set it to its
min and carry one into the counting segment to its left. Repeat. If the
leftmost counting segment overflows, the sequence is EXHAUSTED.

The sequence never wraps. Wrapping would hand out a value the tenant already
used, which is the one thing this feature exists to prevent.

Worked cases, both of which come straight out of the rule:

| pattern | counters | renders |
|---|---|---|
| `[number w=0 min=1 max=99999999]` | `[1032]` | `1032`, then `1033` |
| `[letter, number w=4 min=0 max=9999]` | `[9, 9999]` | `J9999`, then `K0000` |

### Date segments and the yearly reset

`date` segments render from `now()` at the time of insert, in the tenant's
configured timezone if one is set, otherwise UTC. They never consume a counter.

`reset_on_date_change` on the pattern, default false. When true, the trigger
renders the pattern's date segments, compares the result to the stored
`date_stamp`, and if they differ resets every counter to its `min` before
claiming. That is what makes `26-00001 ... 26-00842` become `27-00001` on the
first item of the new year.

When false, `date_stamp` is still written but nothing is compared.

## One odometer, not three

The render, advance and parse rules live in exactly one place: three pure
Postgres functions.

```
public.flipdesk_sku_render(pattern jsonb, counters int[], stamp_date date) -> text
public.flipdesk_sku_advance(pattern jsonb, counters int[])                 -> int[]
public.flipdesk_sku_parse(pattern jsonb, candidate text)                   -> int[]
```

All three are `IMMUTABLE` (`render` takes the date as an argument rather than
calling `now()`, so it stays immutable and so the preview can show any date).

The trigger uses them. The settings screen's live preview uses them through a
read-only RPC. The seed uses `parse`.

A TypeScript preview implementation was considered and rejected. Two copies of
the carry rule will drift, and this repo already carries that scar in the three
grading rounding sites. A guard test (`src/test/sku-odometer-single-home.test.ts`)
greps `src/`, `services/edge-functions/src/`, `ios/` and `android/` and fails if
a second implementation appears.

### Parse

`parse` is the inverse of `render`, used only by the seed. It walks the pattern
left to right consuming the candidate string:

- `text` must match its literal exactly, else return NULL
- `date` consumes the right number of characters and discards them, because a
  date does not participate in ordering
- `number` with `width > 0` consumes exactly `width` digits; with `width = 0`
  consumes a greedy run of digits. `flipdesk_sku_save` rejects a `width = 0`
  number segment that is followed by any segment whose rendering can begin with
  a digit, because the greedy run would otherwise swallow it and the parse would
  be ambiguous. In practice that means an unpadded number must be last, or be
  followed by a `text` segment starting with a non-digit.
- `letter` consumes `width` characters, each of which must be in `alphabet`,
  and yields its index

Anything left over at the end, or any segment that fails, returns NULL. A NULL
means "this existing SKU is not one of ours" and the seed ignores it.

Ordering for "the highest" is element-wise comparison of the returned int
arrays, left to right, which is the correct odometer ordering by construction.

## Data model

One new table. Migration `00802_flipdesk_sku_sequences.sql`
(`EXPECTED_SCHEMA_VERSION` is `00801` today, bumped to `00802` in the same
commit per US-1108).

```sql
CREATE TABLE IF NOT EXISTS public.flipdesk_sku_sequences (
  user_id               uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  pattern               jsonb NOT NULL DEFAULT '[]'::jsonb,
  counters              integer[] NOT NULL DEFAULT '{}',
  date_stamp            text,
  reset_on_date_change  boolean NOT NULL DEFAULT false,
  exhausted             boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

### Why not a column on `flipdesk_settings`

Two reasons, and the second is the important one.

The counter changes on every item insert. Putting it on the settings row means
every insert takes a row lock on the row that also holds
`auto_end_cross_listings`, `cross_post_channels`, `lister_locales` and eight
other things, so an unrelated settings write serializes behind item creation.

More importantly the two have opposite access needs. Settings must be writable
by the browser. The counter must NOT be, because a client that can set
`counters` backwards can manufacture duplicate SKUs, which defeats the whole
feature. Separate table, separate policy.

### RLS

`SELECT` for the tenant and their workspace members, matching the predicate
shape used by `inventory_items`' live "Workspace members can view inventory"
policy (the 00451 initplan form: owner fast-path disjunct plus the helper), read
back from `pg_policies` rather than copied off the migration that wrote it.

No `INSERT`, `UPDATE` or `DELETE` policy at all. Every write goes through a
`SECURITY DEFINER` RPC that validates first. The trigger runs as the definer of
the trigger function, which is also how it writes the counter.

Per the standing rule, this migration contains no `REVOKE`.

### RPCs

| function | who | does |
|---|---|---|
| `flipdesk_sku_preview(p_owner, p_pattern, p_counters, p_count)` | any workspace member | returns the next `p_count` SKUs, no writes |
| `flipdesk_sku_seed(p_owner, p_pattern)` | owner or admin role | parses every existing SKU for that tenant, returns the counters that would follow the highest match. No writes |
| `flipdesk_sku_save(p_owner, p_pattern, p_counters, p_enabled, p_reset)` | owner or admin role | validates and upserts the row |

`flipdesk_sku_save` validates:

- at least one counting segment, else there is nothing to increment
- `width >= 0`, `min <= max`, `max` within int range
- `alphabet` non-empty, no duplicate characters
- rendered length of the pattern at its maximum counters is <= 50 characters.
  Nothing in the schema caps `inventory_items.sku` today, but the eBay Inventory
  API caps its own SKU at 50, and this string is what a seller will reach for
  when they fill `listings.inventory_sku`. Capping at creation is cheaper than
  discovering it at publish time
- `counters` length equals the counting-segment count
- each counter within its segment's min and max
- clears `exhausted` on any successful save, since a widened pattern un-exhausts

Every RPC resolves the caller's right to act on `p_owner` through the same
workspace-role check the edge middleware uses, so a viewer cannot save and a
member of another workspace cannot read.

## Exhaustion

When the leftmost counting segment overflows, or the 1000-attempt collision
skip runs out, the trigger sets `exhausted = true` and returns `NEW` with `sku`
still NULL. The item saves.

This was chosen over raising an exception. A seller in the middle of a photo
session should not hit a wall they cannot diagnose, and an unsaved item is
worse than an unnumbered one. The cost is that a blank SKU can appear silently,
so it is paired with:

- a warning banner on the SKU settings screen
- a warning on the FlipDesk inventory page when `exhausted` is true
- the banner names the fix: widen the pattern, then save, which clears the flag

## Changing the pattern later

Old SKUs keep their old shape; nothing is rewritten. On any pattern edit the
settings screen re-runs `flipdesk_sku_seed` against the new pattern and shows
the new starting point, pre-filled and editable.

The seller can also type a starting value directly. `flipdesk_sku_save`
validates it against the segment bounds but does not require it to be higher
than the current one, because a seller may legitimately want to go back and
fill a gap. The trigger's collision skip is what keeps that safe.

## UI

New route `/dashboard/flipdesk/settings/sku`, rendered by
`src/pages/flipdesk/sku-numbering.tsx`.

It is not a nav surface. It gets a `CONTEXTUAL_ROUTES` entry in
`src/lib/surfaces.ts` saying it is reached from the SKU field in the item editor
and from the FlipDesk inventory page, which is where a seller is standing when
they want it. `src/test/surface-registry.test.ts` fails otherwise.

Screen contents:

1. An on/off switch.
2. A preset picker. Each preset writes a complete pattern, so nobody has to
   think in segments to get started:
   - Plain number: `1, 2, 3`
   - Padded number: `0001`
   - Prefix plus number: `GT-1001`
   - Letter plus four digits: `J0000`
   - Year plus number, resets each January: `26-00001`
3. A segment editor below the presets for anyone who wants to build their own.
   Add, remove, reorder, and per-kind fields.
4. A live preview of the next five SKUs, from `flipdesk_sku_preview`, debounced.
5. A "Next SKU" field, pre-filled from `flipdesk_sku_seed` with a line saying
   what it found: "Your highest matching SKU is 1031, so the next one is 1032."
6. The exhaustion banner when the flag is set.

Entry points added: a small link under the SKU input in `intake.tsx` and
`bulk-intake.tsx` reading "Number these automatically", and a link from the
FlipDesk inventory page header.

The SKU inputs themselves get a placeholder showing the next value when
numbering is on, so the seller can see what they will get if they leave it blank.

## Testing

### Database lane (`npm run verify:db`)

`scripts/check-sku-sequences.mjs`, following the pattern of
`scripts/check-created-by.mjs` and `scripts/check-inventory-writeoffs.mjs`,
wired into `scripts/verify.mjs`'s db lane. It asserts, against a real Postgres
with every migration applied:

1. `[number w=0]` from 1031 produces 1032 then 1033.
2. `[letter, number w=4]` at `J9999` produces `K0000`.
3. `[letter, number w=4]` at `Z9999` sets `exhausted` and leaves `sku` NULL,
   and the item still saves.
4. 50 concurrent inserts for one tenant produce 50 distinct SKUs.
5. A hand-planted `J1235` is skipped: the generator emits `J1234` then `J1236`.
6. A supplied SKU is never overwritten, numbering on or off.
7. `reset_on_date_change` resets the counters when the rendered date stamp moves.
8. Seeding against 1..1031 returns 1032, and ignores SKUs that do not parse.
9. Insert as a workspace MEMBER of another owner's workspace draws from the
   OWNER's counter, not the member's. Writing `auth.uid()` instead of
   `NEW.user_id` looks identical without this case.
10. Numbering off means the SKU stays exactly as supplied, including NULL.

The RPC bodies are additionally covered by the existing
`scripts/check-rpc-column-refs.mjs`, which executes every RPC the edge invokes
inside a rolled-back transaction, so a function that installs cleanly and raises
on call is caught.

### Web

- `src/test/sku-odometer-single-home.test.ts`: the guard against a second
  implementation of the carry rule in TypeScript, Swift or Kotlin.
- `src/test/surface-registry.test.ts`: already exists, will fail until the
  `CONTEXTUAL_ROUTES` entry lands.
- A component test of the settings page: preset click fills the segment editor,
  invalid input disables save, exhaustion banner renders on the flag.

### Not tested here

iOS and Android need no code change at all, which is the point of putting the
logic in the trigger. There is nothing to compile and nothing to port.

## Migration and rollout

- `00802_flipdesk_sku_sequences.sql`, idempotent, with the self-record footer.
- `EXPECTED_SCHEMA_VERSION` bumped `00801` to `00802` in the same commit.
- `PENDING_MIGRATIONS.md` updated.
- Per the standing rule the migration is committed locally and NOT applied to
  production. It waits for the owner's go-ahead.
- The feature is off for every existing tenant, because `enabled` defaults to
  false and no row is created until someone saves settings. Nothing changes for
  anyone until they turn it on.
- Rollback is `UPDATE flipdesk_sku_sequences SET enabled = false`. The trigger
  becomes a no-op and hand-typed SKUs work exactly as they do today.

## Open questions

None. The two decisions that were open (one counter per tenant, and seed from
the highest existing SKU without rewriting rows) were settled by the owner on
2026-09-14.
