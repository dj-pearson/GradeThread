# Accessibility — Color Contrast (US-439)

GradeThread targets **WCAG 2.1 AA**: ≥ 4.5:1 for normal text, ≥ 3:1 for large
text (≥ 18.66px bold / 24px regular) and UI affordances. This document records
the dark-mode + contrast remediation done in US-439 and the rules that keep it
from regressing.

The numbers below are asserted in code by
`src/lib/a11y/__tests__/contrast.test.ts` (the "documented contrast check"),
which computes WCAG ratios from `src/lib/a11y/contrast.ts`. **If you change a
color token in `src/index.css`, update that test.**

## Status / severity pastels are tokenized with dark counterparts

Light status pastels (`bg-*-50/100/200`, `text-*-600/700/800/900`,
`border-*-100/200/300`) must always ship a `dark:` counterpart so they aren't
near-invisible on the dark theme. The canonical map is `STATUS_TONE_CLASSES` in
`src/lib/constants.ts`; ad-hoc usages were migrated by
`scripts/ralph/dark-a11y-pass.mjs` using this deterministic mapping:

| Light utility       | Dark counterpart        |
| ------------------- | ----------------------- |
| `bg-*-50`           | `dark:bg-*-950/40`      |
| `bg-*-100`          | `dark:bg-*-950/50`      |
| `bg-*-200`          | `dark:bg-*-900/40`      |
| `text-*-600`        | `dark:text-*-400`       |
| `text-*-700/800`    | `dark:text-*-300`       |
| `text-*-900`        | `dark:text-*-200`       |
| `border-*-200/300`  | `dark:border-*-800`     |
| `border-*-100`      | `dark:border-*-900`     |

Solid mid-tones (`bg-*-500/600/700`) are intentionally excluded — they read fine
in both themes and usually carry white text.

## Brand navy text inverts

`text-brand-navy` (#0c1e36) is ~1.4:1 on the dark background. On themeable
surfaces it now pairs with `dark:text-foreground` (or uses `text-foreground`
outright, e.g. `.prose-legal h2`) so headings invert. `bg-brand-navy` is
unaffected — it stays navy as a fixed brand surface.

## Red is split into a background red and a text red

The vibrant brand red can't be both a white-on-red surface and legible red text,
so the two roles use different tokens:

| Token                     | Light     | Dark      | Used for                          |
| ------------------------- | --------- | --------- | --------------------------------- |
| `--color-brand-red` (bg)  | `#cc1f3d` | `#cc1f3d` | `bg-brand-red` CTAs (white text)  |
| `--color-brand-red-text`  | `#cc1f3d` | `#fb5e78` | `text-brand-red-text` red copy    |
| `--destructive`           | `#cc1f3d` | `#fb5e78` | destructive text + buttons        |

Measured ratios (all ≥ 4.5:1):

- White on `bg-brand-red` (#cc1f3d): **5.48:1** (both themes).
- Red text light (#cc1f3d) on `#fafafc`: **5.26:1**; on `#fff`: **5.48:1**.
- Red text dark (#fb5e78) on `#0e0e1a`: **6.36:1**; on `#0c1e36`: **5.56:1**.
- White on the dark destructive button (`dark:bg-destructive/60` over card):
  **6.21:1**.
- `muted-foreground` light (#64748b) on `#fafafc`: **4.57:1**; dark (#94a3b8)
  on `#0e0e1a`: **7.47:1** — already AA, left unchanged.

The previous brand red `#f03d5f` measures **3.79:1** as text on white (fails AA
normal, passes AA large), which is why it was deepened.

### Rule for new code

- Red **text** → `text-brand-red-text` (or `text-destructive` for errors).
  Never `text-brand-red`.
- Red **surface** with white text → `bg-brand-red` / `bg-destructive`.
- Exception: on a **fixed-dark** surface that doesn't follow the theme (e.g. the
  always-navy admin sidebar `bg-brand-night`), use the light red directly
  (`text-[#fb5e78]`) since the inverting token would resolve to the dark red in
  light mode.
