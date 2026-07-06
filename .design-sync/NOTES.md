# design-sync NOTES — GradeThread

## What this sync is
GradeThread is a full **application** repo, not a DS package. We sync the **UI kit only**:
`src/components/ui/` (shadcn/ui primitives), scoped via `cfg.srcDir`. 107 exports (each
shadcn file is a compound family — Card→CardHeader/…, Dialog→8 parts, etc.).
Project: `GradeThread Design System` (`ecc963ed-7984-44b3-a304-25a07bf346a1`).

## FlipDesk/dashboard are EXCLUDED — do not try to add them to the bundle
`src/components/flipdesk/**` and `src/components/dashboard/**` import `@/lib/supabase`,
which **throws at module load** if `VITE_SUPABASE_URL`/`_ANON_KEY` are unset. The bundle is
one IIFE that `export *`s and executes at load, so a single throwing module kills the whole
`window.GradeThread` global (every preview blanks). The converter's env stub
(`IIFE_IMPORT_META_DEFINE` in `lib/common.mjs`) does NOT define those vars, and the skill
forbids forking `bundle.mjs`. So they can only be added by env-stubbing via a lib fork —
deliberately deferred. The UI kit itself has NO load-time supabase reach (verified).

## Build gotchas (re-sync will hit these)
- **Junction required.** npm won't self-install `node_modules/gradethread`, but the converter
  resolves the package there. Recreate on any fresh clone (PowerShell):
  `New-Item -ItemType Junction -Path node_modules\gradethread -Target C:\Users\dpearson\Documents\GradeThread`
  Without it: `ENOENT node_modules/gradethread/package.json`. (Git Bash `ls` can't traverse
  the junction, but Node can — ignore the ls miss.)
- **Synth-entry.** No component-library build exists (`npm run build` = the app/site build →
  `dist/` is static HTML). Converter synthesizes the entry from `src/components/ui`. Run
  `package-build.mjs` with NO `--entry`.
- **`cssEntry` is a HASHED dist file** → `dist/assets/index-<hash>.css` (currently
  `index-BmBJitGf.css`). The hash CHANGES every `npm run build`. **On re-sync, update
  `cfg.cssEntry` to the current `dist/assets/index-*.css`** or the CSS step ships stale/missing
  styles. This is the #1 re-sync risk.
- **Fonts** (Inter + Outfit) live in `public/fonts/*.woff2`; the compiled CSS references
  `/fonts/*.woff2` which don't resolve from `dist/assets`, so they're wired via `cfg.extraFonts`.
- **Playwright**: repo pins `playwright@1.60.0` → chromium build **1223**, already in the
  ms-playwright cache. Validator resolves `playwright` from repo `node_modules` (not `.ds-sync`).

## API fidelity
- shadcn `VariantProps` intersections resolve to `[key:string]:unknown` in synth-entry — the
  emitted `.d.ts` is loose. Variant/size vocabularies are documented in `conventions.md`
  instead. To harden specific components later, add `cfg.dtsPropsFor.<Name>`.

## Authored previews (15, all graded good — carried forward on re-sync)
Button, Badge, Card, Input, Textarea, Checkbox, Switch, Select, Tabs, Table, Dialog, Avatar,
Progress, Separator, StatusBadge. Everything else ships the floor card (authorable incrementally).

## Known render warns (triaged legitimate — NOT new issues)
Thin/blank standalone renders for layout sub-parts that only have meaning inside a parent
(they render fully inside their parent's authored preview): CardHeader, SheetHeader,
SheetFooter, TableCell, TableHead, TableCaption, AlertDialogHeader, AlertDialogMedia,
DropdownMenuLabel, EmptyState (EmptyState also needs a Router at render). A re-sync warn on
any of these is expected, not new.

## Overrides in play
- `cfg.overrides.Dialog = {cardMode:"single", viewport:"440x300"}` — renders the open modal
  inside its card.

## Re-sync risks (watch-list)
1. `cssEntry` hash drift (above) — update it before trusting the build.
2. Junction must be recreated per clone.
3. New `src/components/ui/*` files auto-appear via synth-entry (good) — but if any new ui file
   imports supabase/stores at module top-level it will poison the bundle; check before shipping.
4. FlipDesk/dashboard remain excluded by design.
