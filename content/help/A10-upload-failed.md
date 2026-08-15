---
slug: upload-failed
title: An upload failed
category: troubleshooting
visibility: public
audience: seller
sort_order: 20
pillar_path: /how-it-works
summary: Why a photo can be rejected, what a stalled upload usually means, and the one file type that will never work.
faq:
  - q: Why was my file rejected when it is definitely an image?
    a: The check reads the actual bytes rather than the file extension. A file renamed to .jpg is still whatever it was, and something exported oddly can carry a different format inside than its name suggests.
  - q: Can I upload an SVG?
    a: No, and that is deliberate rather than an oversight. SVG can carry executable content, so it is refused on every upload path regardless of what it is a picture of.
---

Uploads fail for a small number of reasons, and the message usually names which.
This is what each one means.

## The file is not what its name says

Every upload is checked by reading the actual bytes, not by trusting the
extension.

That catches a file renamed from one format to another, an export that wrote a
different format than the name suggests, and anything that is not an image at
all. The check is deliberate: trusting a client-supplied file type is how
unpleasant things get uploaded.

If a file you are sure is a photograph is rejected, open it and re-save it as
JPEG or PNG from any image application. That rewrites the bytes to match the
name.

## SVG is never accepted

On any upload path, for any purpose.

SVG is a document format that can carry executable content, so it is refused
regardless of what it depicts. This one is not negotiable and there is no
setting.

## It is too large

There are size and dimension limits, and the message names which one you hit.

Phone photographs are almost never too large. Files that are usually come from a
camera shooting raw, or from something upscaled.

Resizing to a few thousand pixels on the long edge loses nothing the assessment
uses and uploads considerably faster.

## The upload stalled

A progress bar that stops rather than an error is usually the network.

**Try one file.** If a single photo works and eight do not, it is bandwidth
rather than the files.

**Try a different network.** Mobile data versus wifi is a quick way to tell.

**Stay on the page.** On a slow connection, navigating away mid-upload cancels
it.

On a phone, photographs taken offline are queued and uploaded when a connection
returns, so a stalled upload in poor signal often resolves itself on the way
home.

<!-- SCREENSHOT: the upload error naming the rejected file (as of 2026-08-15) -->

## What happens to metadata

Location and camera data are stripped from every uploaded image before it is
stored. That is automatic and there is nothing to turn on.

It matters because a photograph taken at home carries your address in it, and a
certificate is a public page. Stripping it is not an option somebody could
forget to enable.

## What is kept private

Grading images are stored privately and are served only through short-lived
links. They are not on a public URL that could be guessed.

The one public bucket is for listing imagery, and grading photos, care labels
and anything else are deliberately not in it.

## If none of that fits

Open a ticket with the file that failed, if you can attach it, and the exact
message.

The message is the useful part. "Upload failed" describes six different causes;
the specific wording distinguishes them, which is why it is specific.

## Uploading from a phone

Two phone-specific cases worth knowing.

**Modern phone formats are fine.** The high-efficiency formats Apple and Android
use by default are accepted, and there is nothing to convert.

**A queued upload is not a failed one.** Photographs taken offline are held and
sent when a connection returns, so an upload that appears stuck in poor signal is
often waiting rather than broken.

## Re-uploading after a fix

If you re-save a file to fix a format problem, upload the new file rather than
retrying the old one. Some browsers hold on to the original selection, and
retrying sends the same rejected bytes again.

Selecting the file fresh is one extra click and removes the ambiguity entirely.

## What a rejection is protecting

The byte-level check looks strict from the outside and it is doing one specific
job: making sure what gets stored and rendered is genuinely an image.

An upload path that trusts the file name accepts whatever somebody names
correctly, and a public product that renders uploaded files is exactly where that
matters. Refusing a mislabelled file costs you one re-save; accepting one costs
everybody.

Same reasoning behind the SVG refusal, which is the only format singled out by
name.
