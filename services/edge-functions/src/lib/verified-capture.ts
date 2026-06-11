// Verified Capture — opt-in provenance booster + badge (US-340).
//
// The PSA-style "control the intake" analog: provenance is a POSITIVE signal, not
// a fraud gate. A seller may OPT IN to verified capture (in-app capture and/or
// original-with-EXIF upload, US-339). When the server-side provenance checks
// below all pass, the submission earns a "Verified Capture" badge and a small
// confidence boost. It is NEVER required, and missing/absent EXIF is NEVER a
// penalty — a submission that doesn't opt in (or has no provenance) grades
// exactly as before.
//
// All checks run server-side so they can't be bypassed from the client:
//   1. Opted in              — the opt-in flag alone grants nothing further.
//   2. Provenance present     — every image carries device (make/model) + a
//                               capture timestamp read from the original file
//                               before compression stripped it.
//   3. Consistent device      — all images share one camera/device (a mix is the
//                               tell of photos assembled from multiple sources).
//   4. Recent capture         — every timestamp is within a window before submit
//                               and not in the future (stale/spoofed clocks fail).
//   5. Unedited               — no image's EXIF software field names a photo
//                               editor (Photoshop/GIMP/etc. — the spoof tell).
//   6. Not reused             — no cross-account photo-reuse match (US-337), the
//                               stolen/recycled-listing signal.

// Editing-software tells. EXIF `software` from a phone's stock camera names the
// OS/firmware (e.g. "iOS 17.1", "HDR+") and is fine; these substrings indicate
// the file passed through an image EDITOR, which both strips the
// straight-from-camera guarantee and is the easiest place to forge metadata.
const EDITOR_SOFTWARE_TELLS = [
  "photoshop",
  "lightroom",
  "gimp",
  "affinity",
  "pixelmator",
  "snapseed",
  "facetune",
  "picsart",
  "canva",
  "paint.net",
  "photoscape",
  "fotor",
  "befunky",
  "inshot",
];

function maxAgeDays(): number {
  const raw = Number(Deno.env.get("GRADING_VERIFIED_CAPTURE_MAX_AGE_DAYS"));
  return Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : 30;
}

// Confidence boost added when verified (capped at 1.0 by the caller). Small and
// bounded — provenance corroborates, it doesn't override the visual grade.
export function verifiedCaptureBoost(): number {
  const raw = Number(Deno.env.get("GRADING_VERIFIED_CAPTURE_CONFIDENCE_BOOST"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 0.2 ? raw : 0.05;
}

export interface VerifiedCaptureImage {
  image_type: string;
  exif: Record<string, unknown> | null;
}

export interface VerifiedCaptureResult {
  verified: boolean;
  // Human-readable detail for admin review (kept server-side; the public
  // certificate exposes only the pass/fail boolean).
  reasons: string[];
  // Normalized device string ("Apple iPhone 14 Pro") when consistent, else null.
  device: string | null;
  // How many of `total` images carried usable provenance EXIF.
  with_exif: number;
  total: number;
  max_age_days: number;
  checked_at: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Parse an EXIF datetime ("YYYY:MM:DD HH:MM:SS", the colon-date EXIF form; also
 * tolerates ISO) into epoch ms, or null if unparseable. Pure + unit-tested.
 */
export function parseExifDate(raw: unknown): number | null {
  const s = str(raw);
  if (!s) return null;
  // EXIF canonical form: "2026:06:11 14:32:10". Convert the date portion's
  // colons to dashes and join with 'T' so Date can parse it as local time.
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

function deviceOf(exif: Record<string, unknown>): string | null {
  const make = str(exif.make);
  const model = str(exif.model);
  if (make && model) {
    // Phones often repeat the make in the model ("Apple" / "iPhone 14"); avoid
    // "Apple Apple ...". Compare case-insensitively.
    return model.toLowerCase().startsWith(make.toLowerCase())
      ? model
      : `${make} ${model}`;
  }
  return make ?? model;
}

function hasEditorTell(exif: Record<string, unknown>): boolean {
  const sw = str(exif.software);
  if (!sw) return false;
  const low = sw.toLowerCase();
  return EDITOR_SOFTWARE_TELLS.some((tell) => low.includes(tell));
}

/**
 * Evaluate whether an opted-in submission earns the Verified Capture badge.
 *
 * Pure (clock injected) so it's deterministic + unit-testable. NEVER penalizes:
 * the only outcomes are "verified" (badge + boost) or "not verified" (unchanged).
 */
export function evaluateVerifiedCapture(opts: {
  optedIn: boolean;
  submittedAtMs: number;
  images: VerifiedCaptureImage[];
  crossUserReuse: boolean;
  nowMs?: number;
}): VerifiedCaptureResult {
  const now = opts.nowMs ?? opts.submittedAtMs;
  const maxAge = maxAgeDays();
  const total = opts.images.length;
  const base: VerifiedCaptureResult = {
    verified: false,
    reasons: [],
    device: null,
    with_exif: 0,
    total,
    max_age_days: maxAge,
    checked_at: new Date(now).toISOString(),
  };

  if (!opts.optedIn) {
    return { ...base, reasons: ["not opted into verified capture"] };
  }
  if (total === 0) {
    return { ...base, reasons: ["no images"] };
  }

  // Anti-gaming: a reused photo from another account can never earn the badge.
  if (opts.crossUserReuse) {
    return {
      ...base,
      reasons: ["one or more photos reused from a different account"],
    };
  }

  const maxAgeMs = maxAge * 24 * 60 * 60 * 1000;
  // Allow a small forward skew for unsynced device clocks; anything clearly in
  // the future is a spoofed/incorrect timestamp.
  const futureSkewMs = 24 * 60 * 60 * 1000;

  const devices = new Set<string>();
  let device: string | null = null;
  let withExif = 0;

  for (const img of opts.images) {
    const exif = img.exif;
    if (!exif || typeof exif !== "object") {
      return {
        ...base,
        with_exif: withExif,
        reasons: [`'${img.image_type}' has no provenance metadata`],
      };
    }
    if (hasEditorTell(exif)) {
      return {
        ...base,
        with_exif: withExif,
        reasons: [`'${img.image_type}' was processed by an image editor`],
      };
    }
    const dev = deviceOf(exif);
    if (!dev) {
      return {
        ...base,
        with_exif: withExif,
        reasons: [`'${img.image_type}' is missing camera/device metadata`],
      };
    }
    const capMs = parseExifDate(exif.dateTimeOriginal) ??
      parseExifDate(exif.dateTime);
    if (capMs === null) {
      return {
        ...base,
        with_exif: withExif,
        reasons: [`'${img.image_type}' is missing a capture timestamp`],
      };
    }
    if (capMs > now + futureSkewMs) {
      return {
        ...base,
        with_exif: withExif,
        reasons: [`'${img.image_type}' has a future capture timestamp`],
      };
    }
    if (now - capMs > maxAgeMs) {
      return {
        ...base,
        with_exif: withExif,
        reasons: [
          `'${img.image_type}' was captured more than ${maxAge} days before submission`,
        ],
      };
    }
    devices.add(dev.toLowerCase());
    device = dev;
    withExif++;
  }

  if (devices.size > 1) {
    return {
      ...base,
      with_exif: withExif,
      reasons: ["photos were captured on more than one device"],
    };
  }

  return {
    ...base,
    verified: true,
    device,
    with_exif: withExif,
    reasons: [
      `all ${total} photos captured on ${device} within ${maxAge} days, unedited, no reuse`,
    ],
  };
}
