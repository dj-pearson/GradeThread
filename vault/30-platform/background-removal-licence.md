---
title: On-device background removal is AGPL, and it is already shipping
aliases: [imgly, background-removal licence, AGPL, remove-bg local]
type: decision
status: current
source_of_truth: code
code_refs:
  - src/lib/background-removal.ts
  - package.json
reviewed: 2026-09-05
tags: [licensing, legal, images, extension, open-question]
summary: "@imgly/background-removal is AGPL-3.0 and its JavaScript is served from gradethread.com to every seller who opens the photo editor. Live since US-535, never recorded until now, and US-3069 would make it the default path."
---

# On-device background removal is AGPL, and it is already shipping

> [!warning] This is an OPEN question for the owner, not a settled decision.
> Nothing here is a legal opinion. It is the set of facts somebody with a legal
> opinion would need, measured rather than assumed, on 2026-09-05.

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
