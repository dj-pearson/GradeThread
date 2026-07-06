# GradeThread Design System — build conventions

GradeThread / FlipDesk UI. React 19 + Tailwind CSS v4 + shadcn/ui (New York style).
Brand: navy `--primary` (#0F3460), red `--destructive`/accent (#E94560).

## Setup & wrapping
- **No provider is required.** Design tokens are global CSS custom properties defined in `styles.css` — there is no ThemeProvider to wrap. Just render components; tokens apply automatically.
- **Dark mode:** add `class="dark"` to an ancestor element; the token values swap. Don't hardcode hex — use the token classes below so both themes work.
- **Overlays** (`Dialog`, `Sheet`, `Popover`, `DropdownMenu`, `Select`, `AlertDialog`) are Radix-based compound components. Control them with `open` / `onOpenChange` (or `defaultOpen`); compose the parts (`DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter`, …). They portal to `document.body`.
- **Fonts** ship with the system: **Inter** (body/UI) and **Outfit** (display). Already wired in `styles.css` — don't re-import.

## Styling idiom — Tailwind utility classes + shadcn tokens
Style with Tailwind v4 utility classes bound to the DS tokens. **Never hardcode colors** — use the token utilities so brand + dark mode hold:

| Purpose | Class | Token |
|---|---|---|
| Primary surface / CTA | `bg-primary text-primary-foreground` | navy |
| Destructive / accent | `bg-destructive text-white` | red |
| Secondary | `bg-secondary text-secondary-foreground` | |
| Card surface | `bg-card text-card-foreground` | |
| Page background / text | `bg-background text-foreground` | |
| Muted / hint text | `text-muted-foreground` | |
| Subtle hover / fill | `bg-accent` / `bg-muted` | |
| Borders | `border border-border` | |
| Focus ring | `ring-ring` | |
| Radius | `rounded-md` (controls), `rounded-xl` (cards) | |

## Component API notes (the `.d.ts` is loose — props resolve to `unknown`; use this)
- **`Button`** — `variant`: `default | secondary | outline | ghost | destructive | link`; `size`: `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`. Renders a `<button>`; `asChild` to wrap a link.
- **`Badge`** — `variant`: `default | secondary | outline | destructive | ghost | link`. Pill shape.
- **`StatusBadge`** — `status`: a FlipDesk item status (`sourced | acquired | cataloged | measured | photographed | grading | graded | comped | drafted | listed | sold | shipped | completed | returned | archived | keeping`). Color/label come from the central status→tone map; don't restyle.
- **Compound families** — compose the parts: `Card`(`CardHeader/CardTitle/CardDescription/CardAction/CardContent/CardFooter`), `Table`(`TableHeader/TableBody/TableRow/TableHead/TableCell/TableCaption`), `Select`(`SelectTrigger/SelectValue/SelectContent/SelectItem/SelectGroup/SelectLabel`), `Tabs`(`TabsList/TabsTrigger/TabsContent`), `Avatar`(`AvatarImage/AvatarFallback/AvatarGroup/AvatarGroupCount`).

## Where the truth lives
- **`styles.css`** — the full token + font layer (read this before styling; its `@import` closure is what designs receive).
- **`components/<group>/<Name>/<Name>.prompt.md`** — per-component usage + examples.
- **`components/<group>/<Name>/<Name>.d.ts`** — the type surface (loose for shadcn primitives; prefer the variant lists above).

## One idiomatic snippet
```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction, Badge, Button } from 'GradeThread'

<Card className="w-[340px]">
  <CardHeader>
    <CardTitle>Levi&apos;s 501 · Vintage Denim</CardTitle>
    <CardDescription className="text-muted-foreground">Certificate #GT-4821</CardDescription>
    <CardAction><Badge>9.5</Badge></CardAction>
  </CardHeader>
  <CardContent className="text-sm">Fabric 9.5 · Structural 9.0 · Cosmetic 10.0</CardContent>
  <CardFooter className="gap-2">
    <Button size="sm">View certificate</Button>
    <Button size="sm" variant="outline">Share</Button>
  </CardFooter>
</Card>
```
