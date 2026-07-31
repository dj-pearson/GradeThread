# Local edge type-check (fallback when Deno can't reach its registries)

`deno check` is the real gate and runs in CI (`security.yml` → deno-check). Use
this only when Deno cannot resolve its remote imports — for example in a
sandboxed session whose egress policy blocks `deno.land`, `esm.sh` and `jsr.io`,
where `deno check` fails at import resolution and every edge change would
otherwise ship unverified.

## Run it

```bash
npx tsc -p services/edge-functions/tools/local-typecheck/tsconfig.json
```

## How to read the output

**The absolute error count is meaningless — only your own files matter.** Filter
to what you changed:

```bash
npx tsc -p services/edge-functions/tools/local-typecheck/tsconfig.json 2>&1 \
  | grep -E 'cross-push|flipdesk-automations'   # your changed files
```

Zero hits on your files is the pass condition.

## Why there is a baseline of errors

`stubs/loose.d.ts` types every third-party module as `any` (`declare module "*"`)
because the real `.d.ts` files live behind the blocked registries. Two
consequences:

- Files that use a third-party class in TYPE position (`Stripe.Transfer`,
  `Anthropic.MessageParam`, `Deno.DirEntry`, `Environment` from the App Store
  library) report `TS2709` / `TS2694`. These are stub artifacts, not defects.
- `noImplicitAny` is off, or every supabase row callback would be a false
  `TS7006`.

`stubs/std-assert.d.ts` gives `@std/assert` its real `asserts` signatures, so
assertion narrowing works and test files don't report false "possibly null".

## What it does and does not catch

**Catches** errors in our own code: wrong argument counts to our functions,
missing union arms, bad property access on our own interfaces, unassignable
literals, widened `type: string` in a discriminated-union literal. That last one
is a real CI failure this harness caught before it reached a PR.

**Does not catch** misuse of the hono / supabase / Stripe / Anthropic APIs
themselves. Those are `any` here. Only `deno check` sees them.
