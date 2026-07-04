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
  // US-1642: the vision pass's manipulation / screenshot-or-watermark signal.
  // Provenance can't vouch for a tampered image, so a suspected manipulation
  // WITHHOLDS the badge (positive-only — it never lowers a grade).
  manipulationSuspected?: boolean;
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

  // US-1642: the vision pass suspects manipulation or a screenshot/watermark —
  // provenance can't vouch for a tampered image, so deny the badge.
  if (opts.manipulationSuspected) {
    return { ...base, reasons: ["image manipulation suspected"] };
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

// ── Live Capture — fraud-proof grading mode (US-1283) ──────────────────────────
//
// The flagship anti-fraud tier built ON TOP of Verified Capture. A seller may
// opt into the "Live Capture" path: every photo must be captured LIVE in-app
// (device-attested, no library upload) so condition proof cannot be Photoshopped
// or pulled from a stock listing. When the submission is device-attested AND
// passes ALL the standard provenance checks AND shows no manipulation, it earns
// the distinct, STRONGER "Live-Verified" certificate badge.
//
// DESIGN — never a silent pass (AC3): any provenance, attestation, or
// manipulation failure DOWNGRADES the badge. A live-capture submission whose
// provenance still independently qualifies falls back to the standard
// "Verified Capture" badge; otherwise it earns no badge. The downgrade reason is
// always recorded server-side for admin review — the public surface only ever
// sees the earned tier.

// The capture_source value an image must carry to count as device-attested
// (captured live in the in-app camera, not picked from the library).
export const IN_APP_CAPTURE_SOURCE = "in_app_camera";

// The earned certificate badge tier. 'live_verified' is the strongest (un-fakeable
// condition proof); 'verified' is the standard Verified Capture fallback; null =
// no badge.
export type LiveCaptureBadge = "live_verified" | "verified" | null;

export interface LiveCaptureImage {
  image_type: string;
  // How this photo entered the app. Only IN_APP_CAPTURE_SOURCE is device-attested.
  capture_source: string | null;
}

export interface LiveCaptureResult {
  badge: LiveCaptureBadge;
  // True when the seller chose the Live Capture path for this submission.
  live_capture: boolean;
  // True only when EVERY image was captured live in-app (no library upload).
  device_attested: boolean;
  // Human-readable detail for admin review (server-side only).
  reasons: string[];
  checked_at: string;
}

// Stronger confidence boost earned by a Live-Verified submission — bounded and
// always ≥ the standard Verified Capture boost so the strongest provenance tier
// never corroborates LESS than the weaker one.
export function liveCaptureBoost(): number {
  const raw = Number(Deno.env.get("GRADING_LIVE_CAPTURE_CONFIDENCE_BOOST"));
  const v = Number.isFinite(raw) && raw >= 0 && raw <= 0.3 ? raw : 0.1;
  return Math.max(v, verifiedCaptureBoost());
}

/**
 * Evaluate the Live Capture badge for a submission. Pure (clock injected) so it's
 * deterministic + unit-testable. Composes the already-computed Verified Capture
 * result with device-attestation + a manipulation verdict.
 *
 * Outcomes:
 *   - 'live_verified' : opted in, every photo device-attested, provenance
 *                       verified, and no manipulation suspected.
 *   - 'verified'      : a DOWNGRADE — provenance still independently passed, but
 *                       attestation or the manipulation check did not.
 *   - null            : no badge.
 * It NEVER lowers a grade; the only effect is which (if any) badge is earned.
 */
export function evaluateLiveCapture(opts: {
  liveCaptureOptIn: boolean;
  verifiedCapture: VerifiedCaptureResult;
  images: LiveCaptureImage[];
  manipulationSuspected: boolean;
  nowMs: number;
}): LiveCaptureResult {
  const checked_at = new Date(opts.nowMs).toISOString();
  // The strongest badge the standard provenance result alone can support.
  const verifiedFallback: LiveCaptureBadge = opts.verifiedCapture.verified
    ? "verified"
    : null;

  if (!opts.liveCaptureOptIn) {
    return {
      badge: verifiedFallback,
      live_capture: false,
      device_attested: false,
      reasons: ["not opted into Live Capture"],
      checked_at,
    };
  }

  const total = opts.images.length;
  const attested = opts.images.filter(
    (i) => (i.capture_source ?? "").toLowerCase() === IN_APP_CAPTURE_SOURCE,
  ).length;
  const deviceAttested = total > 0 && attested === total;

  // Collect every reason the strongest tier was not earned (never a silent pass).
  const failures: string[] = [];
  if (total === 0) {
    failures.push("no images");
  } else if (!deviceAttested) {
    failures.push(
      `${total - attested} of ${total} photo(s) were not captured live in-app`,
    );
  }
  if (!opts.verifiedCapture.verified) {
    failures.push(
      ...(opts.verifiedCapture.reasons.length
        ? opts.verifiedCapture.reasons
        : ["provenance checks did not pass"]),
    );
  }
  if (opts.manipulationSuspected) {
    failures.push("image manipulation suspected");
  }

  if (
    deviceAttested && opts.verifiedCapture.verified &&
    !opts.manipulationSuspected
  ) {
    return {
      badge: "live_verified",
      live_capture: true,
      device_attested: true,
      reasons: [
        `all ${total} photos captured live in-app, device-attested, provenance verified, no manipulation`,
      ],
      checked_at,
    };
  }

  return {
    badge: verifiedFallback,
    live_capture: true,
    device_attested: deviceAttested,
    reasons: [
      `Live-Verified not earned — ${failures.join("; ")}`,
      ...(verifiedFallback === "verified"
        ? ["downgraded to standard Verified Capture"]
        : []),
    ],
    checked_at,
  };
}
