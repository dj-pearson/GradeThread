---
title: Image intake — what the bytes are, not what the name says
aliases: [media_type 400, HEIC, Live Photo, webp but appears jpeg]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/test/public-bucket-mime-allowlist.test.ts
  - services/edge-functions/src/lib/grading-image-encoding.ts
  - services/edge-functions/src/lib/upload-validation.ts
  - services/edge-functions/src/routes/flipdesk-expenses.ts
  - src/lib/media-intake.ts
reviewed: 2026-08-30
tags: [grading, uploads, images, gotcha]
summary: A file's extension and its bytes disagree often enough to break grading — sniff the bytes on the way in and on the way out.
---

# Image intake — what the bytes are, not what the name says

One rule, two places it is enforced: **a filename never establishes what an image
is.** Sniff the magic bytes.

## Reading: the vision call rejects a wrong `media_type`

Anthropic's vision API sniffs the image itself and returns a 400
`invalid_request_error` when the declared type disagrees:

> The image was specified using the image/webp media type, but the image appears
> to be a image/jpeg image.

Grading built the data URI's media type from the **storage-path extension**, and
a `.webp`-named object can hold JPEG bytes — any relabelled or re-encoded photo
does this. One bad image fails its `analyzeImage` call, and since front/back/label
are required, **the whole grading fails and auto-refunds**. A single mislabelled
file costs the seller their submission.

`mediaTypeForVision(bytes, storagePath)` sniffs via `sniffImageFormat` +
`IMAGE_CONTENT_TYPE` (from `upload-validation.ts`). It lived in
`grading-pipeline.ts` until **US-2443 moved it to
`grading-image-encoding.ts`**, alongside `uint8ToBase64` and
`downloadGradingImage`, because it had become three copies: the pipeline had
one, `grading-eval.ts` had a byte-for-byte re-implementation inside
`downloadCaseImage` held together only by a comment, and the per-image shadow
path would have made a fourth. All three now call the one module;
`grading-pipeline.ts` re-exports `mediaTypeForVision` so the existing test
import still resolves. `ai-authenticity.ts` trusts its data-URI prefix but is
fed the pipeline's now-correct URIs, so it was fixed transitively.
`ai-extract.ts` already sniffed — it is the pattern to copy.

Two things worth knowing:

- The fix is **read-side and defensive**. The write-side bug — objects stored
  under an extension that does not match their bytes — still exists. It no longer
  breaks grading, and a previously-failed item now succeeds on resubmit **without
  re-uploading**.
- HEIC sniffs as unknown deliberately: the vision API cannot accept it, and the
  private grading bucket rejects it at upload.

## Writing: normalise the phone's oddities in the browser

`src/lib/media-intake.ts` `normalizeToImageFile(file)` converts a Live Photo
exported as `.mov`/`.mp4` into a still JPEG frame (`<video>` + `<canvas>`) and
HEIC/HEIF into JPEG, passing normal images straight through. It runs on **all
three** web upload surfaces — bulk AutoLister, grading photo upload, listing
photo uploader — and always **before** validate/compress. Each surface widened
its `accept` to include `video/*,.mov,.mp4,.m4v,.heic,.heif`.

**The iOS app needs none of this.** Its PHPicker uses `config.filter = .images`,
which already hands back the still frame for a Live Photo and excludes raw
videos. This is a desktop-web problem only — worth knowing before "fixing" it on
mobile.

### Two infra constraints this created — do not regress them

- **The HEIC decoder must be `heic-to/csp`, not `heic2any`.** heic2any failed
  *silently in production*: its worker calls `new Function()`, which our
  enforcing CSP blocks (`script-src` allows `'wasm-unsafe-eval'`, not
  `'unsafe-eval'`). `heic-to/csp` is the WASM-only build and runs under the
  permission we already grant. Import as
  `import { heicTo } from "heic-to/csp"`.
- **`media-src 'self' blob:`** in `public/_headers` — without it the video
  frame-grab's object URL falls back to `default-src 'self'` and is blocked.
- **`workbox.globIgnores: ["**/heic-to-*.js"]`** in `vite.config.ts` — the WASM
  chunk is ~3 MB and exceeds Workbox's precache cap, which **errors the build**.
  It is dynamic-imported on demand, so excluding it is correct rather than a
  workaround.

## What actually stops a hostile upload (US-2385)

Not the browser. **A client-side check is not a control at any point in this
system**, and the reason is worth stating plainly because it keeps getting
re-proposed: any signed-in user can call the Storage API directly with their own
token. Page code an attacker never executes cannot validate anything on the
server's behalf. Client-side work here — the EXIF strip, the HEIC decode, the
canvas re-encode — exists for *correctness and privacy on the honest path*, not
as a security boundary.

The two server-side controls, in the order they fire:

1. **`storage.buckets.allowed_mime_types`.** storage-api validates the declared
   content-type of every upload against the bucket's list, including direct API
   calls, and rejects a mismatch with 415. Every bucket carries one except
   `compliance-exports`, which has no storage policies at all and is therefore
   deny-all to users.
2. **The edge upload path**, on the two PRIVATE buckets that have one.
   `submission-images`: `validateImageUpload()` sniffs magic bytes and
   `stripImageMetadata()` drops EXIF/GPS before `storage.upload()` (US-276).
   `expense-receipts`: `validateReceiptUpload()` does the same, with one
   deliberate exception — see below (US-2228).

> [!note] There are TWO ways into `expense-receipts`, and they validate
> differently (US-2993, 2026-08-29)
> The upload above takes a receipt the seller already has. **Receipt SCANNING**
> (`POST /api/flipdesk/expenses/scan`) takes a photo and reads the amount and
> date off it, and it uses `validateImageUpload()` with
> `allow: ["jpeg", "png", "webp"]` — **not** `validateReceiptUpload()`, because
> there is nothing to read off a PDF with a vision model and admitting one would
> mean a scan path that accepts a file it cannot use.
>
> The order is the interesting part: the image is validated, stripped and
> **parked in storage BEFORE extraction runs**. Extracting first and uploading
> after would save the seller nothing when the extraction fails — they would
> have lost both the reading and the receipt.

> [!warning] `item-photos` has NEITHER control today, and Android proves it
> The list above is exhaustive on purpose. `item-photos` is the public seller
> bucket and there is **no edge upload path for it** — clients mint a signed URL
> and PUT straight to storage. So the only metadata strip on a listing photo is
> the client-side one, which is exactly the work the paragraph above says is not
> a security boundary.
>
> Traced 2026-08-16 (US-2658): the Android CAMERA path does not do it either.
> `CaptureScreen.capture()` records the raw CameraX file
> (`CaptureScreen.kt:175`), `UploadWorker` PUTs those bytes unchanged
> (`PhotoUpload.kt:124`), and `PhotoProcessor` — which is what re-encodes without
> EXIF and bakes orientation into the pixels — is reached only from the library
> picker. iOS compresses every camera shot before storing it
> (`PhotoIntakeView.swift:1025`), so this is a defect rather than a platform
> difference.
>
> The consequence to hold onto: for a listing photo, "the honest path" and "the
> only path" are the same thing, so a client that skips the strip ships the
> metadata. Nothing downstream catches it.

### The one upload that is legitimately not an image (US-2228)

`expense-receipts` is the only bucket admitting `application/pdf`, because half
of what a seller gets emailed is a PDF invoice, and telling them to screenshot it
would make the app's problem theirs.

It is a **separate function, not a flag**, and that is the part to keep.
`validateImageUpload()` still REJECTS a PDF by magic bytes, because everywhere
else a PDF arriving where an image was expected is an attack shape. A flag would
have loosened that for garment photos, listing imagery and dispute evidence too.
`validateReceiptUpload()` checks `%PDF-` at offset 0 first, then falls through to
`validateImageUpload()` restricted to jpeg/png/webp.

`application/pdf` is deliberately NOT in the guard's `EXECUTABLE_TYPES`. A PDF's
embedded script runs in the browser's sandboxed viewer, not in the storage
origin; the bucket is private with no storage policies, and the only person who
can get a URL is the seller who uploaded it, through a ≤900s signed URL issued
after an ownership check. The threat the allow-lists guard is hosting active
content FOR OTHERS, which a private per-owner bucket cannot do. **A PDF must not
be accepted into any surface lacking those four properties.**

**The honest limitation:** an image receipt goes through `stripImageMetadata`, so
EXIF and GPS are gone. A PDF does NOT — author, producer, sometimes a local file
path survive, because stripping them needs a PDF parser this repo does not have
and will not hand-roll.

The public buckets deliberately have **no magic-byte sniff**, and that is a
decision rather than a gap. A file whose bytes lie under an honest
`image/jpeg` label is served as `image/jpeg`, with `X-Content-Type-Options:
nosniff`, from an origin that is not the app's — so no browser executes it. The
seller sees a broken image on their own listing. That is a data-quality problem.

**`image/svg+xml` is the type that would turn it into a security problem**, and
it is the trap worth naming: it reads as an image type, it sits naturally in an
image allow-list, and it carries `<script>`. No bucket admits it.

Since the allow-lists are the whole control, they are pinned:
`src/test/public-bucket-mime-allowlist.test.ts` enumerates every bucket, fails
on an undeclared or newly-public one, fails on a bucket with no list, and fails
on any list admitting an executable type. Negative-verified by adding
`image/svg+xml` to `item-photos`.

## Related

- [[grading-scale-and-weights]] — what happens to the image once it is accepted
- [[qa-photo-access]] — how graders reach stored photos
- [[seo-performance-images]] — the other CSP-sensitive asset path
- [[INDEX]]
