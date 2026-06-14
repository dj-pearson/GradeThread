import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// US-901: global admin search / command palette.
//
// Mounted at /api/admin/search — inherits authMiddleware + adminAuthMiddleware
// (admin/super_admin + AAL2 MFA) from the /api/admin/* group in main.ts. This is
// an admin-gated, intentionally CROSS-TENANT read (it spans every tenant's
// records, like admin-users.ts / admin-support-tickets.ts) — the per-tenant
// scoping rule for user-initiated endpoints does not apply; the admin+MFA gate
// is the authorization boundary. Read-only, so no step-up / audit log.
//
// Lookups are exact (UUID/cus_ ids) or prefix/substring on INDEXED columns only
// (email, full_name, submission/ticket title, sku, platform_listing_id,
// certificate_id, primary keys) — see migration 00224_admin_search_indexes.sql
// for the pg_trgm GIN indexes that keep these off full-table scans. Every field
// returned is one an existing admin page already shows (AC#5: no field leakage).

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSearchRoutes = new Hono<AdminEnv>();

// Cap per type so one noisy term can't return thousands of rows or do a wide
// scan; the palette only ever renders a handful per group anyway.
const PER_TYPE = 6;

// A v4-ish UUID — recognises an id/certificate-id paste so we know to probe the
// id columns instead of running text scans.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ResultType =
  | "user"
  | "submission"
  | "certificate"
  | "listing"
  | "sale"
  | "ticket";

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  subtitle: string;
  /** Admin deep link the palette routes to on select. */
  href: string;
  /** Which field matched, for display ("email", "sku", "id", …). */
  matched_on: string;
}

interface SearchGroups {
  users: SearchResult[];
  submissions: SearchResult[];
  certificates: SearchResult[];
  listings: SearchResult[];
  sales: SearchResult[];
  tickets: SearchResult[];
}

// Neutralise the PostgREST filter / ILIKE metacharacters so a search term can't
// break out of the pattern (commas/parens delimit PostgREST filters; %/_ are
// LIKE wildcards). Mirrors admin-users.ts's lookup sanitiser. Exported for tests.
export function sanitize(q: string): string {
  return q.replace(/[%_,()*\\]/g, " ").trim();
}

function userHref(id: string): string {
  return `/admin/users/${id}`;
}

const money = (v: unknown): string =>
  typeof v === "number" ? `$${v.toFixed(2)}` : "";

// GET /?q= — unified ranked lookup across the key entities.
adminSearchRoutes.get("/", async (c: Context<AdminEnv>) => {
  const raw = (c.req.query("q") ?? "").trim();
  if (raw.length < 2) {
    return c.json({ error: "Search term too short" }, 400);
  }

  const groups: SearchGroups = {
    users: [],
    submissions: [],
    certificates: [],
    listings: [],
    sales: [],
    tickets: [],
  };

  const isUuid = UUID_RE.test(raw);
  const isEmail = raw.includes("@");
  const isStripe = raw.startsWith("cus_");
  const s = sanitize(raw);

  if (isUuid) {
    // The paste could be a primary key for any entity (or a certificate_id, which
    // is also a UUID). Probe each id column in parallel; exact-match, all
    // index-backed (PKs + the certificate_id unique index).
    const [
      userRes,
      subRes,
      certRes,
      listingRes,
      saleRes,
      ticketRes,
    ] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("id, email, full_name")
        .eq("id", raw)
        .maybeSingle(),
      supabaseAdmin
        .from("submissions")
        .select("id, title, brand, status, user_id")
        .eq("id", raw)
        .maybeSingle(),
      supabaseAdmin
        .from("grade_reports")
        .select(
          "certificate_id, overall_score, submissions!inner(id, user_id, title)",
        )
        .eq("certificate_id", raw)
        .maybeSingle(),
      supabaseAdmin
        .from("listings")
        .select(
          "id, platform, platform_listing_id, listing_price, inventory_items!inner(user_id, title)",
        )
        .eq("id", raw)
        .maybeSingle(),
      supabaseAdmin
        .from("sales")
        .select(
          "id, sale_price, buyer_username, inventory_items!inner(user_id, title)",
        )
        .eq("id", raw)
        .maybeSingle(),
      supabaseAdmin
        .from("support_tickets")
        .select("id, subject, status, user_id")
        .eq("id", raw)
        .maybeSingle(),
    ]);

    const u = userRes.data as
      | { id: string; email: string; full_name: string | null }
      | null;
    if (u) {
      groups.users.push({
        type: "user",
        id: u.id,
        title: u.full_name || u.email,
        subtitle: u.email,
        href: userHref(u.id),
        matched_on: "id",
      });
    }

    const sub = subRes.data as
      | { id: string; title: string; brand: string | null; status: string; user_id: string }
      | null;
    if (sub) {
      groups.submissions.push({
        type: "submission",
        id: sub.id,
        title: sub.title,
        subtitle: [sub.brand, sub.status].filter(Boolean).join(" · "),
        href: userHref(sub.user_id),
        matched_on: "id",
      });
    }

    const cert = certRes.data as
      | {
          certificate_id: string;
          overall_score: number;
          submissions: { id: string; user_id: string; title: string | null } | null;
        }
      | null;
    if (cert?.submissions) {
      groups.certificates.push({
        type: "certificate",
        id: cert.certificate_id,
        title: cert.submissions.title || "Certificate",
        subtitle: `Grade ${cert.overall_score} · ${cert.certificate_id.slice(0, 8)}`,
        href: userHref(cert.submissions.user_id),
        matched_on: "certificate_id",
      });
    }

    const listing = listingRes.data as
      | {
          id: string;
          platform: string;
          platform_listing_id: string | null;
          listing_price: number | null;
          inventory_items: { user_id: string; title: string | null } | null;
        }
      | null;
    if (listing?.inventory_items) {
      groups.listings.push({
        type: "listing",
        id: listing.id,
        title: listing.inventory_items.title || "Listing",
        subtitle: [listing.platform, money(listing.listing_price)]
          .filter(Boolean)
          .join(" · "),
        href: userHref(listing.inventory_items.user_id),
        matched_on: "id",
      });
    }

    const sale = saleRes.data as
      | {
          id: string;
          sale_price: number | null;
          buyer_username: string | null;
          inventory_items: { user_id: string; title: string | null } | null;
        }
      | null;
    if (sale?.inventory_items) {
      groups.sales.push({
        type: "sale",
        id: sale.id,
        title: sale.inventory_items.title || "Sale",
        subtitle: [money(sale.sale_price), sale.buyer_username]
          .filter(Boolean)
          .join(" · "),
        href: userHref(sale.inventory_items.user_id),
        matched_on: "id",
      });
    }

    const ticket = ticketRes.data as
      | { id: string; subject: string; status: string; user_id: string }
      | null;
    if (ticket) {
      groups.tickets.push({
        type: "ticket",
        id: ticket.id,
        title: ticket.subject,
        subtitle: ticket.status,
        href: `/admin/support-tickets/${ticket.id}`,
        matched_on: "id",
      });
    }
  } else if (isStripe) {
    // Stripe customer id → owning user (indexed unique column).
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name")
      .eq("stripe_customer_id", raw)
      .maybeSingle();
    const u = data as
      | { id: string; email: string; full_name: string | null }
      | null;
    if (u) {
      groups.users.push({
        type: "user",
        id: u.id,
        title: u.full_name || u.email,
        subtitle: u.email,
        href: userHref(u.id),
        matched_on: "stripe_customer_id",
      });
    }
  } else if (s.length >= 2) {
    // Free-text — run every type's text lookup in parallel. Each is a
    // prefix/substring match on a trigram-indexed column.
    const [
      usersRes,
      subsRes,
      listingsByIdRes,
      listingsBySkuRes,
      salesRes,
      ticketsRes,
    ] = await Promise.all([
      isEmail
        ? supabaseAdmin
            .from("users")
            .select("id, email, full_name")
            .ilike("email", `${s}%`)
            .limit(PER_TYPE)
        : supabaseAdmin
            .from("users")
            .select("id, email, full_name")
            .or(`email.ilike.%${s}%,full_name.ilike.%${s}%`)
            .limit(PER_TYPE),
      supabaseAdmin
        .from("submissions")
        .select("id, title, brand, status, user_id")
        .ilike("title", `%${s}%`)
        .limit(PER_TYPE),
      supabaseAdmin
        .from("listings")
        .select(
          "id, platform, platform_listing_id, listing_price, inventory_items!inner(user_id, title)",
        )
        .ilike("platform_listing_id", `${s}%`)
        .limit(PER_TYPE),
      supabaseAdmin
        .from("listings")
        .select(
          "id, platform, platform_listing_id, listing_price, inventory_items!inner(user_id, title, sku)",
        )
        .ilike("inventory_items.sku", `${s}%`)
        .limit(PER_TYPE),
      supabaseAdmin
        .from("sales")
        .select(
          "id, sale_price, buyer_username, inventory_items!inner(user_id, title)",
        )
        .ilike("buyer_username", `%${s}%`)
        .limit(PER_TYPE),
      supabaseAdmin
        .from("support_tickets")
        .select("id, subject, status, user_id")
        .ilike("subject", `%${s}%`)
        .limit(PER_TYPE),
    ]);

    for (const u of (usersRes.data ?? []) as Array<{
      id: string;
      email: string;
      full_name: string | null;
    }>) {
      groups.users.push({
        type: "user",
        id: u.id,
        title: u.full_name || u.email,
        subtitle: u.email,
        href: userHref(u.id),
        matched_on: isEmail ? "email" : "name",
      });
    }

    for (const sub of (subsRes.data ?? []) as Array<{
      id: string;
      title: string;
      brand: string | null;
      status: string;
      user_id: string;
    }>) {
      groups.submissions.push({
        type: "submission",
        id: sub.id,
        title: sub.title,
        subtitle: [sub.brand, sub.status].filter(Boolean).join(" · "),
        href: userHref(sub.user_id),
        matched_on: "title",
      });
    }

    // Merge the two listing lookups (by platform id, by item sku), dedup by id.
    const seenListings = new Set<string>();
    const pushListing = (
      row: {
        id: string;
        platform: string;
        platform_listing_id: string | null;
        listing_price: number | null;
        inventory_items: { user_id: string; title: string | null } | null;
      },
      matchedOn: string,
    ) => {
      if (!row.inventory_items || seenListings.has(row.id)) return;
      seenListings.add(row.id);
      groups.listings.push({
        type: "listing",
        id: row.id,
        title: row.inventory_items.title || "Listing",
        subtitle: [row.platform, money(row.listing_price)]
          .filter(Boolean)
          .join(" · "),
        href: userHref(row.inventory_items.user_id),
        matched_on: matchedOn,
      });
    };
    for (const row of (listingsByIdRes.data ?? []) as unknown as Parameters<typeof pushListing>[0][]) {
      pushListing(row, "platform_listing_id");
    }
    for (const row of (listingsBySkuRes.data ?? []) as unknown as Parameters<typeof pushListing>[0][]) {
      pushListing(row, "sku");
    }
    groups.listings = groups.listings.slice(0, PER_TYPE);

    for (const sale of (salesRes.data ?? []) as unknown as Array<{
      id: string;
      sale_price: number | null;
      buyer_username: string | null;
      inventory_items: { user_id: string; title: string | null } | null;
    }>) {
      if (!sale.inventory_items) continue;
      groups.sales.push({
        type: "sale",
        id: sale.id,
        title: sale.inventory_items.title || "Sale",
        subtitle: [money(sale.sale_price), sale.buyer_username]
          .filter(Boolean)
          .join(" · "),
        href: userHref(sale.inventory_items.user_id),
        matched_on: "buyer",
      });
    }

    for (const ticket of (ticketsRes.data ?? []) as Array<{
      id: string;
      subject: string;
      status: string;
      user_id: string;
    }>) {
      groups.tickets.push({
        type: "ticket",
        id: ticket.id,
        title: ticket.subject,
        subtitle: ticket.status,
        href: `/admin/support-tickets/${ticket.id}`,
        matched_on: "subject",
      });
    }
  }

  const total =
    groups.users.length +
    groups.submissions.length +
    groups.certificates.length +
    groups.listings.length +
    groups.sales.length +
    groups.tickets.length;

  return c.json({ query: raw, total, results: groups });
});
