import type { ImageExifMetadata } from "@/types/database";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MIN_RESOLUTION = 1200;

export interface ImageValidationError {
  field: string;
  message: string;
}

export interface ImageValidationResult {
  valid: boolean;
  errors: ImageValidationError[];
  width?: number;
  height?: number;
}

/**
 * Convert a base64 `data:` image URI back into a File (US-952). Used to re-stage
 * a Snap-to-Value photo into the certified-grade upload flow so it can be
 * re-validated + compressed through the standard path. Returns null for a
 * non-image or malformed data URI.
 */
export function dataUriToFile(dataUri: string, filename: string): File | null {
  const match = dataUri.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1] ?? "image/jpeg";
  const b64 = match[2] ?? "";
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  } catch {
    return null;
  }
}

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image. The file may be corrupted."));
    };
    img.src = url;
  });
}

function getExifOrientation(file: File): Promise<number> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const view = new DataView(e.target?.result as ArrayBuffer);

      // Check for JPEG SOI marker
      if (view.getUint16(0, false) !== 0xffd8) {
        resolve(1);
        return;
      }

      let offset = 2;
      while (offset < view.byteLength) {
        if (offset + 2 > view.byteLength) break;
        const marker = view.getUint16(offset, false);

        // APP1 marker (EXIF)
        if (marker === 0xffe1) {
          // Check for "Exif\0\0" header
          if (offset + 10 > view.byteLength) break;
          if (view.getUint32(offset + 4, false) !== 0x45786966) {
            resolve(1);
            return;
          }

          const tiffOffset = offset + 10;
          if (tiffOffset + 2 > view.byteLength) break;
          const littleEndian = view.getUint16(tiffOffset, false) === 0x4949;

          if (tiffOffset + 8 > view.byteLength) break;
          const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian);
          const ifdStart = tiffOffset + ifdOffset;

          if (ifdStart + 2 > view.byteLength) break;
          const entries = view.getUint16(ifdStart, littleEndian);

          for (let i = 0; i < entries; i++) {
            const entryOffset = ifdStart + 2 + i * 12;
            if (entryOffset + 12 > view.byteLength) break;

            // Tag 0x0112 is Orientation
            if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
              resolve(view.getUint16(entryOffset + 8, littleEndian));
              return;
            }
          }

          // Searched through all IFD entries, no orientation found
          resolve(1);
          return;
        }

        // Skip other markers
        if (offset + 2 > view.byteLength) break;
        if ((marker & 0xff00) !== 0xff00) break;
        if (offset + 4 > view.byteLength) break;
        offset += 2 + view.getUint16(offset + 2, false);
      }

      resolve(1);
    };
    reader.onerror = () => resolve(1);
    // Read only the first 64KB for EXIF data
    reader.readAsArrayBuffer(file.slice(0, 65536));
  });
}

// ── EXIF / provenance extraction (US-339) ───────────────────────────────────
//
// Read camera/provenance EXIF from the ORIGINAL file BEFORE compression. Our
// canvas re-encode (compressImage) strips EXIF and forensic signal, so this is
// the only chance to capture it. Pure in-browser TIFF/IFD walk (no decoder, no
// dependency) — mirrors the manual parser in getExifOrientation. Best-effort:
// any malformed/absent EXIF resolves to null and never blocks an upload. GPS,
// when present, is privacy-sensitive — it is submitted only as structured
// metadata for access-controlled forensic use, never rendered to buyers.

export type ExifMetadata = ImageExifMetadata;

// Parse the TIFF block of a JPEG APP1/EXIF segment starting at byte `tiff`.
function parseExifTiff(view: DataView, tiff: number): ExifMetadata | null {
  if (tiff + 8 > view.byteLength) return null;
  const le = view.getUint16(tiff, false) === 0x4949; // "II" = little-endian
  if (view.getUint16(tiff + 2, le) !== 0x002a) return null; // TIFF magic
  const ifd0 = tiff + view.getUint32(tiff + 4, le);

  const meta: ExifMetadata = {};
  let exifIfdPtr = 0;
  let gpsIfdPtr = 0;

  const readAscii = (entry: number): string => {
    const count = view.getUint32(entry + 4, le);
    let valOff = entry + 8;
    if (count > 4) valOff = tiff + view.getUint32(entry + 8, le);
    let s = "";
    for (let i = 0; i < count; i++) {
      if (valOff + i >= view.byteLength) break;
      const ch = view.getUint8(valOff + i);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s.trim();
  };

  const walkIfd = (
    ifdStart: number,
    handler: (tag: number, entry: number) => void
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
      case 0x0112:
        meta.orientation = view.getUint16(entry + 8, le);
        break;
      case 0x8769:
        exifIfdPtr = tiff + view.getUint32(entry + 8, le);
        break;
      case 0x8825:
        gpsIfdPtr = tiff + view.getUint32(entry + 8, le);
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

  if (gpsIfdPtr) {
    // Mutated inside the IFD walk — held in an object so TS keeps the declared
    // (possibly-null) types instead of over-narrowing from the initializers.
    const g = {
      latRef: "",
      lonRef: "",
      lat: null as number | null,
      lon: null as number | null,
    };
    const readCoord = (entry: number): number | null => {
      const count = view.getUint32(entry + 4, le);
      if (count < 3) return null;
      const off = tiff + view.getUint32(entry + 8, le); // 3 rationals > 4 bytes
      if (off + 24 > view.byteLength) return null;
      const rat = (o: number) => {
        const den = view.getUint32(o + 4, le);
        return den === 0 ? 0 : view.getUint32(o, le) / den;
      };
      return rat(off) + rat(off + 8) / 60 + rat(off + 16) / 3600;
    };
    walkIfd(gpsIfdPtr, (tag, entry) => {
      switch (tag) {
        case 0x0001:
          g.latRef = readAscii(entry);
          break;
        case 0x0002:
          g.lat = readCoord(entry);
          break;
        case 0x0003:
          g.lonRef = readAscii(entry);
          break;
        case 0x0004:
          g.lon = readCoord(entry);
          break;
      }
    });
    if (g.lat !== null && g.lon !== null) {
      const latitude = g.latRef.toUpperCase() === "S" ? -g.lat : g.lat;
      const longitude = g.lonRef.toUpperCase() === "W" ? -g.lon : g.lon;
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        meta.gps = { latitude, longitude };
      }
    }
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

function readExifFromJpeg(view: DataView): ExifMetadata | null {
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    if (marker === 0xffe1) {
      // APP1 — confirm the "Exif" header, then the TIFF block starts 6 bytes in
      // ("Exif\0\0" after the 2-byte marker + 2-byte length = offset + 10).
      if (offset + 10 > view.byteLength) return null;
      if (view.getUint32(offset + 4, false) !== 0x45786966) return null;
      return parseExifTiff(view, offset + 10);
    }
    if ((marker & 0xff00) !== 0xff00) break;
    if (offset + 4 > view.byteLength) break;
    offset += 2 + view.getUint16(offset + 2, false);
  }
  return null;
}

/**
 * Read provenance EXIF (camera make/model, capture time, GPS) from the original
 * file before any compression. Resolves to null for non-JPEG inputs or when no
 * EXIF is present — both are normal and never an error. Reads only the first
 * 128 KB (an EXIF APP1 segment is capped at 64 KB).
 */
export function extractExif(file: File): Promise<ExifMetadata | null> {
  return new Promise((resolve) => {
    // EXIF rides in the JPEG APP1 segment; phones shoot JPEG (or HEIC, which we
    // don't accept). PNG/WebP rarely carry camera EXIF — skip them cheaply.
    if (file.type !== "image/jpeg") {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        resolve(readExifFromJpeg(new DataView(e.target?.result as ArrayBuffer)));
      } catch {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 131072));
  });
}

export async function validateImage(
  file: File
): Promise<ImageValidationResult> {
  const errors: ImageValidationError[] = [];

  // Check file type
  if (
    !ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])
  ) {
    errors.push({
      field: "type",
      message: `Invalid file type "${file.type}". Please upload a JPEG, PNG, or WebP image.`,
    });
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    errors.push({
      field: "size",
      message: `File size (${sizeMB}MB) exceeds the 10MB limit. Please upload a smaller image.`,
    });
  }

  // Check resolution (only if type is valid so we can load it)
  if (errors.length === 0) {
    try {
      const img = await loadImage(file);
      const width = img.naturalWidth;
      const height = img.naturalHeight;

      if (width < MIN_RESOLUTION || height < MIN_RESOLUTION) {
        errors.push({
          field: "resolution",
          message: `Image resolution (${width}x${height}) is too low. Minimum required is ${MIN_RESOLUTION}x${MIN_RESOLUTION} pixels.`,
        });
      }

      return { valid: errors.length === 0, errors, width, height };
    } catch {
      errors.push({
        field: "file",
        message: "Failed to load image. The file may be corrupted.",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface CompressResult {
  blob: Blob;
  width: number;
  height: number;
  // 64-bit difference-hash (dHash) as 16 hex chars, computed from the
  // orientation-corrected pixels. Used server-side (US-337) to detect the same
  // photo being reused across submissions/sellers (stolen/recycled listings).
  // Empty string if hashing failed (never blocks the upload).
  phash: string;
}

/**
 * Compute a 64-bit difference hash (dHash) from an already-rendered canvas.
 * Downscales to 9x8 grayscale and emits one bit per horizontal neighbor
 * comparison (8 per row x 8 rows = 64 bits), returned as 16 hex chars. dHash is
 * robust to the resize/recompression our upload pipeline applies, so the same
 * photo hashes to a near-identical value even after processing. Returns "" on
 * any failure so it can never break an upload.
 */
function computeDHash(source: CanvasImageSource): string {
  try {
    const W = 9;
    const H = 8;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const cx = c.getContext("2d");
    if (!cx) return "";
    cx.drawImage(source, 0, 0, W, H);
    const { data } = cx.getImageData(0, 0, W, H);

    let bits = "";
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        const j = (y * W + x + 1) * 4;
        const left =
          0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
        const right =
          0.299 * (data[j] ?? 0) + 0.587 * (data[j + 1] ?? 0) + 0.114 * (data[j + 2] ?? 0);
        bits += left > right ? "1" : "0";
      }
    }
    return BigInt("0b" + bits).toString(16).padStart(16, "0");
  } catch {
    return "";
  }
}

export async function compressImage(
  file: File,
  maxWidth = 2400,
  quality = 0.85
): Promise<CompressResult> {
  const img = await loadImage(file);
  const orientation = await getExifOrientation(file);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create canvas context.");
  }

  let { naturalWidth: width, naturalHeight: height } = img;

  // Apply EXIF orientation: swap dimensions for rotated orientations
  const needsSwap = orientation >= 5 && orientation <= 8;
  if (needsSwap) {
    [width, height] = [height, width];
  }

  // Scale down if wider than maxWidth
  if (width > maxWidth) {
    const ratio = maxWidth / width;
    width = maxWidth;
    height = Math.round(height * ratio);
  }

  canvas.width = width;
  canvas.height = height;

  // Apply EXIF orientation transform
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, height, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, height, width);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, width);
      break;
  }

  // Draw with correct dimensions for the orientation
  if (needsSwap) {
    ctx.drawImage(img, 0, 0, height, width);
  } else {
    ctx.drawImage(img, 0, 0, width, height);
  }

  // Convert to blob — prefer WebP, fall back to JPEG
  const outputType =
    file.type === "image/png" ? "image/png" : "image/webp";
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("Failed to compress image."));
      },
      outputType,
      quality
    );
  });

  // Hash the orientation-corrected canvas (matches the pixels we actually
  // store) so reuse detection is stable across orientation/resize.
  const phash = computeDHash(canvas);

  return { blob, width: canvas.width, height: canvas.height, phash };
}
