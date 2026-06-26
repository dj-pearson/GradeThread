// One-off operator script: build an idempotent SQL seed that mirrors a curated
// slice of a REAL reseller account into the Apple App Review DEMO account so the
// reviewer has believable inventory / listings / sales / certificates to look at.
//
// Input  : the six CSVs exported from prod into ./export/ (see header detection).
// Output : scripts/seed-demo-account.sql  (run via psql "$SUPABASE_DB_URL" -f ...
//          or paste into the Supabase Studio SQL editor).
//
// It does NOT touch the database itself — it only emits SQL. Nothing here needs
// prod credentials; the generated SQL is what the operator applies.
//
// What it does:
//   * Parses the export CSVs (RFC-4180, tolerant of embedded newlines / quotes).
//   * Curates ~12-15 inventory items (graded heroes + sold items for the Money
//     tab + photo-bearing items across pipeline stages).
//   * Deterministically remaps every UUID (uuid v5) so re-runs are stable and so
//     mirrored rows never collide with the real rows' unique keys
//     (certificate_id is UNIQUE; certificate_number is nulled to be safe).
//   * Re-points user_id -> demo user and every FK to the remapped ids.
//   * Emits a transaction that first deletes the demo user's existing demo rows
//     (FK-safe order) then inserts the fresh set, plus an UPDATE that unlocks the
//     FlipDesk UI for the demo user (onboarded + pro trial).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = join(ROOT, "export");
const OUT_SQL = join(ROOT, "scripts", "seed-demo-account.sql");

const DEMO_USER = "d54d2cc8-aa82-4a95-ad3b-e899d7a83454";
const SOURCE_USER = "c55c2414-7e0b-4431-944e-c0a16887bf31";
const MAX_ITEMS = 14;

// ── deterministic UUID v5 (RFC 4122) ────────────────────────────────────────
// Fixed namespace so the same source id always maps to the same demo id.
const NS = "6f9619ff-8b86-d011-b42d-00c04fc964ff"; // arbitrary constant namespace
function uuidv5(name) {
  const nsBytes = Buffer.from(NS.replace(/-/g, ""), "hex");
  const h = createHash("sha1");
  h.update(nsBytes);
  h.update(Buffer.from(String(name), "utf8"));
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// Namespaced remaps keep different tables from colliding even if ids overlap.
const remap = {
  item: (id) => uuidv5(`item:${id}`),
  photo: (id) => uuidv5(`photo:${id}`),
  listing: (id) => uuidv5(`listing:${id}`),
  sale: (id) => uuidv5(`sale:${id}`),
  submission: (id) => uuidv5(`submission:${id}`),
  report: (id) => uuidv5(`report:${id}`),
  cert: (id) => uuidv5(`cert:${id}`),
  source: (name) => uuidv5(`source:${name}`),
};

// ── RFC-4180 CSV parser (handles quoted fields w/ embedded commas/newlines) ──
function parseCsv(text) {
  // strip a leading UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // trailing field/row (file may not end in newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => {
      const o = {};
      header.forEach((h, idx) => (o[h] = r[idx]));
      return o;
    });
}

// Supabase Studio CSV export writes SQL NULL as the bare token `null` and empty
// strings as an empty field. Treat both as NULL.
function val(v) {
  if (v === undefined || v === null) return null;
  if (v === "" || v === "null") return null;
  return v;
}

function loadByHeader(signatureCol) {
  const files = readdirSync(EXPORT_DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
  for (const f of files) {
    const text = readFileSync(join(EXPORT_DIR, f), "utf8");
    const firstLine = text.slice(0, text.indexOf("\n"));
    const cols = firstLine.replace(/\r$/, "").split(",");
    if (cols[0] === signatureCol.first && cols.includes(signatureCol.has)) {
      return parseCsv(text);
    }
  }
  throw new Error(`No export CSV matched signature ${JSON.stringify(signatureCol)}`);
}

// Identify each file by a UNIQUE header column (filenames are generic). Note
// inventory AND submissions both carry garment_type/garment_category, so those
// two are pinned by columns only one of them has.
const inventory = loadByHeader({ first: "id", has: "acquired_price" }); // 167 (unique col)
const photos = loadByHeader({ first: "id", has: "photo_url" }); // 168
const listings = loadByHeader({ first: "id", has: "listing_price" }); // 169
const sales = loadByHeader({ first: "id", has: "sale_price" }); // 170
const reports = loadByHeader({ first: "id", has: "overall_score" }); // 172
// submissions: pinned by exact header prefix (no single unique column vs inventory)
const submissionsRows = loadByHeaderExact([
  "id", "user_id", "garment_type", "garment_category", "brand", "title", "description", "status",
]); // 171

function loadByHeaderExact(prefixCols) {
  const files = readdirSync(EXPORT_DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
  for (const f of files) {
    const text = readFileSync(join(EXPORT_DIR, f), "utf8");
    const firstLine = text.slice(0, text.indexOf("\n")).replace(/\r$/, "");
    const cols = firstLine.split(",");
    if (prefixCols.every((c, i) => cols[i] === c)) return parseCsv(text);
  }
  throw new Error("exact header not found: " + prefixCols.join(","));
}

// ── indexes ─────────────────────────────────────────────────────────────────
const photosByItem = new Map();
for (const p of photos) {
  const k = p.inventory_item_id;
  if (!photosByItem.has(k)) photosByItem.set(k, []);
  photosByItem.get(k).push(p);
}
const listingsByItem = new Map();
for (const l of listings) {
  const k = l.inventory_item_id;
  if (!listingsByItem.has(k)) listingsByItem.set(k, []);
  listingsByItem.get(k).push(l);
}
const salesByItem = new Map();
for (const s of sales) {
  const k = s.inventory_item_id;
  if (!salesByItem.has(k)) salesByItem.set(k, []);
  salesByItem.get(k).push(s);
}
const reportBySubmission = new Map(reports.map((r) => [r.submission_id, r]));
const submissionById = new Map(submissionsRows.map((s) => [s.id, s]));
const invById = new Map(inventory.map((i) => [i.id, i]));

// ── curation ────────────────────────────────────────────────────────────────
const chosen = new Map(); // id -> inventory row
function pick(item, reason) {
  if (!item) return;
  if (!chosen.has(item.id)) chosen.set(item.id, item);
}

// 0. Always include the two listings the operator explicitly selected.
const SELECTED_IDS = [
  "dc0c30ed-9548-4f32-987f-6e4dc1e55f14", // Vuori joggers
  "62c0018a-7c1f-4b3c-8dc6-c6a3ce529746", // ME+EM shirt
];
for (const id of SELECTED_IDS) pick(invById.get(id), "operator-selected");

// 1. graded heroes: inventory items linked to a grade_report (via submission_id)
const gradedSubmissionIds = new Set(reports.map((r) => r.submission_id));
for (const i of inventory) {
  if (val(i.submission_id) && gradedSubmissionIds.has(i.submission_id)) pick(i, "graded");
  else if (val(i.grade_report_id)) pick(i, "graded-cached");
}
// also: any inventory whose submission_id matches a graded submission's TITLE link
// (some graded reports point at a submission not directly linked on the item row)
for (const r of reports) {
  const sub = submissionById.get(r.submission_id);
  if (!sub) continue;
  // link by identical title+brand if no direct item link picked yet
  const match = inventory.find(
    (i) => i.title === sub.title && (val(i.brand) || "") === (val(sub.brand) || ""),
  );
  if (match) pick(match, "graded-by-title");
}

// 2. sold items for the Money tab (prefer ones with photos)
const soldItems = inventory
  .filter((i) => salesByItem.has(i.id))
  .sort((a, b) => {
    const ap = photosByItem.has(a.id) ? 1 : 0;
    const bp = photosByItem.has(b.id) ? 1 : 0;
    return bp - ap;
  });
for (const i of soldItems.slice(0, 4)) pick(i, "sold");

// 3. fill the pipeline with photo-bearing items, maximizing status variety
const seenStatus = new Set([...chosen.values()].map((i) => i.status));
const withPhotos = inventory
  .filter((i) => photosByItem.has(i.id) && !chosen.has(i.id))
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
// first pass: new statuses
for (const i of withPhotos) {
  if (chosen.size >= MAX_ITEMS) break;
  if (!seenStatus.has(i.status)) {
    pick(i, "variety");
    seenStatus.add(i.status);
  }
}
// second pass: top up to MAX_ITEMS
for (const i of withPhotos) {
  if (chosen.size >= MAX_ITEMS) break;
  pick(i, "fill");
}

const chosenItems = [...chosen.values()];

// ── demo sources (2) assigned round-robin ───────────────────────────────────
const demoSources = [
  {
    id: remap.source("Goodwill Outlet Bins"),
    name: "Goodwill Outlet Bins — June",
    source_type: "thrift",
    location: "Des Moines, IA",
    notes: "Weekly bins run. Pay-by-the-pound sourcing.",
  },
  {
    id: remap.source("Westwood Estate Sale"),
    name: "Westwood Estate Sale",
    source_type: "estate_sale",
    location: "West Des Moines, IA",
    notes: "Higher-end designer pieces from a single-owner estate.",
  },
];

// ── SQL emit helpers ────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/'/g, "''");
}
function lit(v) {
  v = val(v);
  if (v === null) return "NULL";
  return `'${esc(v)}'`;
}
function jlit(v) {
  v = val(v);
  if (v === null) return "NULL";
  // value is already JSON text from the export
  return `'${esc(v)}'::jsonb`;
}
function row(values) {
  return `(${values.join(", ")})`;
}

// Build a fast lookup: for a chosen item, its remapped certificate (if graded)
const newCertByItem = new Map(); // itemId -> { certId, certNumber:null, reportId }
for (const i of chosenItems) {
  let report = null;
  if (val(i.submission_id) && reportBySubmission.has(i.submission_id)) {
    report = reportBySubmission.get(i.submission_id);
  } else {
    const sub = submissionById.get(i.submission_id);
    if (sub) report = reportBySubmission.get(sub.id);
  }
  if (!report) {
    // try title match
    const r = reports.find((rr) => {
      const sub = submissionById.get(rr.submission_id);
      return sub && sub.title === i.title;
    });
    if (r) report = r;
  }
  // Only attach a certificate when we can ALSO insert its backing submission
  // (grade_reports.submission_id is NOT NULL + FK). Otherwise skip the cert; the
  // item still shows, just without a certificate link.
  if (report && val(report.certificate_id) && submissionById.has(report.submission_id)) {
    newCertByItem.set(i.id, {
      reportId: report.id,
      newReportId: remap.report(report.id),
      oldCertId: report.certificate_id,
      newCertId: remap.cert(report.certificate_id),
    });
  }
}

// collect submissions + reports actually needed (referenced by chosen items)
const neededSubmissionIds = new Set();
const neededReports = [];
for (const i of chosenItems) {
  const cert = newCertByItem.get(i.id);
  if (cert) {
    const report = reports.find((r) => r.id === cert.reportId);
    if (report) {
      neededReports.push(report);
      neededSubmissionIds.add(report.submission_id);
    }
  }
  if (val(i.submission_id) && submissionById.has(i.submission_id)) {
    neededSubmissionIds.add(i.submission_id);
  }
}

// ── compose the SQL ─────────────────────────────────────────────────────────
const out = [];
out.push("-- ============================================================");
out.push("-- GradeThread — Apple App Review DEMO account seed");
out.push(`-- Demo user: ${DEMO_USER}`);
out.push(`-- Mirrored (curated) from real account: ${SOURCE_USER}`);
out.push("-- Generated by scripts/seed-demo-from-export.mjs — DO NOT hand-edit;");
out.push("-- re-run the generator instead. Idempotent: safe to run repeatedly.");
out.push(`-- Items: ${chosenItems.length} | sources: ${demoSources.length} | certificates: ${neededReports.length}`);
out.push("-- ============================================================");
out.push("");
out.push("BEGIN;");
out.push("");
out.push("-- 1) Clean any previous demo rows (scoped to the demo user only).");
out.push(`DELETE FROM public.inventory_items WHERE user_id = '${DEMO_USER}';  -- cascades listings, sales, item_photos`);
out.push(`DELETE FROM public.submissions    WHERE user_id = '${DEMO_USER}';  -- cascades grade_reports`);
out.push(`DELETE FROM public.sources        WHERE user_id = '${DEMO_USER}';`);
out.push("");

// 2) sources
out.push("-- 2) Sources");
out.push("INSERT INTO public.sources (id, user_id, name, source_type, location, notes) VALUES");
out.push(
  demoSources
    .map((s) => row([lit(s.id), lit(DEMO_USER), lit(s.name), lit(s.source_type), lit(s.location), lit(s.notes)]))
    .join(",\n") + ";",
);
out.push("");

// 3) submissions (needed for certificates + item links)
const subRows = [...neededSubmissionIds]
  .map((id) => submissionById.get(id))
  .filter(Boolean);
if (subRows.length) {
  out.push("-- 3) Submissions (back the certificates / graded items)");
  out.push(
    "INSERT INTO public.submissions (id, user_id, garment_type, garment_category, brand, title, description, status, payment_status, created_at) VALUES",
  );
  out.push(
    subRows
      .map((s) =>
        row([
          lit(remap.submission(s.id)),
          lit(DEMO_USER),
          lit(s.garment_type),
          lit(s.garment_category),
          lit(s.brand),
          lit(s.title),
          lit(s.description),
          lit(s.status === "failed" ? "completed" : s.status),
          lit(val(s.payment_status) || "included"),
          lit(s.created_at),
        ]),
      )
      .join(",\n") + ";",
  );
  out.push("");
}

// 4) grade_reports
if (neededReports.length) {
  out.push("-- 4) Grade reports (certificates). Integrity fields nulled (mirror); cert_number nulled to avoid UNIQUE clash.");
  out.push(
    "INSERT INTO public.grade_reports (id, submission_id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, ai_summary, detailed_notes, confidence_score, model_version, certificate_id, created_at, needs_human_review, human_reviewed, defects_found, detected_style_attributes, buyer_writeup) VALUES",
  );
  out.push(
    neededReports
      .map((r) =>
        row([
          lit(remap.report(r.id)),
          lit(remap.submission(r.submission_id)),
          lit(r.overall_score),
          lit(r.grade_tier),
          lit(r.fabric_condition_score),
          lit(r.structural_integrity_score),
          lit(r.cosmetic_appearance_score),
          lit(r.functional_elements_score),
          lit(r.odor_cleanliness_score),
          lit(r.ai_summary),
          jlit(r.detailed_notes),
          lit(r.confidence_score),
          lit(r.model_version),
          lit(remap.cert(r.certificate_id)),
          lit(r.created_at),
          "false",
          "false",
          jlit(val(r.defects_found) || "[]"),
          jlit(val(r.detected_style_attributes) || "[]"),
          lit(r.buyer_writeup),
        ]),
      )
      .join(",\n") + ";",
  );
  out.push("");
}

// 5) inventory_items
out.push("-- 5) Inventory items");
out.push(
  "INSERT INTO public.inventory_items (id, user_id, title, brand, garment_type, garment_category, size, color, acquired_price, acquired_date, acquired_source, condition_notes, status, submission_id, grade_report_id, sku, item_category, source_id, target_price, location_bin, measurements, material, grade_value, grade_label, certificate_url, container, style, description, comp_set, ebay_category_id, ebay_aspects, created_at) VALUES",
);
out.push(
  chosenItems
    .map((i, idx) => {
      const cert = newCertByItem.get(i.id);
      const certUrl = cert ? `https://gradethread.com/cert/${cert.newCertId}` : null;
      const src = demoSources[idx % demoSources.length];
      const hasSub = val(i.submission_id) && neededSubmissionIds.has(i.submission_id);
      return row([
        lit(remap.item(i.id)),
        lit(DEMO_USER),
        lit(i.title),
        lit(i.brand),
        lit(i.garment_type),
        lit(i.garment_category),
        lit(i.size),
        lit(i.color),
        lit(i.acquired_price),
        lit(i.acquired_date),
        lit(val(i.acquired_source) || src.name),
        lit(i.condition_notes),
        lit(i.status),
        hasSub ? lit(remap.submission(i.submission_id)) : cert ? lit(remap.submission(reports.find((r) => r.id === cert.reportId).submission_id)) : "NULL",
        cert ? lit(cert.newReportId) : "NULL",
        lit(i.sku),
        lit(i.item_category),
        lit(src.id),
        lit(i.target_price),
        lit(i.location_bin),
        jlit(i.measurements),
        lit(i.material),
        lit(i.grade_value),
        lit(i.grade_label),
        lit(certUrl),
        lit(i.container),
        lit(i.style),
        lit(i.description),
        jlit(val(i.comp_set) || "[]"),
        lit(i.ebay_category_id),
        jlit(i.ebay_aspects),
        lit(i.created_at),
      ]);
    })
    .join(",\n") + ";",
);
out.push("");

// 6) item_photos
// Some export rows have a null photo_url but a valid storage_path (e.g. tag_2
// shots). item-photos is a PUBLIC bucket, so derive the public URL from the
// path. Compute the prefix from a row that has both, with a safe fallback.
let PHOTO_URL_PREFIX = "https://api.gradethread.com/storage/v1/object/public/item-photos/";
for (const p of photos) {
  if (val(p.photo_url) && val(p.storage_path) && p.photo_url.endsWith(p.storage_path)) {
    PHOTO_URL_PREFIX = p.photo_url.slice(0, p.photo_url.length - p.storage_path.length);
    break;
  }
}
function photoUrl(p) {
  if (val(p.photo_url)) return p.photo_url;
  if (val(p.storage_path)) return PHOTO_URL_PREFIX + p.storage_path;
  return null; // unusable — skip
}

const PHOTOS_PER_ITEM = 10; // keep the seed lean; one item had 21
const photoRows = [];
let skippedNoUrl = 0;
for (const i of chosenItems) {
  const ps = (photosByItem.get(i.id) || [])
    .slice()
    .sort((a, b) => Number(val(a.sort_order) || 0) - Number(val(b.sort_order) || 0))
    .slice(0, PHOTOS_PER_ITEM);
  for (const p of ps) {
    if (!photoUrl(p)) {
      skippedNoUrl++;
      continue;
    }
    photoRows.push(p);
  }
}
if (photoRows.length) {
  out.push("-- 6) Item photos (point at the real public item-photos URLs — render in demo)");
  out.push(
    "INSERT INTO public.item_photos (id, inventory_item_id, photo_url, storage_path, photo_type, sort_order, used_for_grading, ebay_uploaded, thumbnail_url, width, height, created_at) VALUES",
  );
  out.push(
    photoRows
      .map((p) =>
        row([
          lit(remap.photo(p.id)),
          lit(remap.item(p.inventory_item_id)),
          lit(photoUrl(p)),
          lit(p.storage_path),
          lit(val(p.photo_type) || "detail"),
          lit(val(p.sort_order) || "0"),
          val(p.used_for_grading) === "true" ? "true" : "false",
          val(p.ebay_uploaded) === "true" ? "true" : "false",
          lit(p.thumbnail_url),
          lit(p.width),
          lit(p.height),
          lit(p.created_at),
        ]),
      )
      .join(",\n") + ";",
  );
  out.push("");
}

// 7) listings — one (best) listing per chosen item
const STATUS_RANK = { active: 5, draft: 4, sold: 3, relisted: 2, ended: 1 };
const listingRows = [];
const chosenPhotoIds = new Set(photoRows.map((p) => p.id));
for (const i of chosenItems) {
  const ls = (listingsByItem.get(i.id) || []).slice().sort((a, b) => {
    const r = (STATUS_RANK[b.listing_status] || 0) - (STATUS_RANK[a.listing_status] || 0);
    if (r) return r;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  if (ls[0]) listingRows.push(ls[0]);
}
if (listingRows.length) {
  out.push("-- 7) Listings (one per item; primary_photo_id remapped when present)");
  out.push(
    "INSERT INTO public.listings (id, inventory_item_id, user_id, platform, platform_listing_id, listing_url, listing_price, listed_at, is_active, listing_title, listing_description, listing_status, watchers, views, primary_photo_id, badge_enabled, quantity, best_offer_enabled, ebay_condition, listing_origin, created_at) VALUES",
  );
  out.push(
    listingRows
      .map((l) => {
        const cert = newCertByItem.get(l.inventory_item_id);
        let desc = val(l.listing_description);
        if (desc && cert && cert.oldCertId) {
          desc = desc.split(cert.oldCertId).join(cert.newCertId);
        }
        const primaryPhoto =
          val(l.primary_photo_id) && chosenPhotoIds.has(l.primary_photo_id)
            ? lit(remap.photo(l.primary_photo_id))
            : "NULL";
        return row([
          lit(remap.listing(l.id)),
          lit(remap.item(l.inventory_item_id)),
          lit(DEMO_USER),
          lit(val(l.platform) || "ebay"),
          lit(l.platform_listing_id),
          lit(l.listing_url),
          lit(l.listing_price),
          lit(l.listed_at),
          val(l.is_active) === "false" ? "false" : "true",
          lit(l.listing_title),
          desc === null ? "NULL" : `'${esc(desc)}'`,
          lit(val(l.listing_status) || "draft"),
          lit(val(l.watchers) || "0"),
          lit(val(l.views) || "0"),
          primaryPhoto,
          val(l.badge_enabled) === "true" ? "true" : "false",
          lit(val(l.quantity) || "1"),
          val(l.best_offer_enabled) === "true" ? "true" : "false",
          lit(l.ebay_condition),
          lit("gradethread"), // listing_origin enum; source_of_truth jsonb left to its '{}' default
          lit(l.created_at),
        ]);
      })
      .join(",\n") + ";",
  );
  out.push("");
}

// 8) sales — for chosen items that have them
const saleRows = [];
const chosenListingIds = new Set(listingRows.map((l) => l.id));
for (const i of chosenItems) {
  const ss = salesByItem.get(i.id) || [];
  for (const s of ss) saleRows.push(s);
}
if (saleRows.length) {
  out.push("-- 8) Sales (Money / reconciliation tab)");
  out.push(
    "INSERT INTO public.sales (id, inventory_item_id, listing_id, user_id, sale_price, platform_fees, sale_date, buyer_username, shipping_collected, payment_processing_fees, shipping_cost, grading_cost, other_costs, sold_at, shipped_at, tracking_number, net_profit, tax, payout_amount, created_at) VALUES",
  );
  out.push(
    saleRows
      .map((s) => {
        const listingRef =
          val(s.listing_id) && chosenListingIds.has(s.listing_id)
            ? lit(remap.listing(s.listing_id))
            : "NULL";
        return row([
          lit(remap.sale(s.id)),
          lit(remap.item(s.inventory_item_id)),
          listingRef,
          lit(DEMO_USER),
          lit(s.sale_price),
          lit(val(s.platform_fees) || "0"),
          lit(s.sale_date),
          // anonymize: never ship real third-party eBay buyer handles into the demo
          val(s.buyer_username)
            ? lit("buyer_" + createHash("sha1").update(s.buyer_username).digest("hex").slice(0, 6))
            : "NULL",
          lit(val(s.shipping_collected) || "0"),
          lit(val(s.payment_processing_fees) || "0"),
          lit(val(s.shipping_cost) || "0"),
          lit(val(s.grading_cost) || "0"),
          lit(val(s.other_costs) || "0"),
          lit(s.sold_at),
          lit(s.shipped_at),
          lit(s.tracking_number),
          lit(s.net_profit),
          lit(val(s.tax) || "0"),
          lit(s.payout_amount),
          lit(s.created_at),
        ]);
      })
      .join(",\n") + ";",
  );
  out.push("");
}

// 9) unlock the FlipDesk UI for the demo user
out.push("-- 9) Unlock FlipDesk for the demo user (skip onboarding/upsell gates).");
out.push("UPDATE public.users SET");
out.push("  flipdesk_onboarded = true,");
out.push("  dismissed_flipdesk_promo = true,");
out.push("  flipdesk_plan = 'pro',");
out.push("  subscription_status = 'trialing',");
out.push("  trial_ends_at = now() + interval '90 days'");
out.push(`WHERE id = '${DEMO_USER}';`);
out.push("");
out.push("COMMIT;");
out.push("");

// ── self-validation: no dangling FK references in the emitted set ────────────
const errors = [];
const emittedItemIds = new Set(chosenItems.map((i) => remap.item(i.id)));
const emittedSubIds = new Set(subRows.map((s) => remap.submission(s.id)));
const emittedReportIds = new Set(neededReports.map((r) => remap.report(r.id)));
const emittedPhotoIds = new Set(photoRows.map((p) => remap.photo(p.id)));
const emittedListingIds = new Set(listingRows.map((l) => remap.listing(l.id)));

for (const i of chosenItems) {
  const cert = newCertByItem.get(i.id);
  // grade_report_id reference
  if (cert && !emittedReportIds.has(cert.newReportId)) errors.push(`item ${i.id}: grade_report_id not emitted`);
  // submission_id reference (whichever path the emitter takes)
  let subRef = null;
  if (val(i.submission_id) && neededSubmissionIds.has(i.submission_id)) subRef = remap.submission(i.submission_id);
  else if (cert) subRef = remap.submission(reports.find((r) => r.id === cert.reportId).submission_id);
  if (subRef && !emittedSubIds.has(subRef)) errors.push(`item ${i.id}: submission_id ${subRef} not emitted`);
}
for (const r of neededReports) {
  if (!emittedSubIds.has(remap.submission(r.submission_id))) errors.push(`report ${r.id}: submission_id not emitted`);
}
for (const p of photoRows) {
  if (!emittedItemIds.has(remap.item(p.inventory_item_id))) errors.push(`photo ${p.id}: inventory_item_id orphan`);
}
for (const l of listingRows) {
  if (!emittedItemIds.has(remap.item(l.inventory_item_id))) errors.push(`listing ${l.id}: inventory_item_id orphan`);
  if (val(l.primary_photo_id) && chosenPhotoIds.has(l.primary_photo_id) && !emittedPhotoIds.has(remap.photo(l.primary_photo_id)))
    errors.push(`listing ${l.id}: primary_photo_id orphan`);
}
for (const s of saleRows) {
  if (!emittedItemIds.has(remap.item(s.inventory_item_id))) errors.push(`sale ${s.id}: inventory_item_id orphan`);
  if (val(s.listing_id) && chosenListingIds.has(s.listing_id) && !emittedListingIds.has(remap.listing(s.listing_id)))
    errors.push(`sale ${s.id}: listing_id orphan`);
}
// uniqueness: ids and certs
const allEmitted = [...emittedItemIds, ...emittedSubIds, ...emittedReportIds, ...emittedPhotoIds, ...emittedListingIds];
if (new Set(allEmitted).size !== allEmitted.length) errors.push("duplicate remapped id collision across tables");

if (errors.length) {
  console.error("VALIDATION FAILED — not writing SQL:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

writeFileSync(OUT_SQL, out.join("\n"), "utf8");

// ── console summary ─────────────────────────────────────────────────────────
const statusCounts = {};
for (const i of chosenItems) statusCounts[i.status] = (statusCounts[i.status] || 0) + 1;
console.log(`Wrote ${OUT_SQL}`);
console.log(`  inventory items : ${chosenItems.length}`);
console.log(`  item photos     : ${photoRows.length}`);
console.log(`  listings        : ${listingRows.length}`);
console.log(`  sales           : ${saleRows.length}`);
console.log(`  submissions     : ${subRows.length}`);
console.log(`  certificates    : ${neededReports.length}`);
console.log(`  status spread   : ${JSON.stringify(statusCounts)}`);
console.log(`  parsed rows     : inv=${inventory.length} photos=${photos.length} listings=${listings.length} sales=${sales.length} subs=${submissionsRows.length} reports=${reports.length}`);
