// EXIF capture-time reader (US-280 / RC-002).
//
// The upload pipeline re-encodes (compresses) images client-side, which strips
// EXIF — so we must read the original capture timestamp from the raw `File`
// BEFORE it goes through compression. This is a tiny zero-dependency parser
// that walks just enough of the JPEG/TIFF structure to find the DateTime tags;
// no EXIF library is pulled in (keeps the bundle impact ~2KB, well under the
// 30KB budget, and fully tree-shakeable since it's a single named export).
//
// Resolution order: DateTimeOriginal (0x9003) → DateTimeDigitized (0x9004) →
// the File's lastModified. Returns null if none of those yield a usable date.

const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TYPE_ASCII = 2;

/**
 * Extracts the original capture time of an image `File`.
 *
 * @returns a `Date` from EXIF if present, else from `file.lastModified`, else
 *   `null` when no usable timestamp is available (e.g. a corrupt/zero-mtime file).
 */
export async function readCaptureTime(file: File): Promise<Date | null> {
  const fromExif = await readExifDateTime(file);
  if (fromExif) return fromExif;

  // Fallback: the filesystem modification time. Browsers default `lastModified`
  // to Date.now() when unknown, but a missing/zero value means "unavailable".
  if (file.lastModified && Number.isFinite(file.lastModified)) {
    return new Date(file.lastModified);
  }
  return null;
}

async function readExifDateTime(file: File): Promise<Date | null> {
  try {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4) return null;

    // JPEG SOI.
    if (view.getUint16(0) !== 0xffd8) return null;

    // Walk JPEG marker segments looking for APP1 (0xFFE1) with an "Exif\0\0"
    // header.
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break; // not a marker — bail out.
      const marker = view.getUint8(offset + 1);
      const size = view.getUint16(offset + 2);
      if (size < 2) break;

      if (marker === 0xe1) {
        const segStart = offset + 4;
        // "Exif\0\0"
        if (
          segStart + 6 <= view.byteLength &&
          view.getUint32(segStart) === 0x45786966 &&
          view.getUint16(segStart + 4) === 0x0000
        ) {
          return parseTiffDateTime(view, segStart + 6);
        }
      }
      offset += 2 + size;
    }
    return null;
  } catch {
    // Any malformed structure → treat as no EXIF and let the caller fall back.
    return null;
  }
}

function parseTiffDateTime(view: DataView, tiffStart: number): Date | null {
  if (tiffStart + 8 > view.byteLength) return null;

  // Byte order: "II" (0x4949) little-endian, "MM" (0x4d4d) big-endian.
  const byteOrder = view.getUint16(tiffStart);
  let little: boolean;
  if (byteOrder === 0x4949) little = true;
  else if (byteOrder === 0x4d4d) little = false;
  else return null;

  const ifd0Offset = view.getUint32(tiffStart + 4, little);

  // Read IFD0, then follow the Exif sub-IFD pointer (where the DateTime*
  // tags actually live).
  const ifd0 = readIfd(view, tiffStart, ifd0Offset, little);
  if (!ifd0) return null;

  // Some cameras put DateTime in IFD0 too, but the originals live in the Exif
  // sub-IFD — prefer that. The pointer entry's value is the sub-IFD offset.
  const exifPtrEntry = ifd0.get(TAG_EXIF_IFD_POINTER);
  if (exifPtrEntry !== undefined) {
    const exifOffset = view.getUint32(exifPtrEntry.valueOffset, little);
    const exifIfd = readIfd(view, tiffStart, exifOffset, little);
    if (exifIfd) {
      const original = readAsciiTag(view, tiffStart, exifIfd, TAG_DATETIME_ORIGINAL, little);
      const parsedOriginal = parseExifDate(original);
      if (parsedOriginal) return parsedOriginal;

      const digitized = readAsciiTag(view, tiffStart, exifIfd, TAG_DATETIME_DIGITIZED, little);
      const parsedDigitized = parseExifDate(digitized);
      if (parsedDigitized) return parsedDigitized;
    }
  }
  return null;
}

interface IfdEntry {
  type: number;
  count: number;
  valueOffset: number; // absolute offset of the 4-byte value/offset field
}

/** Reads an IFD's entries into a tag→entry map. */
function readIfd(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  little: boolean,
): Map<number, IfdEntry> | null {
  const base = tiffStart + ifdOffset;
  if (base + 2 > view.byteLength) return null;

  const count = view.getUint16(base, little);
  const entries = new Map<number, IfdEntry>();
  for (let i = 0; i < count; i++) {
    const entryOffset = base + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const valueCount = view.getUint32(entryOffset + 4, little);
    entries.set(tag, { type, count: valueCount, valueOffset: entryOffset + 8 });
  }
  return entries;
}

function readAsciiTag(
  view: DataView,
  tiffStart: number,
  ifd: Map<number, IfdEntry>,
  tag: number,
  little: boolean,
): string | null {
  const entry = ifd.get(tag);
  if (!entry || entry.type !== TYPE_ASCII || entry.count === 0) return null;

  // ASCII values <= 4 bytes are inlined; otherwise the field holds an offset.
  const dataOffset =
    entry.count <= 4 ? entry.valueOffset : tiffStart + view.getUint32(entry.valueOffset, little);
  if (dataOffset + entry.count > view.byteLength) return null;

  let str = "";
  for (let i = 0; i < entry.count; i++) {
    const ch = view.getUint8(dataOffset + i);
    if (ch === 0) break; // NUL terminator
    str += String.fromCharCode(ch);
  }
  return str;
}

/** Parses the EXIF "YYYY:MM:DD HH:MM:SS" format into a local-time Date. */
function parseExifDate(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  // A placeholder "0000:00:00 00:00:00" (common in cameras with no clock set)
  // is not a usable capture time.
  if (Number.isNaN(date.getTime()) || Number(y) === 0) return null;
  return date;
}
