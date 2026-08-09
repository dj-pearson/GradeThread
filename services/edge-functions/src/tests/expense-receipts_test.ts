// US-2228 AC2 — the receipt on an operating expense.
//
// Two things are worth testing here and they are not the same thing:
//
//   1. WHAT GETS IN. A receipt is the one upload on this product that is
//      legitimately not an image — a PDF invoice from a supplier is the normal
//      case, not an edge case. validateImageUpload actively REJECTS PDFs, and
//      widening it would have quietly let a PDF into the garment-photo path
//      where nothing downstream can read one. So validateReceiptUpload is a
//      separate door, and these tests pin that it is a NARROWER one everywhere
//      else: no SVG, no HEIC, no renamed executable, same size cap.
//
//   2. WHERE IT LANDS. receiptStoragePath's first segment is the OWNER's id,
//      never the caller's. A workspace member uploading on the owner's behalf
//      has a different user id, and writing under it would put the object in a
//      folder that claims the row belongs to someone it does not belong to.
//      That is a naming bug with a privacy shape, and it is invisible at
//      runtime because the edge reads the path back out of the row either way.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  looksLikePdf,
  validateReceiptUpload,
} from "../lib/upload-validation.ts";
import { receiptStoragePath } from "../routes/flipdesk-expenses.ts";

// ── Fixtures ───────────────────────────────────────────────────────

function pdf(version = "1.4"): Uint8Array {
  return new TextEncoder().encode(`%PDF-${version}\n1 0 obj\n<<>>\nendobj\n`);
}

function png2x2(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    return [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...data,
      0,
      0,
      0,
      0, // crc placeholder
    ];
  };
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
}

function heic(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([...new TextEncoder().encode("ftypheic")], 4);
  return b;
}

// ── looksLikePdf ───────────────────────────────────────────────────

Deno.test("looksLikePdf reads the magic bytes, not the extension", () => {
  assert(looksLikePdf(pdf()));
  assert(looksLikePdf(pdf("1.7")));
  assert(looksLikePdf(pdf("2.0")));
  // Near misses: the sniff is anchored at offset 0 and needs the trailing dash.
  assert(!looksLikePdf(new TextEncoder().encode("%PDF")));
  assert(!looksLikePdf(new TextEncoder().encode(" %PDF-1.4")));
  assert(!looksLikePdf(new TextEncoder().encode("not a pdf %PDF-1.4")));
  assert(!looksLikePdf(new Uint8Array(0)));
  assert(!looksLikePdf(png2x2()));
});

// ── validateReceiptUpload: what gets in ────────────────────────────

Deno.test("a PDF invoice is accepted, and is the only non-image that is", () => {
  const r = validateReceiptUpload(pdf());
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.kind, "pdf");
    assertEquals(r.contentType, "application/pdf");
    assertEquals(r.ext, "pdf");
    // No format: PDFs are stored byte-for-byte, so there is nothing to strip
    // and nothing for the caller to pass to stripImageMetadata.
    assertEquals(r.format, null);
  }
});

Deno.test("a photo of a paper receipt is accepted and reports its image format", () => {
  const r = validateReceiptUpload(png2x2());
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.kind, "image");
    assertEquals(r.contentType, "image/png");
    assertEquals(r.ext, "png");
    assertEquals(r.format, "png");
  }
});

// The PDF branch must not become a hole in the image rules. Everything below is
// what validateImageUpload already refuses, re-checked through the new door.
Deno.test("SVG is still refused — the PDF branch is not a general escape hatch", () => {
  const r = validateReceiptUpload(
    new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
  );
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("SVG"));
});

Deno.test("HEIC is refused: the bucket's allowed_mime_types does not list it", () => {
  // Accepting it here would push the failure down to the storage layer, where
  // the seller gets an error about MIME types they cannot act on.
  const r = validateReceiptUpload(heic());
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("not allowed"));
});

Deno.test("a renamed executable and an empty file are refused", () => {
  assert(!validateReceiptUpload(new Uint8Array([0x4d, 0x5a, 1, 2, 3, 4, 5, 6])).ok);
  assert(!validateReceiptUpload(new Uint8Array(0)).ok);
});

Deno.test("the size cap applies to PDFs too, and is checked BEFORE the sniff", () => {
  // Order matters: sniffing first would mean a 400 MB file is fully inspected
  // before being rejected for its size.
  const r = validateReceiptUpload(pdf(), { maxBytes: 4 });
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("too large"));
  assert(!validateReceiptUpload(png2x2(), { maxBytes: 4 }).ok);
});

// ── receiptStoragePath: where it lands ─────────────────────────────

Deno.test("the path is scoped to the OWNER, not whoever uploaded", () => {
  const owner = "11111111-1111-1111-1111-111111111111";
  const expense = "22222222-2222-2222-2222-222222222222";
  const path = receiptStoragePath(owner, expense, "pdf", 1700000000000);
  assertEquals(path, `${owner}/${expense}/receipt_1700000000000.pdf`);
  // The folder convention the bucket's per-user policies would read is the
  // FIRST segment, so that is the assertion that actually matters.
  assertEquals(path.split("/")[0], owner);
});

Deno.test("replacing a receipt writes a new key, so no stale object is served", () => {
  const owner = "aaaa";
  const expense = "bbbb";
  const first = receiptStoragePath(owner, expense, "jpg", 1000);
  const second = receiptStoragePath(owner, expense, "jpg", 2000);
  assert(first !== second, "the timestamp must make the key unique");
  // Same folder, so the old object is still findable for deletion.
  assertEquals(
    first.slice(0, first.lastIndexOf("/")),
    second.slice(0, second.lastIndexOf("/")),
  );
});
