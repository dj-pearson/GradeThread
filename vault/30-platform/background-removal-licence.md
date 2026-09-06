---
title: On-device background removal is AGPL, and it is already shipping
aliases: [imgly, background-removal licence, AGPL, remove-bg local]
type: decision
status: accepted
source_of_truth: code
code_refs:
  - src/lib/background-removal.ts
  - package.json
reviewed: 2026-09-05
tags: [licensing, legal, images, extension, open-question]
summary: "@imgly/background-removal is AGPL-3.0 and shipped from gradethread.com from US-535. RESOLVED 2026-09-05 by swapping to U^2-Net (Apache 2.0) through onnxruntime-web (MIT); the weights are the one step left."
---

# On-device background removal is AGPL, and it is already shipping

> [!success] DECIDED 2026-09-05: swap it out. Done in code the same day.
> The owner chose to replace the library rather than buy a licence or revert to
> the server. `@imgly/background-removal` is gone from package.json and imported
> nowhere; `src/lib/segment-u2net.ts` runs U^2-Net (Apache 2.0) through
> onnxruntime-web (MIT), both same-origin. See "What was done" at the foot.
>
> Nothing here is a legal opinion. It is the set of facts somebody with a legal
> opinion would need, measured rather than assumed.

## What was measured

**`@imgly/background-removal@1.7.0` is AGPL-3.0.** `node_modules/@imgly/`
`background-removal/LICENSE.md` is the GNU Affero General Public License v3
text. npm's metadata says only `SEE LICENSE IN LICENSE.md`, which is why an
`npm ls --json` licence sweep would not have surfaced it as AGPL.

**Its JavaScript is served from our own origin.** After a production build the
library's own package record is present in a lazily-loaded chunk:

```
dist/assets/index-CpE0gTNn.js   81,187 bytes
  bt={name:"@imgly/background-removal",version:"1.7.0"}
  ... InferenceSession, ort-wasm, @imgly/background-removal-data
```

**But NOT in the entry bundle**, and the code comment claiming that is correct.
`dist/index.html` loads `assets/index-CxgO5kBc.js`; the imgly code is a separate
chunk pulled in by the dynamic `import("@imgly/background-removal")` in
`src/lib/background-removal.ts`. Lazy-loading changes WHEN the code is served,
not WHETHER — a seller who opens the photo editor is served AGPL JavaScript by
gradethread.com.

The multi-megabyte ONNX runtime and the segmentation model are a separate
matter: those are fetched at runtime from `staticimgly.com` (allow-listed in
`connect-src`, see `functions/_shared/app-shell-headers.ts`), so those bytes
never come from us.

**It has been live since US-535** (`13ab108ab`, "one-tap on-device background
removal + studio-white") and is reached from
`src/components/flipdesk/photo-editor-dialog.tsx` and
`src/pages/flipdesk/autolister.tsx`.

**The licence had never been recorded anywhere in the repo.** No mention of AGPL
in `src/`, `vault/`, `docs/` or `package.json` before this note. The wrapper's
own comment describes it as "a free WASM segmentation model", which is true
about the API bill and says nothing about the obligations.

## Why it matters here specifically

AGPL is the licence written for the case where software is used over a network
without being distributed. Serving the library's JavaScript to a browser is not
the network-use edge case it was written to close — it is ordinary conveying,
and the copyleft reaches the work it is combined with. IMG.LY sells a commercial
licence for exactly this situation, which is the strongest available signal
about how the author reads their own terms.

Three things follow, and the third is the one that made this note worth writing:

1. If a commercial licence is already held, this is a documentation gap and
   nothing more. Record the licence reference here and close the note.
2. If it is not, the exposure exists TODAY and is not created by US-3069.
3. **US-3069 would deepen it.** That story makes the local path the default for
   every background removal, replacing the paid `remove.bg` server call. Building
   it is a decision to rely on this library more, which is worth making
   deliberately rather than by finishing a ticket.

## What US-3069 would need if the answer is "replace it"

The story's shape survives a swap — a Web Worker, a progress callback, a server
fallback, a mask-coverage quality gate — because none of that is imgly-specific.
What changes is the model and the runtime: a permissively licensed segmentation
model (Apache-2.0 or MIT) driven through `onnxruntime-web` directly, with the
weights vendored to `/public/models` rather than pulled from a vendor CDN. That
is more work than `import { removeBackground }`, and it is work the story's AC4
already half-anticipates by offering `/public/models` as an option.

## The cheap interim, if the answer is "not yet"

The server `/remove-bg` route (`services/edge-functions/src/routes/`
`flipdesk-images.ts`) is unchanged and still works. Leaving the default
server-side costs money per image and nothing else, which is the position the
product was in before US-535.

## Related

- [[states-that-look-normal]] — a dependency whose licence npm reports as
  "SEE LICENSE IN LICENSE.md" reads exactly like one with no licence problem.

## What was done (2026-09-05)

`@imgly/background-removal` is removed from `package.json` and imported from no
file. `src/lib/segment-u2net.ts` replaces it: U^2-Net through onnxruntime-web,
with the preprocessing, the min-max mask rescale and the bilinear resample
written out and unit-tested, because each of those is a silent failure that
produces a plausible-looking mask cut in the wrong place.

**Both replacement licences were checked, not assumed.**

| Component | Licence | How it was checked |
|---|---|---|
| `onnxruntime-web` 1.21.0 | MIT | its own package.json; it was already installed as a transitive dep of the removed library, so this is a promotion to direct rather than a new dependency |
| U^2-Net | Apache 2.0 | the LICENSE file in `github.com/xuebinqin/U-2-Net`, read 2026-09-05; no clause restricting commercial use |

> [!warning] The obvious alternative is worse, and it is named in the source
> BRIA's **RMBG-1.4** is the model most background-removal examples reach for
> and it is explicitly **non-commercial**. Swapping one licence problem for a
> second is the failure this change exists to undo, so the model was chosen on
> its licence first and its quality second.

Nothing is fetched from a vendor CDN any more either. The old library pulled its
ONNX runtime and model from `staticimgly.com`; both replacements are served from
our own origin, and a test asserts the paths are absolute and same-origin.

## The one step left, and it needs a person

**The weights are not vendored.** `available()` answers false while
`/models/u2netp.onnx` is not served, `removeImageBackground` throws the named
`NoLocalSegmenter`, and both call sites say so in words rather than reporting a
failed removal — a generic "background removal failed" on a missing model blames
the photo, and a seller retries with a better one forever.

So on-device removal is OFF until somebody vendors two things into `public/`:

1. `public/models/u2netp.onnx` — the small U^2-Net variant, about 4.7 MB.
2. `public/models/ort/` — the `.wasm` files from
   `node_modules/onnxruntime-web/dist/`, which `ORT_WASM_PATH` points at.

⚠ **Whoever does it should pick the artifact deliberately.** An ONNX export is a
binary from a third party, and committing one is a supply-chain decision rather
than a copy: record where it came from and its SHA-256 next to it. That is why
this was left rather than done automatically.

**What still works meanwhile:** the server route
(`POST /api/flipdesk/images/remove-bg`, `use-remove-bg.ts`) is untouched and is
what the photo grid uses. It takes a persisted `item_photo_id` rather than a
blob, so it is NOT a drop-in for the editor dialog or the AutoLister staging
path — those two are the surfaces that lose the feature until the weights land.
That asymmetry was checked rather than assumed; the first draft of this note
claimed the server was a general fallback, and it is not.
