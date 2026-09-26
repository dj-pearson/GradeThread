// US-3518: read provenance EXIF from the photo BYTES on the server.
//
// Verified Capture used to trust an `exif` JSON form field the client sent
// beside each photo, so anyone could post {make, model, dateTimeOriginal} and
// earn the public badge plus a confidence boost. This reads the same fields
// from the uploaded file (or the retained original) instead, and tags the
// result `source: "server"` so verified-capture.ts can tell it apart from the
// client-reported copy, which is kept for information only.
//
// US-3520: GPS is never read. A seller's location has no use in grading and
// was being stored where staff could read it.
//
// A port of the web parser in src/lib/image-utils.ts (JPEG APP1 / TIFF IFD
// walk, no decoder, no dependency) minus the GPS IFD. Best effort: any
// malformed or absent EXIF answers null and never throws.

export type ServerExif = {
  source: "server";
  make?: string;
  model?: string;
  software?: string;
  lensModel?: string;
  orientation?: number;
  dateTime?: string;
  dateTimeOriginal?: string;
};

const MAX_STR = 256;

function parseTiff(view: DataView, tiff: number): ServerExif | null {
  if (tiff + 8 > view.byteLength) return null;
  const le = view.getUint16(tiff, false) === 0x4949; // "II" = little-endian
  if (view.getUint16(tiff + 2, le) !== 0x002a) return null; // TIFF magic
  const ifd0 = tiff + view.getUint32(tiff + 4, le);

  const meta: Omit<ServerExif, "source"> = {};
  let exifIfdPtr = 0;

  const readAscii = (entry: number): string => {
    const count = view.getUint32(entry + 4, le);
    let valOff = entry + 8;
    if (count > 4) valOff = tiff + view.getUint32(entry + 8, le);
    let s = "";
    for (let i = 0; i < count && s.length < MAX_STR; i++) {
      if (valOff + i >= view.byteLength) break;
      const ch = view.getUint8(valOff + i);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s.trim();
  };

  const walkIfd = (
    ifdStart: number,
    handler: (tag: number, entry: number) => void,
  ) => {
    if (ifdStart < tiff || ifdStart + 2 > view.byteLength) return;
    const entries = view.getUint16(ifdStart, le);
    for (let i = 0; i < entries; i++) {
      const entry = ifdStart + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      handler(view.getUint16(entry, le), entry);
    }
  };

  walkIfd(ifd0, (tag, entry) => {
    switch (tag) {
      case 0x010f: {
        const v = readAscii(entry);
        if (v) meta.make = v;
        break;
      }
      case 0x0110: {
        const v = readAscii(entry);
        if (v) meta.model = v;
        break;
      }
      case 0x0131: {
        const v = readAscii(entry);
        if (v) meta.software = v;
        break;
      }
      case 0x0132: {
        const v = readAscii(entry);
        if (v) meta.dateTime = v;
        break;
      }
      case 0x0112: {
        const o = view.getUint16(entry + 8, le);
        if (o >= 1 && o <= 8) meta.orientation = o;
        break;
      }
      case 0x8769:
        exifIfdPtr = tiff + view.getUint32(entry + 8, le);
        break;
    }
  });

  if (exifIfdPtr) {
    walkIfd(exifIfdPtr, (tag, entry) => {
      switch (tag) {
        case 0x9003: {
          const v = readAscii(entry);
          if (v) meta.dateTimeOriginal = v;
          break;
        }
        case 0xa434: {
          const v = readAscii(entry);
          if (v) meta.lensModel = v;
          break;
        }
      }
    });
  }

  return Object.keys(meta).length > 0 ? { source: "server", ...meta } : null;
}

/** Provenance EXIF read from JPEG bytes, or null. Never throws. */
export function readExifFromBytes(bytes: Uint8Array): ServerExif | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset, false);
      if (marker === 0xffe1) {
        if (offset + 10 > view.byteLength) return null;
        if (view.getUint32(offset + 4, false) !== 0x45786966) return null; // "Exif"
        return parseTiff(view, offset + 10);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      offset += 2 + view.getUint16(offset + 2, false);
    }
    return null;
  } catch {
    return null;
  }
}

// Sanitize + bound the client-supplied EXIF blob (US-339). Never trust the
// client: keep only known fields and cap string lengths. Returns null when
// nothing usable remains (the common case).
//
// US-3518: the result is tagged `source: "client"`. It is kept for information
// only; Verified Capture counts EXIF the server read from the bytes itself.
// US-3520: GPS is dropped. Nothing in grading uses a seller's location.
export function sanitizeExif(
  raw: unknown,
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const copyStr = (k: string) => {
    const v = src[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 256);
  };
  copyStr("make");
  copyStr("model");
  copyStr("software");
  copyStr("lensModel");
  copyStr("dateTime");
  copyStr("dateTimeOriginal");
  if (typeof src.orientation === "number" && Number.isFinite(src.orientation)) {
    const o = Math.trunc(src.orientation);
    if (o >= 1 && o <= 8) out.orientation = o;
  }
  return Object.keys(out).length > 0 ? { source: "client", ...out } : null;
}
