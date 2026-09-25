// US-1579: MeasureCard fulfillment queue (operator side).
//
// Mounted under /api/admin/measure-cards — the global /api/admin/* stack
// (authMiddleware + adminAuthMiddleware) gates every route here, so only
// super-admins reach the queue. This is where shipping addresses (PII) ARE
// visible: the operator lists pending requests, exports a CSV for the
// print/mail vendor, and bulk-marks exported → shipped. Marking shipped also
// stamps each seller's profile card-version record ('mail' outranks
// 'download' — US-1579 AC4).

import { Hono } from "hono";
import { writeAuditLog } from "../lib/audit-log.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { decryptMeasureCardAddress } from "../lib/measure-card-pii.ts";

export const adminMeasureCardRoutes = new Hono();

// US-1560 RBAC: the fulfillment queue is an operations surface (PII export +
// status transitions) — ops:write across the router.
adminMeasureCardRoutes.use("*", requireScope("ops:write"));

interface RequestRow {
  id: string;
  owner_user_id: string;
  status: string;
  card_version: number;
  plan_key: string | null;
  ship_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  tracking_number: string | null;
  tracking_carrier: string | null;
  requested_at: string;
  exported_at: string | null;
  shipped_at: string | null;
  // MC-04: set when the street columns could not be decrypted. The row stays
  // visible in the queue (so the operator can see it exists) but never reaches
  // the vendor CSV, where a blank address would print as a blank label.
  address_unreadable?: boolean;
}

const STATUSES = new Set(["requested", "exported", "shipped"]);

async function listRequests(status: string): Promise<RequestRow[]> {
  const { data, error } = await supabaseAdmin
    .from("measure_card_requests")
    .select(
      "id, owner_user_id, status, card_version, plan_key, ship_name, address_line1, address_line2, city, state, postal_code, country, tracking_number, tracking_carrier, requested_at, exported_at, shipped_at",
    )
    .eq("status", status)
    .order("requested_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);

  // US-2417 AC2: the street columns come back as ciphertext. Decrypt with the
  // ROW's owner_user_id as the AAD, never a caller-supplied one — that binding
  // is what makes a ciphertext moved between tenants fail instead of silently
  // rendering one seller's address under another seller's name.
  //
  // Per row, not per batch: one un-backfilled or unreadable row must not take
  // out the operator's whole fulfilment queue. A row that cannot be decrypted
  // is surfaced with its address blanked and its id logged, because a blank
  // that says so beats a plausible-looking wrong address on a mailing label.
  const rows = (data ?? []) as RequestRow[];
  const out: RequestRow[] = [];
  for (const row of rows) {
    try {
      out.push(await decryptMeasureCardAddress(row.owner_user_id, row));
    } catch (err) {
      console.error(`[admin-measure-cards] undecryptable address on ${row.id}:`, err);
      out.push({
        ...row,
        ship_name: "",
        address_line1: "",
        address_line2: null,
        city: "",
        postal_code: "",
        address_unreadable: true,
      });
    }
  }
  return out;
}

/**
 * One CSV cell: quote + escape. Pure, exported for tests.
 *
 * MC-03: a cell starting with = + - @ TAB or CR is read as a formula by Excel
 * and Sheets even inside quotes, so a ship_name of =HYPERLINK(...) would run
 * when the operator opened the vendor file. The OWASP rule is a leading single
 * quote. Done HERE, at export, because rows stored before the seller route
 * started refusing such values are still in the table.
 */
export function csvCell(v: string | number | null): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The vendor CSV — one row per request, address fields split out. */
export function requestsToCsv(rows: RequestRow[]): string {
  const header = [
    "request_id",
    "ship_name",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "postal_code",
    "country",
    "card_version",
    "plan",
    "requested_at",
  ].join(",");
  // MC-04: an undecryptable row has a blanked address; leave it out.
  const lines = rows.filter((r) => !r.address_unreadable).map((r) =>
    [
      csvCell(r.id),
      csvCell(r.ship_name),
      csvCell(r.address_line1),
      csvCell(r.address_line2),
      csvCell(r.city),
      csvCell(r.state),
      csvCell(r.postal_code),
      csvCell(r.country),
      csvCell(r.card_version),
      csvCell(r.plan_key),
      csvCell(r.requested_at),
    ].join(",")
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

// List the queue (default: awaiting export).
adminMeasureCardRoutes.get("/requests", async (c) => {
  const status = c.req.query("status") ?? "requested";
  if (!STATUSES.has(status)) return c.json({ error: "Unknown status" }, 400);
  try {
    const requests = await listRequests(status);
    return c.json({
      requests,
      unreadable_count: requests.filter((r) => r.address_unreadable).length,
    });
  } catch (err) {
    console.error("[admin-measure-cards] list failed:", err);
    return c.json({ error: "Could not load the queue." }, 500);
  }
});

// Vendor CSV download.
adminMeasureCardRoutes.get("/requests.csv", async (c) => {
  const status = c.req.query("status") ?? "requested";
  if (!STATUSES.has(status)) return c.json({ error: "Unknown status" }, 400);
  try {
    const rows = await listRequests(status);
    return c.body(requestsToCsv(rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="measure-card-${status}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  } catch (err) {
    console.error("[admin-measure-cards] csv failed:", err);
    return c.json({ error: "Could not export the queue." }, 500);
  }
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_MAX_IDS = 500;

/**
 * MC-04: the statuses a row may move FROM to reach `next`. The bulk update is
 * filtered on these, so a shipped row can never be sent back to 'exported'
 * (which would reopen it in the queue, or trip the one-active-request unique
 * index and fail the whole batch with 23505). Pure, exported for tests.
 */
export function predecessorStatuses(
  next: "exported" | "shipped",
): Array<"requested" | "exported"> {
  return next === "exported" ? ["requested"] : ["requested", "exported"];
}

/** MC-04: validate a bulk body's ids. Refuses rather than slicing. */
export function parseBulkIds(
  raw: unknown,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "ids is required" };
  }
  if (raw.length > BULK_MAX_IDS) {
    return {
      ok: false,
      error: `At most ${BULK_MAX_IDS} ids per request; send the rest separately.`,
    };
  }
  if (!raw.every((x) => typeof x === "string" && UUID_RE.test(x))) {
    return { ok: false, error: "Every id must be a request UUID." };
  }
  return { ok: true, ids: [...new Set(raw as string[])] };
}

// Bulk status transition: requested -> exported -> shipped. Shipping stamps
// each seller's profile record (mail outranks download).
adminMeasureCardRoutes.post("/requests/bulk", async (c) => {
  let body: { ids?: unknown; status?: unknown; tracking_number?: unknown; tracking_carrier?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseBulkIds(body.ids);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const ids = parsed.ids;
  const status = typeof body.status === "string" ? body.status : "";
  if (status !== "exported" && status !== "shipped") {
    return c.json({ error: "status must be 'exported' or 'shipped'" }, 400);
  }

  const patch: Record<string, unknown> = { status };
  if (status === "exported") patch.exported_at = new Date().toISOString();
  if (status === "shipped") patch.shipped_at = new Date().toISOString();

  // US-2231: tracking is OPTIONAL and only meaningful on the shipped
  // transition. Cards go out by hand and many are untracked letters, so an
  // absent value must stay absent rather than becoming an empty string the
  // seller's page would then render as a broken link.
  //
  // Applied to the whole batch on purpose: the operator marks one parcel
  // shipped at a time when it has a number, and marks a batch shipped when it
  // does not. Sending a number with 200 ids would stamp one number on 200
  // sellers — so the route REFUSES that rather than trusting the caller.
  const tracking = typeof body.tracking_number === "string"
    ? body.tracking_number.trim().slice(0, 64)
    : "";
  const carrier = typeof body.tracking_carrier === "string"
    ? body.tracking_carrier.trim().slice(0, 32)
    : "";
  if (tracking && status !== "shipped") {
    return c.json({ error: "Tracking can only be set when marking a card shipped." }, 400);
  }
  if (tracking && ids.length !== 1) {
    return c.json({
      error: "One tracking number cannot cover several cards — mark them shipped one at a time.",
    }, 400);
  }
  if (tracking) {
    patch.tracking_number = tracking;
    if (carrier) patch.tracking_carrier = carrier;
  }

  const { data: updated, error } = await supabaseAdmin
    .from("measure_card_requests")
    .update(patch as never)
    .in("id", ids)
    .in("status", predecessorStatuses(status))
    .select("id, owner_user_id, card_version");
  if (error) return c.json({ error: "Bulk update failed." }, 500);

  const rows = (updated ?? []) as Array<{
    id: string;
    owner_user_id: string;
    card_version: number;
  }>;
  const movedIds = new Set(rows.map((r) => r.id));
  const skipped = ids.filter((id) => !movedIds.has(id));

  // A mailed card is the authoritative profile record. One UPDATE per card
  // version rather than one per row, and only owners whose stamp actually
  // landed go in the audit row.
  const stamped: string[] = [];
  let stampFailed = false;
  if (status === "shipped") {
    const byVersion = new Map<number, Set<string>>();
    for (const r of rows) {
      const set = byVersion.get(r.card_version) ?? new Set<string>();
      set.add(r.owner_user_id);
      byVersion.set(r.card_version, set);
    }
    for (const [version, owners] of byVersion) {
      const { data: done, error: stampErr } = await supabaseAdmin
        .from("users")
        .update({
          measure_card_version: version,
          measure_card_source: "mail",
        } as never)
        .in("id", [...owners])
        .select("id");
      if (stampErr) {
        stampFailed = true;
        console.error(
          `[admin-measure-cards] profile stamp failed for card v${version}:`,
          stampErr.message,
        );
        continue;
      }
      for (const u of (done ?? []) as Array<{ id: string }>) stamped.push(u.id);
    }
  }
  // US-2355: a bulk operator action over SHARED records (up to 500 ids), which
  // also writes each seller's profile card-version when marking shipped — so it
  // changes rows the operator does not own, and did so with no trace of who ran
  // it. The affected ids go in the row, not just the count: "42 requests were
  // marked shipped" cannot be reconciled against a vendor's mailing list, and
  // "these 42" can.
  await writeAuditLog(c, {
    action: `measure_card.requests.bulk_${status}`,
    targetType: "measure_card_request",
    targetId: null,
    after: { status, updated: rows.length, skipped: skipped.length },
    details: {
      request_ids: rows.map((r) => r.id),
      // Marking shipped also stamps users.measure_card_version / _source.
      profiles_stamped: stamped,
      skipped_ids: skipped,
    },
  });
  return c.json({
    ok: true,
    updated: rows.length,
    skipped,
    ...(stampFailed ? { profile_stamp_failed: true } : {}),
  });
});
