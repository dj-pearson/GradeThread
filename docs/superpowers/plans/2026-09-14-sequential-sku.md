# Sequential SKU Numbering Implementation Plan

> **For agentic workers:** this plan is executed by the Ralph loop, one prd.json
> story per task. Each story names its task here. Read the spec AND your task
> before writing anything. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A tenant can define their own SKU shape once in settings, and every
item they create afterwards with a blank SKU gets the next number in that shape,
with no duplicates inside the tenant.

**Architecture:** A `BEFORE INSERT` trigger on `inventory_items` fills a blank
SKU from a per-tenant counter row. The pattern is a segment list advanced like a
car odometer, so `1032 -> 1033` and `J9999 -> K0000` come out of one rule. The
render, advance and parse logic lives only in Postgres, so the settings preview
cannot drift from the generator.

**Tech Stack:** PostgreSQL (plpgsql, jsonb), React 19 + TypeScript + Tailwind v4
+ shadcn/ui, TanStack Query, Supabase RPC from the browser.

**Spec:** `docs/superpowers/specs/2026-09-14-sequential-sku-design.md`

## Global Constraints

- Three migrations, `00802`, `00803`, `00804`. Each follows the US-1108 triple:
  idempotent SQL, `EXPECTED_SCHEMA_VERSION` in
  `services/edge-functions/src/lib/schema-version.ts` bumped in the SAME commit,
  and the self-record footer
  `insert into public.applied_migrations (version) values ('008NN') on conflict do nothing;`
- **No `REVOKE` in any of these migrations.** A denied call segfaults the
  self-hosted DB. Standing owner rule.
- **Do not apply any of these to production.** Commit locally, leave them held.
  `PENDING_MIGRATIONS.md` gets an entry; the owner applies them.
- `counters` always means **the next value to issue**, never the last one
  issued. Every function, RPC and UI label depends on this. `render(counters)`
  is the next SKU, with no advance in between.
- Plain ASCII in all SQL and TypeScript. No curly quotes, no en/em dashes. A
  look-alike character in a SQL literal is a runtime failure.
- US spelling in every user-facing string.
- Named exports, `@/` import alias, kebab-case filenames, `cn()` for classes,
  icons from `lucide-react` only, toasts via `sonner`.
- `npm run build` uses `tsc -b`. Verify with the build, not `tsc --noEmit`.
- Frontend has `noUncheckedIndexedAccess` on: indexing an array yields
  `T | undefined`.

---

### Task 1: The odometer, the table, and its proof

**prd story:** US-3414

**Files:**
- Create: `supabase/migrations/00802_flipdesk_sku_sequences.sql`
- Create: `scripts/fixtures/sku-odometer.sql`
- Create: `scripts/check-sku-sequences.mjs`
- Create: `src/test/sku-odometer-single-home.test.ts`
- Modify: `services/edge-functions/src/lib/schema-version.ts` (`00801` -> `00802`)
- Modify: `scripts/verify.mjs` (add the check to the db lane)
- Modify: `PENDING_MIGRATIONS.md`

**Interfaces:**
- Produces, and every later task consumes:
  - `public.flipdesk_sku_bounds(p_pattern jsonb) -> jsonb`
  - `public.flipdesk_sku_floor(p_pattern jsonb) -> integer[]`
  - `public.flipdesk_sku_base(p_value int, p_alphabet text, p_width int) -> text`
  - `public.flipdesk_sku_render(p_pattern jsonb, p_counters integer[], p_stamp date) -> text`
  - `public.flipdesk_sku_render_date(p_pattern jsonb, p_stamp date) -> text`
  - `public.flipdesk_sku_advance(p_pattern jsonb, p_counters integer[]) -> integer[]`
  - `public.flipdesk_sku_parse(p_pattern jsonb, p_candidate text) -> integer[]`
  - table `public.flipdesk_sku_sequences`

**The pattern JSON, which every task reads and writes:**

```json
[
  { "kind": "text",   "value": "GT-" },
  { "kind": "date",   "format": "YY" },
  { "kind": "letter", "alphabet": "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "width": 1 },
  { "kind": "number", "width": 4, "min": 0, "max": 9999 }
]
```

`text` and `date` consume no counter slot. `letter` and `number` each consume
one, left to right, so `counters` here has length 2. A `letter` segment's bounds
are derived (`0` to `length(alphabet)^width - 1`); a `number` segment always
carries explicit `min` and `max`, written by the save RPC in Task 3.

- [ ] **Step 1: Write the failing fixture**

Create `scripts/fixtures/sku-odometer.sql`. One transaction that rolls back,
emitting a single JSON object on the last line, exactly like
`scripts/fixtures/created-by-tracking.sql`.

```sql
-- US-3414 -- the SKU odometer renders, advances and parses.
--
-- These are pure functions, so this fixture inserts nothing and reads nothing.
-- It exists because `CREATE FUNCTION` does not validate a plpgsql body: a
-- function with a typo in it installs cleanly and raises on first call, and a
-- source scan reads that as correct.
--
-- Run it with: node scripts/check-sku-sequences.mjs

begin;

with pat as (
  select
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb        as plain,
    '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
       {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb           as jnum,
    '[{"kind":"text","value":"GT-"},{"kind":"date","format":"YY"},
       {"kind":"text","value":"-"},
       {"kind":"number","width":5,"min":1,"max":99999}]'::jsonb          as dated
)
select jsonb_pretty(jsonb_build_object(
  -- 1. An unpadded number renders with no leading zeros.
  'plain_1032',      public.flipdesk_sku_render(plain, array[1032], date '2026-09-14'),
  'plain_next',      public.flipdesk_sku_render(plain,
                       public.flipdesk_sku_advance(plain, array[1032]), date '2026-09-14'),
  -- 2. The letter wheel carries. J is index 9.
  'j9999',           public.flipdesk_sku_render(jnum, array[9, 9999], date '2026-09-14'),
  'j9999_next',      public.flipdesk_sku_render(jnum,
                       public.flipdesk_sku_advance(jnum, array[9, 9999]), date '2026-09-14'),
  'j1234',           public.flipdesk_sku_render(jnum, array[9, 1234], date '2026-09-14'),
  -- 3. The leftmost wheel overflowing returns NULL, it does not wrap.
  'z9999_next_null', public.flipdesk_sku_advance(jnum, array[25, 9999]) is null,
  -- 4. Date segments render from the argument and consume no counter.
  'dated',           public.flipdesk_sku_render(dated, array[42], date '2026-09-14'),
  'date_stamp',      public.flipdesk_sku_render_date(dated, date '2026-09-14'),
  -- 5. Parse is the inverse of render.
  'parse_plain',     public.flipdesk_sku_parse(plain, '1031'),
  'parse_jnum',      public.flipdesk_sku_parse(jnum, 'J1234'),
  'parse_dated',     public.flipdesk_sku_parse(dated, 'GT-26-00042'),
  -- 6. A SKU that is not ours parses to NULL rather than to garbage.
  'parse_foreign',   public.flipdesk_sku_parse(jnum, 'hoodie-blue') is null,
  'parse_short',     public.flipdesk_sku_parse(jnum, 'J123') is null,
  'parse_trailing',  public.flipdesk_sku_parse(jnum, 'J1234X') is null,
  'parse_badletter', public.flipdesk_sku_parse(jnum, '91234') is null,
  -- 7. The floor is the min of every counting segment.
  'floor_jnum',      public.flipdesk_sku_floor(jnum),
  -- 8. The table exists with the defaults the trigger relies on.
  'table_defaults',  (select jsonb_build_object(
                        'enabled',  (select column_default from information_schema.columns
                                      where table_name = 'flipdesk_sku_sequences'
                                        and column_name = 'enabled'),
                        'exhausted',(select column_default from information_schema.columns
                                      where table_name = 'flipdesk_sku_sequences'
                                        and column_name = 'exhausted')))
)) from pat;

rollback;
```

- [ ] **Step 2: Write the runner and wire it into the db lane**

Create `scripts/check-sku-sequences.mjs`. Copy the shape of
`scripts/check-created-by.mjs`: shell out to
`docker exec -i supabase_db_gradethread psql -U postgres -d postgres -t -A`,
feed it the fixture, take the last `{...}` out of stdout, `JSON.parse` it, then
assert. Support `--container`. Exit 2 when Postgres is unreachable, 1 on a
failed assertion.

The assertions:

```js
const expect = (key, want) => {
  const got = r[key];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

expect("plain_1032", "1032");
expect("plain_next", "1033");
expect("j9999", "J9999");
expect("j9999_next", "K0000");          // the whole reason this feature exists
expect("j1234", "J1234");
expect("z9999_next_null", true);
expect("dated", "GT-26-00042");
expect("date_stamp", "26");
expect("parse_plain", [1031]);
expect("parse_jnum", [9, 1234]);
expect("parse_dated", [42]);
expect("parse_foreign", true);
expect("parse_short", true);
expect("parse_trailing", true);
expect("parse_badletter", true);
expect("floor_jnum", [0, 0]);
```

Then in `scripts/verify.mjs`, inside the db lane, after the
`run("db: created_by is stamped and immutable (US-3023)", ...)` line:

```js
// US-3414: the SKU odometer is four plpgsql functions and a carry rule. A
// CREATE FUNCTION that installs cleanly says nothing about whether the body
// runs, and the whole feature is one string that is either unique inside the
// tenant or is not. This calls every function with the two patterns the owner
// actually uses.
run("db: SKU odometer renders and carries (US-3414)", "node scripts/check-sku-sequences.mjs");
```

- [ ] **Step 3: Run it to verify it fails**

```bash
docker start supabase_db_gradethread
node scripts/check-sku-sequences.mjs
```

Expected: FAIL with `function public.flipdesk_sku_render(...) does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/00802_flipdesk_sku_sequences.sql`. Open it with a
header saying what the table is for and why it is not a column on
`flipdesk_settings` (the counter changes on every insert, and the browser must
be able to read it but never write it).

```sql
create table if not exists public.flipdesk_sku_sequences (
  user_id               uuid primary key references public.users(id) on delete cascade,
  enabled               boolean not null default false,
  pattern               jsonb not null default '[]'::jsonb,
  counters              integer[] not null default '{}',
  date_stamp            text,
  reset_on_date_change  boolean not null default false,
  exhausted             boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on column public.flipdesk_sku_sequences.counters is
  'US-3414: the NEXT value to issue, one integer per counting segment in pattern, left to right. render(pattern, counters) IS the next SKU -- nothing advances first. Seeding a tenant whose highest SKU is 1031 stores {1032}.';

drop trigger if exists set_flipdesk_sku_sequences_updated_at on public.flipdesk_sku_sequences;
create trigger set_flipdesk_sku_sequences_updated_at
  before update on public.flipdesk_sku_sequences
  for each row execute function public.set_updated_at();

alter table public.flipdesk_sku_sequences enable row level security;
```

Then the policy. SELECT only, no INSERT/UPDATE/DELETE policy at all, because
every write goes through a SECURITY DEFINER function. Before writing it, read
the live predicate back:

```bash
docker exec -i supabase_db_gradethread psql -U postgres -d postgres -c \
  "select qual from pg_policies where tablename='inventory_items' and policyname='Workspace members can view inventory';"
```

Use that exact shape, which at time of writing is the 00451 initplan form:

```sql
drop policy if exists "Workspace members can view sku sequence" on public.flipdesk_sku_sequences;
create policy "Workspace members can view sku sequence"
  on public.flipdesk_sku_sequences for select
  using (
    (select auth.uid()) = user_id
    or public.is_workspace_member_with_role(user_id, 'viewer')
  );
```

The owner fast-path disjunct is not decoration: without it the planner calls the
SECURITY DEFINER helper for owner rows too, and
`scripts/db-rls-initplan-check.mjs` runs in this same lane.

Then the functions. `flipdesk_sku_base` first, because `render` calls it:

```sql
-- Value to a fixed-width string in base length(alphabet). Returns NULL when the
-- value does not fit in p_width characters, which is how the letter wheel
-- reports its own overflow.
create or replace function public.flipdesk_sku_base(
  p_value int, p_alphabet text, p_width int
) returns text
language plpgsql immutable
as $$
declare
  base  int  := length(coalesce(p_alphabet, ''));
  v     int  := p_value;
  out_s text := '';
  i     int;
begin
  if base < 1 or coalesce(p_width, 0) < 1 or v is null or v < 0 then
    return null;
  end if;
  for i in 1..p_width loop
    out_s := substr(p_alphabet, (v % base) + 1, 1) || out_s;
    v := v / base;                      -- integer division, both operands int
  end loop;
  if v <> 0 then
    return null;                        -- did not fit in p_width
  end if;
  return out_s;
end;
$$;
```

```sql
-- One {min,max} per COUNTING segment, left to right. A letter wheel's bounds
-- are derived from its alphabet and width; a number wheel carries its own.
create or replace function public.flipdesk_sku_bounds(p_pattern jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(b order by ord), '[]'::jsonb)
  from (
    select ord,
      case seg->>'kind'
        when 'number' then jsonb_build_object(
          'min', coalesce((seg->>'min')::int, 0),
          'max', coalesce((seg->>'max')::int, 0))
        when 'letter' then jsonb_build_object(
          'min', 0,
          'max', power(
                   length(coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')),
                   coalesce((seg->>'width')::int, 1)
                 )::int - 1)
      end as b
    from jsonb_array_elements(coalesce(p_pattern, '[]'::jsonb))
         with ordinality t(seg, ord)
  ) s
  where b is not null;
$$;
```

```sql
create or replace function public.flipdesk_sku_floor(p_pattern jsonb)
returns integer[]
language sql immutable
as $$
  select coalesce(array_agg((b->>'min')::int order by ord), '{}'::integer[])
  from jsonb_array_elements(public.flipdesk_sku_bounds(p_pattern))
       with ordinality t(b, ord);
$$;
```

```sql
-- The date segments alone, concatenated. Stored as date_stamp so the trigger
-- can tell that the period rolled over without re-deriving it.
create or replace function public.flipdesk_sku_render_date(
  p_pattern jsonb, p_stamp date
) returns text
language sql immutable
as $$
  select coalesce(string_agg(
    to_char(coalesce(p_stamp, date '2000-01-01'),
            case seg->>'format'
              when 'YYYY' then 'YYYY'
              when 'YY'   then 'YY'
              when 'MM'   then 'MM'
              when 'DD'   then 'DD'
              else 'YYYY'
            end),
    '' order by ord), '')
  from jsonb_array_elements(coalesce(p_pattern, '[]'::jsonb))
       with ordinality t(seg, ord)
  where seg->>'kind' = 'date';
$$;
```

```sql
create or replace function public.flipdesk_sku_render(
  p_pattern jsonb, p_counters integer[], p_stamp date
) returns text
language plpgsql immutable
as $$
declare
  seg   jsonb;
  out_s text := '';
  ci    int  := 1;
  v     int;
  w     int;
  piece text;
begin
  if p_pattern is null or jsonb_typeof(p_pattern) <> 'array' then
    return null;
  end if;
  for seg in select value from jsonb_array_elements(p_pattern) loop
    case seg->>'kind'
      when 'text' then
        out_s := out_s || coalesce(seg->>'value', '');
      when 'date' then
        out_s := out_s || to_char(coalesce(p_stamp, date '2000-01-01'),
                   case seg->>'format'
                     when 'YYYY' then 'YYYY' when 'YY' then 'YY'
                     when 'MM'   then 'MM'   when 'DD' then 'DD'
                     else 'YYYY' end);
      when 'number' then
        v := p_counters[ci]; ci := ci + 1;
        if v is null then return null; end if;
        w := coalesce((seg->>'width')::int, 0);
        -- lpad with a length of 0 returns the empty string, so the unpadded
        -- case has to be branched rather than folded into lpad.
        out_s := out_s || case when w > 0 then lpad(v::text, w, '0') else v::text end;
      when 'letter' then
        v := p_counters[ci]; ci := ci + 1;
        if v is null then return null; end if;
        piece := public.flipdesk_sku_base(
                   v,
                   coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
                   coalesce((seg->>'width')::int, 1));
        if piece is null then return null; end if;
        out_s := out_s || piece;
      else
        return null;
    end case;
  end loop;
  return out_s;
end;
$$;
```

```sql
-- The odometer. Increment the rightmost wheel; on overflow reset it to its min
-- and carry left. NULL means the leftmost wheel overflowed: the sequence is
-- exhausted. It NEVER wraps, because a wrap hands out a number the tenant has
-- already used, which is the one thing this feature exists to prevent.
create or replace function public.flipdesk_sku_advance(
  p_pattern jsonb, p_counters integer[]
) returns integer[]
language plpgsql immutable
as $$
declare
  bounds jsonb := public.flipdesk_sku_bounds(p_pattern);
  n      int   := jsonb_array_length(bounds);
  c      integer[] := p_counters;
  i      int;
  lo     int;
  hi     int;
begin
  if n = 0 or coalesce(array_length(c, 1), 0) <> n then
    return null;
  end if;
  i := n;
  loop
    lo := (bounds->(i - 1)->>'min')::int;
    hi := (bounds->(i - 1)->>'max')::int;
    if c[i] < hi then
      c[i] := c[i] + 1;
      return c;
    end if;
    c[i] := lo;
    i := i - 1;
    if i < 1 then
      return null;
    end if;
  end loop;
end;
$$;
```

```sql
-- The inverse of render, used only by the seed in Task 3. NULL means "this
-- string is not one of ours", which the seed treats as "ignore it".
create or replace function public.flipdesk_sku_parse(
  p_pattern jsonb, p_candidate text
) returns integer[]
language plpgsql immutable
as $$
declare
  seg    jsonb;
  rest   text := p_candidate;
  out_c  integer[] := '{}';
  lit    text;
  w      int;
  chunk  text;
  alpha  text;
  v      int;
  i      int;
  pos    int;
begin
  if p_candidate is null or p_pattern is null
     or jsonb_typeof(p_pattern) <> 'array' then
    return null;
  end if;
  for seg in select value from jsonb_array_elements(p_pattern) loop
    case seg->>'kind'
      when 'text' then
        lit := coalesce(seg->>'value', '');
        if left(rest, length(lit)) <> lit then return null; end if;
        rest := substr(rest, length(lit) + 1);
      when 'date' then
        -- A date does not participate in ordering, so it is consumed and
        -- discarded rather than checked.
        w := case seg->>'format' when 'YYYY' then 4 else 2 end;
        if length(rest) < w then return null; end if;
        rest := substr(rest, w + 1);
      when 'number' then
        w := coalesce((seg->>'width')::int, 0);
        if w > 0 then
          chunk := left(rest, w);
          if length(chunk) <> w or chunk !~ '^[0-9]+$' then return null; end if;
        else
          chunk := substring(rest from '^[0-9]+');
          if chunk is null then return null; end if;
        end if;
        rest  := substr(rest, length(chunk) + 1);
        out_c := out_c || chunk::int;
      when 'letter' then
        alpha := coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        w     := coalesce((seg->>'width')::int, 1);
        chunk := left(rest, w);
        if length(chunk) <> w then return null; end if;
        v := 0;
        for i in 1..w loop
          pos := position(substr(chunk, i, 1) in alpha);
          if pos = 0 then return null; end if;
          v := v * length(alpha) + (pos - 1);
        end loop;
        rest  := substr(rest, w + 1);
        out_c := out_c || v;
      else
        return null;
    end case;
  end loop;
  if rest <> '' then return null; end if;   -- trailing junk is not a match
  return out_c;
end;
$$;
```

Close the file with the footer:

```sql
-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00802') on conflict do nothing;
```

- [ ] **Step 5: Bump the schema version in the same commit**

In `services/edge-functions/src/lib/schema-version.ts`, change
`export const EXPECTED_SCHEMA_VERSION = "00801";` to `"00802"`.

- [ ] **Step 6: Run the check to verify it passes**

```bash
npx supabase db reset --no-seed
node scripts/check-sku-sequences.mjs
```

Expected: every assertion prints and the script exits 0. If
`j9999_next` comes back as `J0000` the carry is not reaching the letter wheel;
if it comes back `null` the letter wheel is reporting overflow when it should
carry.

- [ ] **Step 7: Write the single-home guard**

Create `src/test/sku-odometer-single-home.test.ts`. It reads the source tree and
fails if a second implementation of the carry rule appears outside Postgres.
This exists because the repo has already paid for a duplicated rounding rule in
three places.

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// .pathname is relative on Linux; fileURLToPath is the portable form.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROOTS = ["src", "services/edge-functions/src", "ios", "android"];
const EXTS = [".ts", ".tsx", ".swift", ".kt"];

/**
 * Names that only appear when somebody has written a second odometer. The
 * Postgres functions are the only home; a TypeScript, Swift or Kotlin copy
 * will drift from them and the drift will be invisible until two sellers get
 * the same SKU.
 */
const BANNED = [
  /function\s+advanceSku/,
  /function\s+renderSku/,
  /const\s+advanceSku\s*=/,
  /const\s+renderSku\s*=/,
  /func\s+advanceSku/,
  /fun\s+advanceSku/,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;                       // ios/ and android/ may be absent in CI
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "build" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

describe("the SKU odometer has exactly one home", () => {
  it("is not reimplemented outside Postgres", () => {
    const offenders: string[] = [];
    for (const r of ROOTS) {
      for (const file of walk(join(ROOT, r))) {
        if (file.endsWith("sku-odometer-single-home.test.ts")) continue;
        const text = readFileSync(file, "utf8");
        if (BANNED.some((re) => re.test(text))) {
          offenders.push(file.slice(ROOT.length + 1).replace(/\\/g, "/"));
        }
      }
    }
    expect(
      offenders,
      "The carry rule lives only in public.flipdesk_sku_advance. Call the " +
        "flipdesk_sku_preview RPC instead of porting it.",
    ).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the whole gate**

```bash
npx vitest run src/test/sku-odometer-single-home.test.ts
npx tsc -b
npm run lint
```

Expected: all pass.

- [ ] **Step 9: Record the held migration**

Add `00802` to `PENDING_MIGRATIONS.md` following the existing entries' shape,
with a line saying it is held for the owner.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/00802_flipdesk_sku_sequences.sql \
        scripts/fixtures/sku-odometer.sql scripts/check-sku-sequences.mjs \
        scripts/verify.mjs src/test/sku-odometer-single-home.test.ts \
        services/edge-functions/src/lib/schema-version.ts PENDING_MIGRATIONS.md
git commit -m "feat(US-3414): SKU odometer functions and the per-tenant sequence table"
```

---

### Task 2: The trigger that fills a blank SKU

**prd story:** US-3415

**Files:**
- Create: `supabase/migrations/00803_assign_sku_trigger.sql`
- Create: `scripts/fixtures/sku-assignment.sql`
- Modify: `scripts/check-sku-sequences.mjs` (a second fixture and its assertions)
- Modify: `services/edge-functions/src/lib/schema-version.ts` (`00802` -> `00803`)
- Modify: `PENDING_MIGRATIONS.md`

**Interfaces:**
- Consumes from Task 1: `flipdesk_sku_render`, `flipdesk_sku_render_date`,
  `flipdesk_sku_advance`, `flipdesk_sku_floor`, table `flipdesk_sku_sequences`.
  `counters` holds the NEXT value to issue.
- Produces: trigger `assign_sku_on_insert` on `public.inventory_items`, backed
  by `public.flipdesk_assign_sku()`.

- [ ] **Step 1: Write the failing fixture**

Create `scripts/fixtures/sku-assignment.sql`. One rolled-back transaction, one
JSON object on the last line. It needs two `auth.users` rows plus a
`workspace_members` row, exactly like `scripts/fixtures/created-by-tracking.sql`
does, because case 9 inserts as a MEMBER of somebody else's workspace.

Ten cases:

1. `[number w=0]` with `counters = {1032}` gives an item `sku = '1032'`, and the
   row's counters become `{1033}`.
2. `[letter, number w=4]` with `counters = {9,9999}` gives `J9999`, and the next
   insert gives `K0000`.
3. `counters = {25,9999}` (Z9999) issues `Z9999`, sets `exhausted = true`, and
   the NEXT insert saves with `sku IS NULL` rather than raising.
4. Twenty inserts in one transaction yield twenty distinct SKUs.
5. A hand-planted `J1235` is skipped: starting at `{9,1234}` the two inserts
   produce `J1234` then `J1236`.
6. An insert that supplies `sku = 'MINE-1'` keeps it, and the counter does not
   move.
7. `reset_on_date_change = true` with a `date_stamp` of `'25'` and a pattern
   carrying a `YY` segment resets the counters to the floor on the first insert
   of the new year.
8. `enabled = false` leaves `sku` NULL.
9. An insert by a workspace MEMBER against the OWNER's `user_id` draws from the
   OWNER's counter. Writing `auth.uid()` instead of `NEW.user_id` looks
   identical without this case.
10. A tenant with no `flipdesk_sku_sequences` row at all inserts normally with a
    NULL sku and raises nothing.

Emit them as one object, for example:

```sql
select jsonb_pretty(jsonb_build_object(
  'plain_sku',        (select sku from public.inventory_items where id = v_plain_id),
  'plain_counters',   (select counters from public.flipdesk_sku_sequences where user_id = v_owner),
  'j9999_sku',        ...,
  'k0000_sku',        ...,
  'exhausted_flag',   ...,
  'after_exhaust_sku',...,
  'distinct_count',   ...,
  'skip_first',       ...,
  'skip_second',      ...,
  'supplied_sku',     ...,
  'supplied_counters',...,
  'reset_sku',        ...,
  'disabled_sku',     ...,
  'member_sku',       ...,
  'member_counters',  ...,
  'no_row_sku',       ...
));
```

- [ ] **Step 2: Extend the runner**

In `scripts/check-sku-sequences.mjs`, run both fixtures and assert the second
set. Each failure message must say what the symptom means, not just the values:

```js
if (r2.k0000_sku !== "K0000") {
  fail(
    `the letter wheel did not carry through the trigger.\n` +
      `  expected K0000, got ${r2.k0000_sku ?? "NULL"}\n` +
      (r2.k0000_sku === "J0000"
        ? `  The number wheel rolled over but the carry never reached the letter.`
        : ""),
  );
}
if (r2.after_exhaust_sku !== null) {
  fail("an exhausted sequence still issued a SKU. The exhausted flag is not gating.");
}
if (r2.supplied_sku !== "MINE-1") {
  fail("the trigger overwrote a SKU the caller supplied. It must never do that.");
}
if (r2.member_sku !== r2.expected_member_sku) {
  fail(
    `an insert by a workspace member drew from the wrong counter.\n` +
      `  The trigger is keying on auth.uid() instead of NEW.user_id.`,
  );
}
if (r2.distinct_count !== 20) {
  fail(`20 inserts produced ${r2.distinct_count} distinct SKUs. The row lock is not held.`);
}
```

- [ ] **Step 3: Run it to verify it fails**

```bash
node scripts/check-sku-sequences.mjs
```

Expected: the Task 1 assertions pass, the new ones fail because every SKU comes
back NULL. No trigger exists yet.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/00803_assign_sku_trigger.sql`.

```sql
-- US-3415: fill a blank SKU from the tenant's counter, at the only place every
-- client already goes through.
--
-- Items are created from thirteen call sites across the web app, the edge
-- service, iOS and Android. A TypeScript helper would need thirteen edits, a
-- Swift port and a Kotlin port, and the one call site somebody forgets fails
-- silently. A BEFORE INSERT trigger covers all of them and every one added
-- later, and it is the only option that is atomic without a second round trip.

create or replace function public.flipdesk_assign_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  seqrow public.flipdesk_sku_sequences%rowtype;
  stamp  text;
  c      integer[];
  nxt    integer[];
  cand   text;
  tries  int  := 0;
  today  date := (now() at time zone 'UTC')::date;
begin
  -- A SKU the caller supplied is never overwritten, under any setting.
  if new.sku is not null and btrim(new.sku) <> '' then
    return new;
  end if;

  -- FOR UPDATE and not a single UPDATE ... RETURNING: the collision skip below
  -- may advance more than once, so the final counters are only known after the
  -- loop. Both take the same row lock; this one holds it across the loop.
  select * into seqrow
    from public.flipdesk_sku_sequences
   where user_id = new.user_id
     for update;

  if not found or not seqrow.enabled or seqrow.exhausted then
    return new;
  end if;

  stamp := public.flipdesk_sku_render_date(seqrow.pattern, today);
  c     := seqrow.counters;

  -- The period rolled over (a new year, a new month). Start again at the floor.
  if seqrow.reset_on_date_change
     and seqrow.date_stamp is not null
     and seqrow.date_stamp <> stamp then
    c := public.flipdesk_sku_floor(seqrow.pattern);
  end if;

  loop
    tries := tries + 1;
    cand  := public.flipdesk_sku_render(seqrow.pattern, c, today);
    exit when cand is not null
          and not exists (select 1 from public.inventory_items
                           where user_id = new.user_id and sku = cand);
    -- Taken, usually by a SKU the seller typed by hand. Walk past it rather
    -- than raising 23505 at somebody in the middle of a photo session.
    c := public.flipdesk_sku_advance(seqrow.pattern, c);
    if c is null or tries > 1000 then
      update public.flipdesk_sku_sequences
         set exhausted = true, updated_at = now()
       where user_id = new.user_id;
      -- The item still saves, with a NULL sku. The settings screen and the
      -- inventory page both surface the flag. Raising here would stop a seller
      -- dead with an error they cannot diagnose.
      return new;
    end if;
  end loop;

  new.sku := cand;
  nxt     := public.flipdesk_sku_advance(seqrow.pattern, c);

  update public.flipdesk_sku_sequences
     set counters   = coalesce(nxt, c),
         exhausted  = (nxt is null),
         date_stamp = stamp,
         updated_at = now()
   where user_id = new.user_id;

  return new;
end;
$$;

comment on function public.flipdesk_assign_sku() is
  'US-3415: BEFORE INSERT on inventory_items. Fills a blank sku from flipdesk_sku_sequences, skipping values already taken inside the tenant. Never overwrites a supplied sku. On exhaustion it flags the row and leaves sku NULL rather than failing the insert.';

-- Name matters: BEFORE triggers fire in alphabetical order, and this sorts
-- before set_created_by (US-3023), which is already on this table. The two
-- touch different columns, so the order is not load-bearing -- but a third
-- trigger landing between them would be, so the ordering is written down here.
drop trigger if exists assign_sku_on_insert on public.inventory_items;
create trigger assign_sku_on_insert
  before insert on public.inventory_items
  for each row execute function public.flipdesk_assign_sku();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00803') on conflict do nothing;
```

- [ ] **Step 5: Bump the schema version in the same commit**

`EXPECTED_SCHEMA_VERSION` `"00802"` -> `"00803"`.

- [ ] **Step 6: Run the check to verify it passes**

```bash
npx supabase db reset --no-seed
node scripts/check-sku-sequences.mjs
```

Expected: all assertions from both fixtures pass.

- [ ] **Step 7: Record the held migration and commit**

```bash
git add supabase/migrations/00803_assign_sku_trigger.sql \
        scripts/fixtures/sku-assignment.sql scripts/check-sku-sequences.mjs \
        services/edge-functions/src/lib/schema-version.ts PENDING_MIGRATIONS.md
git commit -m "feat(US-3415): BEFORE INSERT trigger assigns the next SKU"
```

---

### Task 3: Preview, seed and save

**prd story:** US-3416

**Files:**
- Create: `supabase/migrations/00804_sku_sequence_rpcs.sql`
- Create: `scripts/fixtures/sku-rpcs.sql`
- Modify: `scripts/check-sku-sequences.mjs` (a third fixture and its assertions)
- Modify: `services/edge-functions/src/lib/schema-version.ts` (`00803` -> `00804`)
- Modify: `PENDING_MIGRATIONS.md`

**Interfaces:**
- Consumes from Tasks 1 and 2: all the odometer functions, the table.
- Produces, called from the browser in Task 4 via `supabase.rpc(...)`:
  - `public.flipdesk_sku_preview(p_owner uuid, p_pattern jsonb, p_counters integer[], p_count int) -> text[]`
  - `public.flipdesk_sku_seed(p_owner uuid, p_pattern jsonb) -> jsonb`
    returning `{"counters": int[], "matched": text|null, "match_count": int}`
  - `public.flipdesk_sku_save(p_owner uuid, p_pattern jsonb, p_counters integer[], p_enabled boolean, p_reset boolean) -> jsonb`
    returning `{"ok": true}` or raising with a message the UI shows verbatim

- [ ] **Step 1: Write the failing fixture**

Create `scripts/fixtures/sku-rpcs.sql`. Cases:

1. `flipdesk_sku_seed` against a tenant holding `1`..`1031` with pattern
   `[number w=0 min=1 max=99999999]` returns `counters = {1032}`,
   `matched = '1031'`, `match_count = 1031`.
2. The same seed ignores SKUs that do not parse: plant `hoodie-blue` and
   `J1234`, and `match_count` does not change.
3. `flipdesk_sku_seed` against a tenant with no matching SKUs returns the
   pattern's floor.
4. `flipdesk_sku_preview` returns five strings, and the first equals
   `render(pattern, counters)` with no advance, because `counters` is the next
   value to issue.
5. `flipdesk_sku_preview` skips a value already taken by a hand-typed SKU.
6. `flipdesk_sku_save` rejects a pattern with no counting segment, message
   contains `needs at least one number or letter`.
7. `flipdesk_sku_save` rejects an alphabet with a duplicate character.
8. `flipdesk_sku_save` rejects an unpadded number followed by a segment that can
   start with a digit, message contains `must be last`.
9. `flipdesk_sku_save` rejects a pattern whose longest rendering exceeds 50
   characters.
10. `flipdesk_sku_save` rejects `counters` whose length does not match the
    counting-segment count.
11. A successful `flipdesk_sku_save` clears a previously set `exhausted`.
12. A workspace VIEWER calling `flipdesk_sku_save` is refused; a viewer calling
    `flipdesk_sku_preview` is allowed.

- [ ] **Step 2: Extend the runner, run it, watch it fail**

Same shape as Task 2. Expected failure: `function public.flipdesk_sku_seed(...)
does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00804_sku_sequence_rpcs.sql`. All three are
`security definer` with `set search_path = public, pg_temp`, and all three
resolve the caller's right to act on `p_owner` before touching anything.

```sql
-- Who may act on p_owner. Read access is viewer and up; writing settings is
-- owner or admin. This mirrors what workspaceMiddleware enforces on the edge
-- (services/edge-functions/src/middleware/workspace.ts), so the two paths
-- cannot disagree about who is allowed to do what.
create or replace function public.flipdesk_sku_may_read(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select (select auth.uid()) = p_owner
      or public.is_workspace_member_with_role(p_owner, 'viewer');
$$;

create or replace function public.flipdesk_sku_may_write(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select (select auth.uid()) = p_owner
      or public.is_workspace_member_with_role(p_owner, 'admin');
$$;
```

Check `public.workspace_role` actually has an `admin` value before using it:

```bash
docker exec -i supabase_db_gradethread psql -U postgres -d postgres -c \
  "select unnest(enum_range(null::public.workspace_role));"
```

If it does not, use the highest role below owner that it does have and say so in
a comment.

```sql
create or replace function public.flipdesk_sku_preview(
  p_owner uuid, p_pattern jsonb, p_counters integer[], p_count int
) returns text[]
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  out_a text[] := '{}';
  c     integer[] := p_counters;
  cand  text;
  today date := (now() at time zone 'UTC')::date;
  n     int  := least(greatest(coalesce(p_count, 5), 1), 25);
  tries int  := 0;
begin
  if not public.flipdesk_sku_may_read(p_owner) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  while array_length(out_a, 1) is distinct from n loop
    tries := tries + 1;
    if c is null or tries > 1000 then
      exit;                       -- a short preview is the honest answer here
    end if;
    cand := public.flipdesk_sku_render(p_pattern, c, today);
    if cand is null then exit; end if;
    -- The preview skips taken values for the same reason the trigger does, so
    -- what the seller sees is what they will actually get.
    if not exists (select 1 from public.inventory_items
                    where user_id = p_owner and sku = cand) then
      out_a := out_a || cand;
    end if;
    c := public.flipdesk_sku_advance(p_pattern, c);
  end loop;
  return out_a;
end;
$$;
```

```sql
create or replace function public.flipdesk_sku_seed(
  p_owner uuid, p_pattern jsonb
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  best_sku text;
  best_c   integer[];
  hits     int;
  nxt      integer[];
begin
  if not public.flipdesk_sku_may_read(p_owner) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- int[] compares element-wise, left to right, which IS the odometer order.
  -- There is no max() over arrays, so this is an ORDER BY rather than an
  -- aggregate.
  select sku, c, cnt into best_sku, best_c, hits
  from (
    select sku,
           public.flipdesk_sku_parse(p_pattern, sku) as c,
           count(*) over () as cnt
      from public.inventory_items
     where user_id = p_owner
       and sku is not null
       and public.flipdesk_sku_parse(p_pattern, sku) is not null
  ) m
  order by c desc
  limit 1;

  if best_c is null then
    return jsonb_build_object(
      'counters',    public.flipdesk_sku_floor(p_pattern),
      'matched',     null,
      'match_count', 0);
  end if;

  nxt := public.flipdesk_sku_advance(p_pattern, best_c);
  return jsonb_build_object(
    'counters',    coalesce(nxt, best_c),
    'matched',     best_sku,
    'match_count', coalesce(hits, 0));
end;
$$;
```

```sql
create or replace function public.flipdesk_sku_save(
  p_owner    uuid,
  p_pattern  jsonb,
  p_counters integer[],
  p_enabled  boolean,
  p_reset    boolean
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  bounds  jsonb;
  n       int;
  seg     jsonb;
  ord     int := 0;
  total   int;
  nxt_seg jsonb;
  top_c   integer[];
  longest text;
  i       int;
begin
  if not public.flipdesk_sku_may_write(p_owner) then
    raise exception 'Only the workspace owner or an admin can change SKU numbering'
      using errcode = '42501';
  end if;
  if p_pattern is null or jsonb_typeof(p_pattern) <> 'array' then
    raise exception 'The pattern must be a list of segments';
  end if;

  bounds := public.flipdesk_sku_bounds(p_pattern);
  n      := jsonb_array_length(bounds);
  if n = 0 then
    raise exception 'A SKU pattern needs at least one number or letter to count';
  end if;

  total := jsonb_array_length(p_pattern);
  for seg in select value from jsonb_array_elements(p_pattern) loop
    ord := ord + 1;
    if seg->>'kind' = 'letter' then
      declare a text := coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      begin
        if length(a) < 1 then
          raise exception 'A letter segment needs at least one character to cycle through';
        end if;
        if length(a) <> (select count(distinct ch) from unnest(string_to_array(a, null)) ch) then
          raise exception 'A letter segment cannot repeat a character: %', a;
        end if;
      end;
    end if;
    -- An unpadded number reads back greedily, so anything after it that can
    -- start with a digit makes the SKU ambiguous to parse.
    if seg->>'kind' = 'number' and coalesce((seg->>'width')::int, 0) = 0
       and ord < total then
      nxt_seg := p_pattern->ord;      -- 0-based: this is the NEXT segment
      if nxt_seg->>'kind' <> 'text'
         or coalesce(nxt_seg->>'value', '') ~ '^[0-9]' then
        raise exception
          'A number with no leading zeros must be last, or be followed by text that does not start with a digit';
      end if;
    end if;
    if seg->>'kind' = 'number'
       and coalesce((seg->>'min')::int, 0) > coalesce((seg->>'max')::int, 0) then
      raise exception 'A number segment cannot have a minimum above its maximum';
    end if;
  end loop;

  if coalesce(array_length(p_counters, 1), 0) <> n then
    raise exception 'The starting value has % parts but the pattern counts % of them',
      coalesce(array_length(p_counters, 1), 0), n;
  end if;
  for i in 1..n loop
    if p_counters[i] < (bounds->(i - 1)->>'min')::int
       or p_counters[i] > (bounds->(i - 1)->>'max')::int then
      raise exception 'Part % of the starting value is outside what the pattern allows', i;
    end if;
  end loop;

  -- The longest this pattern can ever render. eBay caps its own SKU at 50 and
  -- this string is what a seller reaches for when they fill it.
  select array_agg((b->>'max')::int order by o) into top_c
    from jsonb_array_elements(bounds) with ordinality t(b, o);
  longest := public.flipdesk_sku_render(p_pattern, top_c, date '2026-12-31');
  if longest is null then
    raise exception 'That pattern cannot be rendered. Check the segment widths';
  end if;
  if length(longest) > 50 then
    raise exception 'This pattern can reach % characters. SKUs are capped at 50', length(longest);
  end if;

  insert into public.flipdesk_sku_sequences
    (user_id, enabled, pattern, counters, reset_on_date_change, exhausted, date_stamp)
  values
    (p_owner, coalesce(p_enabled, false), p_pattern, p_counters,
     coalesce(p_reset, false), false,
     public.flipdesk_sku_render_date(p_pattern, (now() at time zone 'UTC')::date))
  on conflict (user_id) do update
    set enabled              = excluded.enabled,
        pattern              = excluded.pattern,
        counters             = excluded.counters,
        reset_on_date_change = excluded.reset_on_date_change,
        date_stamp           = excluded.date_stamp,
        -- A widened pattern un-exhausts the sequence.
        exhausted            = false,
        updated_at           = now();

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.flipdesk_sku_preview(uuid, jsonb, integer[], int) to authenticated;
grant execute on function public.flipdesk_sku_seed(uuid, jsonb)                    to authenticated;
grant execute on function public.flipdesk_sku_save(uuid, jsonb, integer[], boolean, boolean) to authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00804') on conflict do nothing;
```

- [ ] **Step 4: Bump the schema version, run the check, commit**

`EXPECTED_SCHEMA_VERSION` `"00803"` -> `"00804"`.

```bash
npx supabase db reset --no-seed
node scripts/check-sku-sequences.mjs
node scripts/check-rpc-column-refs.mjs
```

The second one matters: it executes every RPC inside a rolled-back transaction,
which is what catches a function that installs cleanly and raises on call.

```bash
git commit -m "feat(US-3416): preview, seed and save RPCs for SKU numbering"
```

---

### Task 4: The settings screen

**prd story:** US-3417

**Files:**
- Create: `src/pages/flipdesk/sku-numbering.tsx`
- Create: `src/lib/sku-presets.ts`
- Create: `src/hooks/use-sku-sequence.ts`
- Create: `src/pages/flipdesk/__tests__/sku-numbering.test.tsx`
- Modify: `src/routes/index.tsx` (lazy import + route)
- Modify: `src/lib/surfaces.ts` (`CONTEXTUAL_ROUTES` entry)
- Modify: `src/types/database.ts` (the `flipdesk_sku_sequences` row type)

**Interfaces:**
- Consumes from Task 3: the three RPCs, called as
  `supabase.rpc("flipdesk_sku_preview", { p_owner, p_pattern, p_counters, p_count })`.
- Produces, consumed by Task 5:
  - `useSkuSequence()` from `@/hooks/use-sku-sequence`, returning
    `{ sequence, nextSku, isEnabled, isExhausted, isLoading }`
  - `SKU_NUMBERING_HREF = "/dashboard/flipdesk/settings/sku"` exported from
    `@/lib/sku-presets`

- [ ] **Step 1: Write the preset table**

Create `src/lib/sku-presets.ts`. It holds the segment types and the five
presets, and nothing else. It must contain no carry logic; the guard test from
Task 1 fails the build if it does.

```ts
export const SKU_NUMBERING_HREF = "/dashboard/flipdesk/settings/sku";

export const DEFAULT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type SkuSegment =
  | { kind: "text"; value: string }
  | { kind: "date"; format: "YYYY" | "YY" | "MM" | "DD" }
  | { kind: "number"; width: number; min: number; max: number }
  | { kind: "letter"; alphabet: string; width: number };

export type SkuPreset = {
  id: string;
  label: string;
  example: string;
  /** Plain-English line under the label. No jargon. */
  blurb: string;
  pattern: SkuSegment[];
  counters: number[];
  resetOnDateChange: boolean;
};

export const SKU_PRESETS: readonly SkuPreset[] = [
  {
    id: "plain",
    label: "Plain number",
    example: "1, 2, 3",
    blurb: "Counts up with no padding.",
    pattern: [{ kind: "number", width: 0, min: 1, max: 99999999 }],
    counters: [1],
    resetOnDateChange: false,
  },
  {
    id: "padded",
    label: "Padded number",
    example: "0001",
    blurb: "Always four digits, so they line up when sorted.",
    pattern: [{ kind: "number", width: 4, min: 0, max: 9999 }],
    counters: [1],
    resetOnDateChange: false,
  },
  {
    id: "prefix",
    label: "Prefix plus number",
    example: "GT-1001",
    blurb: "Your own letters in front, then a running number.",
    pattern: [
      { kind: "text", value: "GT-" },
      { kind: "number", width: 0, min: 1, max: 99999999 },
    ],
    counters: [1001],
    resetOnDateChange: false,
  },
  {
    id: "letter-four",
    label: "Letter plus four digits",
    example: "J0000",
    blurb: "When the digits run out the letter moves up: J9999 becomes K0000.",
    pattern: [
      { kind: "letter", alphabet: DEFAULT_ALPHABET, width: 1 },
      { kind: "number", width: 4, min: 0, max: 9999 },
    ],
    counters: [0, 0],
    resetOnDateChange: false,
  },
  {
    id: "year",
    label: "Year plus number",
    example: "26-00001",
    blurb: "Starts over at 1 each January.",
    pattern: [
      { kind: "date", format: "YY" },
      { kind: "text", value: "-" },
      { kind: "number", width: 5, min: 1, max: 99999 },
    ],
    counters: [1],
    resetOnDateChange: true,
  },
];

/** How many counter slots a pattern needs. Segment shape only, no carry rule. */
export function countingSlots(pattern: readonly SkuSegment[]): number {
  return pattern.filter((s) => s.kind === "number" || s.kind === "letter").length;
}
```

- [ ] **Step 2: Write the hook**

Create `src/hooks/use-sku-sequence.ts`. A TanStack Query read of the row plus a
preview call. It never computes a SKU itself.

```ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { SkuSegment } from "@/lib/sku-presets";

export type SkuSequenceRow = {
  user_id: string;
  enabled: boolean;
  pattern: SkuSegment[];
  counters: number[];
  reset_on_date_change: boolean;
  exhausted: boolean;
};

export function useSkuSequence(ownerId: string | undefined) {
  const row = useQuery({
    queryKey: ["sku-sequence", ownerId],
    enabled: Boolean(ownerId),
    queryFn: async (): Promise<SkuSequenceRow | null> => {
      // Keep the builder bound; a destructured `from` loses its `this`.
      const { data, error } = await supabase
        .from("flipdesk_sku_sequences")
        .select("*")
        .eq("user_id", ownerId as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as SkuSequenceRow | null;
    },
  });

  const enabled = Boolean(row.data?.enabled) && !row.data?.exhausted;

  const preview = useQuery({
    queryKey: ["sku-preview", ownerId, row.data?.counters, row.data?.pattern],
    enabled: Boolean(ownerId) && enabled,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.rpc("flipdesk_sku_preview", {
        p_owner: ownerId as string,
        p_pattern: row.data?.pattern ?? [],
        p_counters: row.data?.counters ?? [],
        p_count: 1,
      });
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });

  return {
    sequence: row.data ?? null,
    // noUncheckedIndexedAccess is on, so index access yields string | undefined.
    nextSku: preview.data?.[0] ?? null,
    isEnabled: enabled,
    isExhausted: Boolean(row.data?.exhausted),
    isLoading: row.isLoading,
  };
}
```

- [ ] **Step 3: Write the page**

Create `src/pages/flipdesk/sku-numbering.tsx`, exported as
`export function FlipdeskSkuNumberingPage()`. Sections, top to bottom:

1. A `Switch` for on and off.
2. The five presets as selectable rows. Each shows `label`, `example` and
   `blurb`. Clicking one replaces the working pattern and counters. Do NOT
   render them as a grid of same-size icon tiles, and do not nest a card inside
   a card.
3. A segment editor: one row per segment with its kind-specific fields, plus
   add, remove and reorder. Reorder with up and down buttons, not drag, because
   drag needs a library and keyboard support this does not have.
4. A live preview of the next five SKUs from `flipdesk_sku_preview`, debounced
   300ms on any pattern or counter edit. While a call is in flight, keep the
   previous list visible rather than flashing a spinner.
5. A "Next SKU" field. On any pattern change, call `flipdesk_sku_seed` and
   pre-fill it, with a line under it reading, for a tenant whose highest is
   1031: `Your highest matching SKU is 1031, so the next one is 1032.` When the
   seed returns `matched: null`, read: `No existing SKUs match this pattern, so
   numbering starts at the beginning.`
6. A destructive-toned banner when `exhausted` is true: `Every number in this
   pattern has been used. New items are saving without a SKU. Add a digit or a
   letter, then save.`
7. Save calls `flipdesk_sku_save`. On an error, show `error.message` verbatim in
   a `sonner` toast, because Task 3 wrote those messages for a human to read.

Do not add a colored `border-left` to any card, callout or preset row. Do not
put a tracked uppercase eyebrow above each section. Elevation is border OR
shadow, never both.

- [ ] **Step 4: Register the route and the surface**

In `src/routes/index.tsx`, beside the existing
`/dashboard/flipdesk/settings/blocks` entry:

```tsx
const FlipdeskSkuNumberingPage = lazy(() =>
  import("@/pages/flipdesk/sku-numbering").then(m => ({ default: m.FlipdeskSkuNumberingPage })));
```

```tsx
{ path: "/dashboard/flipdesk/settings/sku", element: <SuspenseWrapper><FlipdeskSkuNumberingPage /></SuspenseWrapper> },
```

In `src/lib/surfaces.ts`, add to `CONTEXTUAL_ROUTES`:

```ts
{
  path: "/dashboard/flipdesk/settings/sku",
  why:
    "US-3417 SKU numbering, reached from the SKU field in the item editor and " +
    "from the inventory header, which is where a seller is standing when they " +
    "want their items numbered for them.",
},
```

- [ ] **Step 5: Add the row type**

In `src/types/database.ts`, add `flipdesk_sku_sequences` following the shape of
the neighboring table types.

- [ ] **Step 6: Write the component test**

Create `src/pages/flipdesk/__tests__/sku-numbering.test.tsx` with the Supabase
client mocked. Four cases:

1. Clicking the "Letter plus four digits" preset puts two segments in the editor
   and a counter array of length 2.
2. A save that the RPC rejects shows the RPC's own message, not a generic one.
3. The exhaustion banner renders when the row has `exhausted: true`, and the
   preview section does not.
4. Editing a segment issues exactly one preview call after the debounce, not one
   per keystroke.

- [ ] **Step 7: Run the gate and commit**

```bash
npx vitest run src/pages/flipdesk/__tests__/sku-numbering.test.tsx src/test/surface-registry.test.ts src/test/sku-odometer-single-home.test.ts
npx tsc -b
npm run lint
npm run ui:check
git commit -m "feat(US-3417): SKU numbering settings screen"
```

`npm run ui:check` has a baseline of zero in `src/`. Any finding it reports is
this page's.

---

### Task 5: Getting there, and seeing what you will get

**prd story:** US-3418

**Files:**
- Modify: `src/pages/flipdesk/intake.tsx` (around the SKU input at line 702)
- Modify: `src/components/flipdesk/bulk-intake.tsx` (around line 424)
- Modify: `src/pages/flipdesk/inventory.tsx` (header link and the banner)
- Create: `src/components/flipdesk/sku-auto-hint.tsx`
- Create: `src/components/flipdesk/__tests__/sku-auto-hint.test.tsx`

**Interfaces:**
- Consumes from Task 4: `useSkuSequence` from `@/hooks/use-sku-sequence`, and
  `SKU_NUMBERING_HREF` from `@/lib/sku-presets`.

- [ ] **Step 1: Write the failing test**

Create `src/components/flipdesk/__tests__/sku-auto-hint.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SkuAutoHint } from "@/components/flipdesk/sku-auto-hint";

vi.mock("@/hooks/use-sku-sequence", () => ({
  useSkuSequence: vi.fn(),
}));
import { useSkuSequence } from "@/hooks/use-sku-sequence";

const mocked = vi.mocked(useSkuSequence);

describe("SkuAutoHint", () => {
  it("names the next SKU when numbering is on", () => {
    mocked.mockReturnValue({
      sequence: null, nextSku: "J1035", isEnabled: true,
      isExhausted: false, isLoading: false,
    } as never);
    render(<MemoryRouter><SkuAutoHint ownerId="o1" /></MemoryRouter>);
    expect(screen.getByText(/J1035/)).toBeInTheDocument();
  });

  it("offers to turn numbering on when it is off", () => {
    mocked.mockReturnValue({
      sequence: null, nextSku: null, isEnabled: false,
      isExhausted: false, isLoading: false,
    } as never);
    render(<MemoryRouter><SkuAutoHint ownerId="o1" /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /number these automatically/i }))
      .toHaveAttribute("href", "/dashboard/flipdesk/settings/sku");
  });

  it("says nothing at all while the row is still loading", () => {
    mocked.mockReturnValue({
      sequence: null, nextSku: null, isEnabled: false,
      isExhausted: false, isLoading: true,
    } as never);
    const { container } = render(
      <MemoryRouter><SkuAutoHint ownerId="o1" /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run src/components/flipdesk/__tests__/sku-auto-hint.test.tsx
```

Expected: FAIL, cannot resolve `@/components/flipdesk/sku-auto-hint`.

- [ ] **Step 3: Write the component**

Create `src/components/flipdesk/sku-auto-hint.tsx`. One small line that sits
under a SKU input. When numbering is on it reads
`Leave blank and we will use J1035.` When it is off it is a link reading
`Number these automatically`. While loading it renders nothing, so the layout
does not jump.

- [ ] **Step 4: Place it**

Under the SKU input in `src/pages/flipdesk/intake.tsx` (the `sku-input` Label at
line 702) and in `src/components/flipdesk/bulk-intake.tsx` (the `bi-sku-item`
Label at line 424). Also set the input's `placeholder` to the next SKU when
numbering is on.

- [ ] **Step 5: Add the inventory banner**

In `src/pages/flipdesk/inventory.tsx`, render a dismissible warning when
`isExhausted` is true, linking to `SKU_NUMBERING_HREF`. Same copy as the
settings banner so a seller who sees both does not have to reconcile two
wordings.

- [ ] **Step 6: Run the gate and commit**

```bash
npx vitest run src/components/flipdesk/__tests__/sku-auto-hint.test.tsx
npx tsc -b && npm run lint && npm run ui:check
git commit -m "feat(US-3418): surface auto-numbering at the SKU field and on inventory"
```

---

### Task 6: Write it down where the next person looks

**prd story:** US-3419

**Files:**
- Create: `vault/20-domain/sku-numbering.md`
- Modify: `vault/00-index/INDEX.md` and the domain MOC
- Modify: `PENDING_MIGRATIONS.md` (final state of all three migrations)

- [ ] **Step 1: Load the vault skill**

`Skill(vault)` first. It owns the note schema, the retrieval protocol and the
same-commit update rule. Do not write a note without it.

- [ ] **Step 2: Write the contract note**

`vault/20-domain/sku-numbering.md`, `type: contract`. It records the facts a
reader needs before changing anything here:

- `counters` is the NEXT value to issue, not the last one issued.
- The carry rule lives only in `public.flipdesk_sku_advance`, and
  `src/test/sku-odometer-single-home.test.ts` is what keeps it that way.
- The trigger never overwrites a supplied SKU, and skips values already taken.
- Exhaustion leaves the SKU NULL rather than failing the insert, and why.
- The tenant is `inventory_items.user_id`, which is the workspace OWNER.
- Uniqueness is `idx_inventory_items_user_sku`, which predates this feature.
- Link to the spec and to `vault/20-domain/sync-source-of-truth.md`, since
  `listings.inventory_sku` is a snapshot of this column and is governed there.

- [ ] **Step 3: Index and lint**

```bash
npm run vault:index
npm run vault:lint
```

`vault:lint` runs `--strict`, so drift on a `type: contract` note is an error.

- [ ] **Step 4: Full verify and commit**

```bash
npm run verify
git commit -m "docs(US-3419): SKU numbering contract note"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: trigger contract and
claiming to Task 2; pattern model, advance, parse and the single-home rule to
Task 1; data model and RLS to Task 1; RPCs and validation to Task 3; exhaustion
to Tasks 2, 4 and 5; changing the pattern later to Tasks 3 and 4; UI to Tasks 4
and 5; testing spread across 1, 2, 3, 4, 5; migration and rollout to all of
them plus Task 6.

**Type consistency.** `counters` means the next value to issue in the table
comment, the trigger, all three RPCs, the hook and the UI copy. `SkuSegment` in
`src/lib/sku-presets.ts` matches the JSON the SQL reads. `flipdesk_sku_render`
takes its date as an argument in every call site, which is what keeps it
`IMMUTABLE`.

**Known sharp edges, called out where they bite.** `lpad` with a length of 0
returns the empty string, so the unpadded number case is branched in `render`.
`position()` picks the first match, so a duplicate character in an alphabet is
rejected at save rather than being silently ambiguous at parse. An unpadded
number reads back greedily, so save rejects one that is not effectively last.
BEFORE triggers fire alphabetically, so `assign_sku_on_insert` and the existing
`set_created_by` are named in the migration.
