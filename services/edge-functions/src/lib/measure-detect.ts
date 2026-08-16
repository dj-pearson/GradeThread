// US-1572: MeasureCard fiducial detection + plane calibration (PURE math).
//
// Detects the four ArUco markers of a GradeThread MeasureCard in a photo and
// fits the homography that maps image pixels onto the card's inch-coordinate
// plane — the ground truth every measurement (auto or manual) is computed
// from. Pure TS on a grayscale buffer: no OpenCV/WASM dependency in the edge
// container. That's viable because this is NOT a general ArUco detector — it
// is tuned to OUR card: huge (>=40px) K-only-black markers on matte white,
// exactly four known ids (lib/measure-card.ts), quiet zones guaranteed by the
// print spec. CI validates its outputs against real OpenCV detections on
// generated fixtures (src/tests/fixtures/measure-card/, produced by
// scripts/generate-measure-fixtures.py) so the two implementations can't
// drift silently.
//
// Injectable + deterministic: callers pass {width, height, gray} — the route
// decodes the photo (ImageScript) and the tests decode fixture PNGs.

import {
  cardVersionForIds,
  type MeasureCardGeometry,
} from "./measure-card.ts";

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major grayscale, 0..255, length = width*height. */
  gray: Uint8Array;
}

export interface DetectedMarker {
  id: number;
  /** Quad corners in image px, clockwise from the marker's own top-left. */
  corners: Array<[number, number]>;
  /** Homography-refined center in image px. */
  center: [number, number];
  /** Shorter side length in px (drives the too-small quality gate). */
  sidePx: number;
}

export interface CalibrationQuality {
  markersFound: number;
  minMarkerSidePx: number;
  /** Variance of a 3x3 Laplacian over the image — low = blurry. */
  blurScore: number;
  /** RMS reprojection residual of the 16 marker corners, in INCHES. */
  reprojResidualIn: number;
}

export type CalibrateFailure =
  | "card_not_found"
  | "card_not_fully_visible"
  | "markers_too_small"
  | "photo_too_blurry"
  | "card_bent_or_angled";

export const CALIBRATE_REMEDIATION: Record<CalibrateFailure, string> = {
  card_not_found:
    "We couldn't find the MeasureCard. Lay it flat beside the garment with all four squares visible and reshoot.",
  card_not_fully_visible:
    "Part of the MeasureCard is cut off or covered. Keep all four squares fully in frame and unobstructed.",
  // US-2632: the old wording was "move the camera closer", which is advice a
  // seller measuring a pair of pants CANNOT take — moving closer crops the
  // garment the card is there to measure. On a big garment the constraint is
  // the photo's resolution, not the photographer's distance.
  markers_too_small:
    "The MeasureCard's squares are too few pixels to read. On a large garment, shoot at your camera's full resolution rather than moving closer — moving closer crops the garment. Re-uploading the photo at full size usually fixes it.",
  photo_too_blurry:
    "This photo is too blurry to measure from. Hold steady (or prop the phone) and reshoot.",
  card_bent_or_angled:
    "The card looks bent or the shot is too angled. Flatten the card and shoot as top-down as you can.",
};

export interface CalibrateSuccess {
  ok: true;
  cardVersion: number;
  /** Pixels per inch at the card plane (mean over the four rect edges). */
  ppi: number;
  /** Row-major 3x3 homography mapping image px -> card-plane INCHES. */
  homography: number[];
  markers: DetectedMarker[];
  quality: CalibrationQuality;
}

export interface CalibrateError {
  ok: false;
  reason: CalibrateFailure;
  message: string;
  quality: CalibrationQuality;
}

export type CalibrateResult = CalibrateSuccess | CalibrateError;

// Quality thresholds (exported for tests/UI copy).
export const MIN_MARKER_SIDE_PX = 40;
export const MIN_BLUR_SCORE = 60; // Laplacian variance; tuned on fixtures
export const MAX_REPROJ_RESIDUAL_IN = 0.06;

// ── Small linear algebra ────────────────────────────────────────────

/** Solve A x = b (n x n) via Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / m[i][i]);
}

/**
 * Least-squares homography (h33 = 1) from point correspondences
 * (src px -> dst units). Needs >= 4 points; uses normal equations over the
 * standard DLT linearization.
 */
export function fitHomography(
  src: Array<[number, number]>,
  dst: Array<[number, number]>,
): number[] | null {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  // Normalize source points for conditioning (mean 0, avg dist sqrt2).
  let mx = 0, my = 0;
  for (const [x, y] of src) { mx += x; my += y; }
  mx /= n; my /= n;
  let md = 0;
  for (const [x, y] of src) md += Math.hypot(x - mx, y - my);
  md /= n;
  const s = md > 1e-9 ? Math.SQRT2 / md : 1;
  const norm = (p: [number, number]): [number, number] => [
    (p[0] - mx) * s,
    (p[1] - my) * s,
  ];

  // Build normal equations for the 8 unknowns.
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb: number[] = new Array(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = norm(src[k]);
    const [u, v] = dst[k];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  // De-normalize: H = Hn * T where T maps original -> normalized coords.
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const T = [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  return matMul3(Hn, T);
}

export function matMul3(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    }
  }
  return o;
}

export function applyHomography(
  h: number[],
  x: number,
  y: number,
): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

// ── Binarization ────────────────────────────────────────────────────

/**
 * Adaptive mean threshold via integral image: black where the pixel is
 * meaningfully darker than its neighborhood. Window scales with image size so
 * a full marker never out-sizes its window.
 */
function binarize(img: GrayImage): Uint8Array {
  const { width: w, height: h, gray } = img;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const win = Math.max(15, (Math.min(w, h) / 8) | 0) | 1;
  const half = win >> 1;
  const C = 8;
  const out = new Uint8Array(w * h); // 1 = black (candidate ink)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
        integral[y0 * (w + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (w + 1) + x0] +
        integral[y0 * (w + 1) + x0];
      out[y * w + x] = gray[y * w + x] < sum / area - C ? 1 : 0;
    }
  }
  return out;
}

// ── Connected components → quad candidates ─────────────────────────

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  label: number;
}

function labelComponents(
  bin: Uint8Array,
  w: number,
  h: number,
): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (bin[i] !== 1 || labels[i] !== 0) continue;
    next += 1;
    const comp: Component = {
      minX: w, minY: h, maxX: 0, maxY: 0, area: 0, label: next,
    };
    stack.length = 0;
    stack.push(i);
    labels[i] = next;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % w, py = (p / w) | 0;
      comp.area++;
      if (px < comp.minX) comp.minX = px;
      if (px > comp.maxX) comp.maxX = px;
      if (py < comp.minY) comp.minY = py;
      if (py > comp.maxY) comp.maxY = py;
      // 4-connectivity is enough for solid marker blobs.
      if (px > 0 && bin[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = next; stack.push(p - 1); }
      if (px < w - 1 && bin[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = next; stack.push(p + 1); }
      if (py > 0 && bin[p - w] === 1 && labels[p - w] === 0) { labels[p - w] = next; stack.push(p - w); }
      if (py < h - 1 && bin[p + w] === 1 && labels[p + w] === 0) { labels[p + w] = next; stack.push(p + w); }
    }
    comps.push(comp);
  }
  return { labels, comps };
}

/** Convex hull (monotone chain) of a point set. */
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 3) return p;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * Best-fitting quad from a hull: seed with the two farthest hull points, then
 * greedily add the two points maximizing quad area. Exact enough for solid,
 * near-square marker blobs.
 */
function hullToQuad(hull: Array<[number, number]>): Array<[number, number]> | null {
  if (hull.length < 4) return null;
  let ai = 0, bi = 0, best = -1;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = (hull[i][0] - hull[j][0]) ** 2 + (hull[i][1] - hull[j][1]) ** 2;
      if (d > best) { best = d; ai = i; bi = j; }
    }
  }
  const triArea = (a: number[], b: number[], c: number[]) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  let ci = -1; best = -1;
  for (let i = 0; i < hull.length; i++) {
    if (i === ai || i === bi) continue;
    const ar = triArea(hull[ai], hull[bi], hull[i]);
    if (ar > best) { best = ar; ci = i; }
  }
  if (ci < 0) return null;
  let di = -1; best = -1;
  for (let i = 0; i < hull.length; i++) {
    if (i === ai || i === bi || i === ci) continue;
    const ar = triArea(hull[ai], hull[bi], hull[i]) +
      triArea(hull[ai], hull[ci], hull[i]) +
      triArea(hull[bi], hull[ci], hull[i]);
    if (ar > best) { best = ar; di = i; }
  }
  if (di < 0) return null;
  const quad = [hull[ai], hull[bi], hull[ci], hull[di]];
  // Order clockwise around the centroid, starting top-left-most.
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  quad.sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)
  );
  let start = 0, bestKey = Infinity;
  for (let i = 0; i < 4; i++) {
    const key = quad[i][0] + quad[i][1];
    if (key < bestKey) { bestKey = key; start = i; }
  }
  return [0, 1, 2, 3].map((i) => quad[(start + i) % 4]);
}

// ── Marker decoding ─────────────────────────────────────────────────

const CANON = 70; // canonical unwarp size: 7 modules x 10px

/** Sample the quad into a 7x7 module grid and read border + inner bits. */
function decodeQuad(
  img: GrayImage,
  quad: Array<[number, number]>,
): { border: number; bits: number[][] } | null {
  const dst: Array<[number, number]> = [[0, 0], [CANON, 0], [CANON, CANON], [0, CANON]];
  const H = fitHomography(dst, quad); // canonical -> image
  if (!H) return null;
  const { width: w, height: h, gray } = img;
  const mod = CANON / 7;
  // Otsu-ish split from the quad's own samples: use mean of sampled values.
  const samples: number[][] = [];
  let sum = 0, count = 0;
  for (let r = 0; r < 7; r++) {
    samples.push([]);
    for (let c = 0; c < 7; c++) {
      // average a 3x3 tap at the module center
      let acc = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const [ix, iy] = applyHomography(
            H,
            (c + 0.5) * mod + dx * 2,
            (r + 0.5) * mod + dy * 2,
          );
          const xi = Math.round(ix), yi = Math.round(iy);
          if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
          acc += gray[yi * w + xi];
          n++;
        }
      }
      if (n === 0) return null;
      const v = acc / n;
      samples[r].push(v);
      sum += v; count++;
    }
  }
  const thresh = sum / count;
  let borderBlack = 0;
  const bits: number[][] = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const black = samples[r][c] < thresh;
      const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
      if (isBorder && black) borderBlack++;
    }
  }
  for (let r = 1; r <= 5; r++) {
    const row: number[] = [];
    for (let c = 1; c <= 5; c++) row.push(samples[r][c] < thresh ? 0 : 1);
    bits.push(row);
  }
  return { border: borderBlack / 24, bits };
}

function rotateBits(b: number[][]): number[][] {
  const n = b.length;
  return Array.from(
    { length: n },
    (_, r) => Array.from({ length: n }, (_, c) => b[n - 1 - c][r]),
  );
}

function bitsEqual(a: number[][], b: number[][]): boolean {
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

/** Match decoded bits against a card's ids across all four rotations. */
function matchId(
  bits: number[][],
  candidates: Array<{ id: number; rotations: number[][][] }>,
): number | null {
  for (const cand of candidates) {
    for (const rot of cand.rotations) {
      if (bitsEqual(bits, rot)) return cand.id;
    }
  }
  return null;
}

// ── Blur metric ─────────────────────────────────────────────────────

export function laplacianVariance(img: GrayImage): number {
  const { width: w, height: h, gray } = img;
  let sum = 0, sumSq = 0, n = 0;
  const step = Math.max(1, ((w * h) / 250_000) | 0); // sample big images
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1 + (y % step); x < w - 1; x += step) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ── Public API ──────────────────────────────────────────────────────

/** Detect this card-version's markers (any of the known versions). */
export function detectMarkers(
  img: GrayImage,
  cards: MeasureCardGeometry[],
): DetectedMarker[] {
  const bin = binarize(img);
  const { labels, comps } = labelComponents(bin, img.width, img.height);
  const minArea = 20 * 20;
  const maxArea = (img.width * img.height) / 4;
  const candidates = cards.flatMap((card) =>
    card.markerIds.map((id) => {
      const b0 = card.markerBits[String(id)];
      const b1 = rotateBits(b0), b2 = rotateBits(b1), b3 = rotateBits(b2);
      return { id, rotations: [b0, b1, b2, b3] };
    })
  );
  const found: DetectedMarker[] = [];
  const usedIds = new Set<number>();
  // Largest-first so a marker beats any stray blob with the same bits.
  comps.sort((a, b) => b.area - a.area);
  for (const comp of comps) {
    const bw = comp.maxX - comp.minX + 1;
    const bh = comp.maxY - comp.minY + 1;
    if (comp.area < minArea || comp.area > maxArea) continue;
    const aspect = bw / bh;
    if (aspect < 0.4 || aspect > 2.5) continue;
    if (comp.area / (bw * bh) < 0.35) continue; // solid-ish blobs only
    // Collect boundary points of this component (cheap: all component pixels
    // on the bbox-scan that have a non-component 4-neighbor).
    const pts: Array<[number, number]> = [];
    for (let y = comp.minY; y <= comp.maxY; y++) {
      for (let x = comp.minX; x <= comp.maxX; x++) {
        if (labels[y * img.width + x] !== comp.label) continue;
        const i = y * img.width + x;
        if (
          x === 0 || x === img.width - 1 || y === 0 || y === img.height - 1 ||
          labels[i - 1] !== comp.label || labels[i + 1] !== comp.label ||
          labels[i - img.width] !== comp.label ||
          labels[i + img.width] !== comp.label
        ) pts.push([x, y]);
      }
    }
    if (pts.length < 4) continue;
    const quad = hullToQuad(convexHull(pts));
    if (!quad) continue;
    const decoded = decodeQuad(img, quad);
    if (!decoded || decoded.border < 0.85) continue;
    const id = matchId(decoded.bits, candidates);
    if (id == null || usedIds.has(id)) continue;
    usedIds.add(id);
    // Refined center: canonical center through the quad homography.
    const Hc = fitHomography(
      [[0, 0], [CANON, 0], [CANON, CANON], [0, CANON]],
      quad,
    );
    const center = Hc ? applyHomography(Hc, CANON / 2, CANON / 2) : [
      quad.reduce((s, p) => s + p[0], 0) / 4,
      quad.reduce((s, p) => s + p[1], 0) / 4,
    ] as [number, number];
    const side = Math.min(
      Math.hypot(quad[0][0] - quad[1][0], quad[0][1] - quad[1][1]),
      Math.hypot(quad[1][0] - quad[2][0], quad[1][1] - quad[2][1]),
    );
    found.push({ id, corners: quad, center, sidePx: side });
  }
  return found;
}

/**
 * Full calibration: detect the card, identify its version, fit the
 * image-px -> inch homography over the 16 marker corners, gate on quality.
 */
export function calibrateMeasurePhoto(
  img: GrayImage,
  cards: MeasureCardGeometry[],
): CalibrateResult {
  const markers = detectMarkers(img, cards);
  const blurScore = laplacianVariance(img);
  const baseQuality: CalibrationQuality = {
    markersFound: markers.length,
    minMarkerSidePx: markers.length
      ? Math.min(...markers.map((m) => m.sidePx))
      : 0,
    blurScore,
    reprojResidualIn: Infinity,
  };
  const fail = (reason: CalibrateFailure): CalibrateError => ({
    ok: false,
    reason,
    message: CALIBRATE_REMEDIATION[reason],
    quality: baseQuality,
  });

  if (markers.length === 0) {
    return fail(blurScore < MIN_BLUR_SCORE ? "photo_too_blurry" : "card_not_found");
  }
  const card = cardVersionForIds(markers.map((m) => m.id));
  if (!card) return fail("card_not_fully_visible");
  if (baseQuality.minMarkerSidePx < MIN_MARKER_SIDE_PX) {
    return fail("markers_too_small");
  }
  if (blurScore < MIN_BLUR_SCORE) return fail("photo_too_blurry");

  // Correspondences: each marker's 4 corners at their known inch positions
  // (markers are axis-aligned squares on the card). A detected quad's corner
  // ORDER may be rotated vs the card's, so fit on the four CENTERS first
  // (exact), then assign each detected corner to its nearest predicted inch
  // corner — robust for near-planar shots.
  const half = card.markerSizeInches / 2;
  const centerH = fitHomography(
    markers.map((m) => m.center),
    markers.map((m) => card.markerCentersInches[String(m.id)] as [number, number]),
  );
  if (!centerH) return fail("card_not_found");
  const src2: Array<[number, number]> = [];
  const dst2: Array<[number, number]> = [];
  for (const m of markers) {
    const [cx, cy] = card.markerCentersInches[String(m.id)];
    const cornersIn: Array<[number, number]> = [
      [cx - half, cy - half],
      [cx + half, cy - half],
      [cx + half, cy + half],
      [cx - half, cy + half],
    ];
    for (const c of m.corners) {
      const p = applyHomography(centerH, c[0], c[1]);
      let best = 0, bd = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = (p[0] - cornersIn[i][0]) ** 2 + (p[1] - cornersIn[i][1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      src2.push(c);
      dst2.push(cornersIn[best]);
    }
  }
  const H = fitHomography(src2, dst2) ?? centerH;

  // Quality: RMS residual over the corner correspondences, in inches.
  let rss = 0;
  for (let i = 0; i < src2.length; i++) {
    const p = applyHomography(H, src2[i][0], src2[i][1]);
    rss += (p[0] - dst2[i][0]) ** 2 + (p[1] - dst2[i][1]) ** 2;
  }
  const reprojResidualIn = Math.sqrt(rss / src2.length);
  const quality: CalibrationQuality = { ...baseQuality, reprojResidualIn };
  if (reprojResidualIn > MAX_REPROJ_RESIDUAL_IN) {
    return {
      ok: false,
      reason: "card_bent_or_angled",
      message: CALIBRATE_REMEDIATION.card_bent_or_angled,
      quality,
    };
  }

  // ppi: px distance between adjacent marker centers / inch distance.
  const byId = new Map(markers.map((m) => [m.id, m] as const));
  const edges: Array<[number, number, number]> = [];
  const ids = card.markerIds;
  const pairs: Array<[number, number]> = [
    [ids[0], ids[1]],
    [ids[1], ids[2]],
    [ids[2], ids[3]],
    [ids[3], ids[0]],
  ];
  for (const [a, b] of pairs) {
    const ma = byId.get(a), mb = byId.get(b);
    if (!ma || !mb) continue;
    const pxDist = Math.hypot(
      ma.center[0] - mb.center[0],
      ma.center[1] - mb.center[1],
    );
    const [ax, ay] = card.markerCentersInches[String(a)];
    const [bx, by] = card.markerCentersInches[String(b)];
    edges.push([pxDist, Math.hypot(ax - bx, ay - by), pxDist / Math.hypot(ax - bx, ay - by)]);
  }
  const ppi = edges.reduce((s, e) => s + e[2], 0) / edges.length;

  return { ok: true, cardVersion: card.version, ppi, homography: H, markers, quality };
}
