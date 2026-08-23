import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Upload,
  Link2,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Loader2,
  RotateCcw,
  Trash2,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useItemsList } from "@/hooks/use-items-full";
import { useWorkspace } from "@/hooks/use-workspace";
import { parseEbayListingsCsv, normalizeSku } from "@/lib/ebay-csv";
import { reconcile, autoMatch } from "@/lib/ebay-reconcile";
import type { EbayListingRow, EbayListingInsert, EbayMatchStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

const UPSERT_CHUNK = 200;

// US-465 AC1: when an orphan eBay listing is linked to an EXISTING FlipDesk
// item, mirror the live listing into the `listings` table so the item carries
// its eBay URL + platform_listing_id — not just a match_status flag on the
// orphan. Idempotent: updates the item's existing ebay listings row for this
// listing id if present, otherwise inserts one. (createItemFromListing already
// does this for the new-item path.)
async function upsertEbayListingRowForItem(
  itemId: string,
  listing: EbayListingRow,
): Promise<void> {
  const row: Record<string, unknown> = {
    inventory_item_id: itemId,
    platform: "ebay",
    // US-1077: matching an imported live eBay listing → eBay-originated.
    listing_origin: "ebay",
    platform_listing_id: listing.ebay_item_id,
    listing_url: listing.listing_url,
    listing_price: listing.current_price ?? 0,
    listing_title: listing.title,
    listing_status: "active",
    is_active: true,
  };
  const { data: existing, error: selErr } = await supabase
    .from("listings")
    .select("id")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .eq("platform_listing_id", listing.ebay_item_id)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (existing) {
    const { error } = await supabase
      .from("listings")
      .update(row as never)
      .eq("id", (existing as { id: string }).id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from("listings")
      .insert({ ...row, listed_at: new Date().toISOString() } as never);
    if (error) throw new Error(error.message);
  }
}

function useEbayListings() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_listings", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<EbayListingRow[]> => {
      const { data, error } = await supabase
        .from("flipdesk_ebay_listings")
        .select("*")
        .order("imported_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as EbayListingRow[];
    },
  });
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "muted";
}) {
  const valueClass =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-destructive"
        : "";
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

export function EbaySkuMatch() {
  const user = useAuthStore((s) => s.user);
  const confirm = useConfirm();
  const { workspaceOwnerId } = useWorkspace();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [linkTarget, setLinkTarget] = useState<EbayListingRow | null>(null);
  const [createTarget, setCreateTarget] = useState<EbayListingRow | null>(
    null,
  );
  const [bulkCreating, setBulkCreating] = useState(false);
  const [quickLinkBusyId, setQuickLinkBusyId] = useState<string | null>(null);

  const { data: listings = [], isLoading: listingsLoading } = useEbayListings();
  const { data: items = [], isLoading: itemsLoading } = useItemsList();

  const buckets = useMemo(
    () => reconcile(listings, items),
    [listings, items],
  );

  async function handleFile(file: File) {
    if (!user) return;
    setImporting(true);
    try {
      const text = await file.text();
      const { headerFound, listings: parsed, skipped } =
        parseEbayListingsCsv(text);
      if (!headerFound) {
        toast.error(
          "No listings table found. Export the Active Listings report from eBay Seller Hub and upload that CSV.",
        );
        return;
      }
      if (parsed.length === 0) {
        toast.error("The file had a header but no listing rows.");
        return;
      }

      // Map of FlipDesk SKU -> item id, for auto-matching.
      const itemsBySku = new Map<string, string>();
      for (const it of items) {
        const sku = normalizeSku(it.item_number);
        if (sku) itemsBySku.set(sku, it.id);
      }
      // Preserve any manual resolutions made on a prior import.
      const existing = new Map<string, EbayListingRow>();
      for (const l of listings) existing.set(l.ebay_item_id, l);

      const now = new Date().toISOString();
      const rows: EbayListingInsert[] = parsed.map((l) => {
        const prior = existing.get(l.ebayItemId);
        let matched_item_id: string | null;
        let match_status: EbayMatchStatus;
        if (
          prior &&
          (prior.match_status === "matched" || prior.match_status === "ignored")
        ) {
          matched_item_id = prior.matched_item_id;
          match_status = prior.match_status;
        } else {
          const am = autoMatch(l.customLabel, itemsBySku);
          matched_item_id = am.matched_item_id;
          match_status = am.match_status;
        }
        return {
          user_id: workspaceOwnerId ?? user.id,
          ebay_item_id: l.ebayItemId,
          custom_label: l.customLabel,
          title: l.title || null,
          current_price: l.price,
          available_quantity: l.quantity,
          listing_url: l.url,
          listing_format: l.format,
          start_date: l.startDate,
          matched_item_id,
          match_status,
          raw: l.raw,
          imported_at: now,
        };
      });

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const { error } = await supabase
          .from("flipdesk_ebay_listings")
          .upsert(chunk as never, { onConflict: "user_id,ebay_item_id" });
        if (error) throw error;
      }

      await qc.invalidateQueries({ queryKey: ["ebay_listings"] });
      const autoMatched = rows.filter(
        (r) => r.match_status === "matched",
      ).length;
      toast.success(
        `Imported ${rows.length} eBay listing${rows.length === 1 ? "" : "s"} — ` +
          `${autoMatched} matched by SKU automatically` +
          (skipped > 0 ? `, ${skipped} rows skipped` : ""),
      );
    } catch (err) {
      toast.error(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clearAll() {
    if (!user) return;
    if (
      !(await confirm({
        title: "Remove all imported eBay listings?",
        description:
          "This clears the SKU match data but does not touch your FlipDesk items.",
        confirmLabel: "Remove listings",
        destructive: true,
      }))
    )
      return;
    try {
      const { error } = await supabase
        .from("flipdesk_ebay_listings")
        .delete()
        .eq("user_id", workspaceOwnerId ?? user.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["ebay_listings"] });
      toast.success("Cleared imported eBay listings.");
    } catch (err) {
      toast.error(
        `Clear failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Creates a new inventory_items row pre-populated from the eBay listing,
  // plus the matching listings row, then marks the orphan matched. The
  // user can refine title + SKU before confirming via the dialog; this
  // function is the worker.
  //
  // When `customSku` is supplied, it overrides the eBay Custom Label. When
  // null/undefined the existing custom_label is used (or left null).
  async function createItemFromListing(
    listing: EbayListingRow,
    overrides: { title?: string; sku?: string | null } = {},
  ): Promise<string | null> {
    if (!user) {
      toast.error("You must be signed in.");
      return null;
    }
    const title = (overrides.title ?? listing.title ?? "").trim() ||
      `eBay item ${listing.ebay_item_id}`;
    const sku = overrides.sku !== undefined
      ? overrides.sku?.trim() || null
      : listing.custom_label;

    // 1. Insert inventory_items pre-listed (since it's already on eBay).
    const itemInsert: Record<string, unknown> = {
      user_id: workspaceOwnerId ?? user.id,
      title,
      sku,
      status: "listed",
      target_price: listing.current_price,
    };
    const { data: itemRow, error: itemErr } = await supabase
      .from("inventory_items")
      .insert(itemInsert as never)
      .select("id")
      .single();
    if (itemErr || !itemRow) {
      // Surface unique-violation errors clearly so the user can pick a different SKU.
      const msg = itemErr?.message ?? "Item create failed.";
      if (
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("unique")
      ) {
        throw new Error(
          `Another FlipDesk item already uses SKU "${sku}". Pick a different SKU.`,
        );
      }
      throw new Error(msg);
    }
    const itemId = (itemRow as { id: string }).id;

    // 2. Insert listings row mirroring the live eBay listing.
    const listingInsert: Record<string, unknown> = {
      inventory_item_id: itemId,
      platform: "ebay",
      // US-1077: mirroring a live eBay listing → eBay-originated.
      listing_origin: "ebay",
      platform_listing_id: listing.ebay_item_id,
      listing_url: listing.listing_url,
      listing_price: listing.current_price ?? 0,
      listing_title: listing.title,
      listing_status: "active",
      is_active: true,
      listed_at: new Date().toISOString(),
    };
    const { error: listErr } = await supabase
      .from("listings")
      .insert(listingInsert as never);
    if (listErr) {
      // Best-effort: leave the inventory_item created so the user can fix
      // the listing row by hand if needed. Surface the error.
      throw new Error(`Listing record failed: ${listErr.message}`);
    }

    // 3. Mark the orphan as matched.
    const { error: matchErr } = await supabase
      .from("flipdesk_ebay_listings")
      .update({
        match_status: "matched",
        matched_item_id: itemId,
      } as never)
      .eq("id", listing.id);
    if (matchErr) throw new Error(matchErr.message);

    return itemId;
  }

  // Bulk: create FlipDesk items for every orphan in one go. Errors per-row
  // are aggregated so one bad row doesn't sink the rest.
  async function createAllUnmatched() {
    if (bulkCreating) return;
    const orphans = buckets.unmatched.map((u) => u.listing);
    if (orphans.length === 0) return;
    setBulkCreating(true);
    let created = 0;
    const errors: string[] = [];
    for (const listing of orphans) {
      try {
        await createItemFromListing(listing);
        created += 1;
      } catch (err) {
        errors.push(
          `${listing.title ?? listing.ebay_item_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["ebay_listings"] }),
      qc.invalidateQueries({ queryKey: ["items_full"] }),
    ]);
    setBulkCreating(false);
    if (errors.length === 0) {
      toast.success(
        `Created ${created} FlipDesk item${created === 1 ? "" : "s"} from eBay.`,
      );
    } else {
      toast.warning(
        `Created ${created}, ${errors.length} failed. First: ${errors[0]}`,
        { duration: 12_000 },
      );
    }
  }

  // One-click link: accept the title-suggested item without opening the
  // search dialog. Sets matched_item_id + match_status but intentionally
  // does NOT touch the FlipDesk item's SKU — use the regular "Link" dialog
  // when you also want to copy the eBay Custom Label across.
  async function quickLink(listing: EbayListingRow, suggestionId: string) {
    if (quickLinkBusyId) return;
    setQuickLinkBusyId(listing.id);
    try {
      // US-465 AC1: mirror the live eBay listing into the listings table so the
      // linked item carries its eBay URL/id, then flip the orphan to matched.
      await upsertEbayListingRowForItem(suggestionId, listing);
      const { error } = await supabase
        .from("flipdesk_ebay_listings")
        .update({
          matched_item_id: suggestionId,
          match_status: "matched",
        } as never)
        .eq("id", listing.id);
      if (error) throw error;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["ebay_listings"] }),
        qc.invalidateQueries({ queryKey: ["items_full"] }),
      ]);
      toast.success("Listing linked to suggested item.");
    } catch (err) {
      toast.error(
        `Link failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setQuickLinkBusyId(null);
    }
  }

  async function ignore(listing: EbayListingRow) {
    try {
      const { error } = await supabase
        .from("flipdesk_ebay_listings")
        .update({ match_status: "ignored", matched_item_id: null } as never)
        .eq("id", listing.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["ebay_listings"] });
    } catch (err) {
      toast.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function unignore(listing: EbayListingRow) {
    try {
      // Re-run the SKU auto-match when un-ignoring.
      const itemsBySku = new Map<string, string>();
      for (const it of items) {
        const sku = normalizeSku(it.item_number);
        if (sku) itemsBySku.set(sku, it.id);
      }
      const am = autoMatch(listing.custom_label, itemsBySku);
      const { error } = await supabase
        .from("flipdesk_ebay_listings")
        .update(am as never)
        .eq("id", listing.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["ebay_listings"] });
    } catch (err) {
      toast.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const loading = listingsLoading || itemsLoading;

  return (
    <div className="space-y-6">
      {/* Import bar */}
      <Card>
        <CardHeader>
          <CardTitle>Pull your eBay listings</CardTitle>
          <CardDescription>
            In eBay Seller Hub go to <strong>Listings → Active</strong>, choose{" "}
            <strong>Download report</strong>, and upload the CSV here. FlipDesk
            reads the <strong>Custom label (SKU)</strong> column and matches it
            to each item&apos;s SKU. A direct API connection can replace this
            step later — see the Marketplaces page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload eBay CSV
          </Button>
          {listings.length > 0 && (
            <Button variant="ghost" onClick={clearAll} disabled={importing}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clear imported data
            </Button>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <LoadingRegion label="Loading listings">
          <SkeletonRows rows={5} />
        </LoadingRegion>
      ) : listings.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          No eBay listings imported yet. Upload your Active Listings CSV to run
          the SKU check.
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="eBay listings" value={listings.length} />
            <StatTile
              label="Matched by SKU"
              value={buckets.matched.length}
              tone="ok"
            />
            <StatTile
              label="SKU mismatches"
              value={buckets.unmatched.length}
              tone={buckets.unmatched.length > 0 ? "warn" : "muted"}
            />
            <StatTile
              label="Listed, not on eBay"
              value={buckets.listedNotOnEbay.length}
              tone={buckets.listedNotOnEbay.length > 0 ? "warn" : "muted"}
            />
          </div>

          {/* Unmatched — the SKU check */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    SKU mismatches
                  </CardTitle>
                  <CardDescription>
                    eBay listings whose Custom Label doesn&apos;t match any
                    FlipDesk SKU. Link each to the right item — optionally
                    copying the SKU across so future pulls match automatically.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {buckets.unmatched.length > 0 && (
                    <Button
                      size="sm"
                      onClick={() => void createAllUnmatched()}
                      disabled={bulkCreating}
                    >
                      {bulkCreating ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Create all ({buckets.unmatched.length})
                    </Button>
                  )}
                  <Badge
                    variant={
                      buckets.unmatched.length > 0 ? "destructive" : "outline"
                    }
                  >
                    {buckets.unmatched.length}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {buckets.unmatched.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Every imported eBay listing matches a FlipDesk SKU.
                </div>
              ) : (
                <ul className="space-y-2">
                  {buckets.unmatched.map(({ listing, suggestion, reason }) => (
                    <li
                      key={listing.id}
                      className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">
                              {listing.title || "Untitled listing"}
                            </span>
                            {listing.listing_url && (
                              <a
                                href={listing.listing_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                                aria-label="Open on eBay"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            eBay item {listing.ebay_item_id} ·{" "}
                            {reason === "no_custom_label" ? (
                              <span className="text-destructive">
                                no Custom Label set on eBay
                              </span>
                            ) : (
                              <>
                                Custom Label{" "}
                                <span className="font-mono text-foreground">
                                  {listing.custom_label}
                                </span>{" "}
                                not found in FlipDesk
                              </>
                            )}
                          </div>
                          {suggestion && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>
                                Possible match by title:{" "}
                                <span className="font-medium text-foreground">
                                  {suggestion.item_title}
                                </span>{" "}
                                (SKU {suggestion.item_number ?? "—"})
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={() =>
                                  void quickLink(listing, suggestion.id)
                                }
                                disabled={quickLinkBusyId === listing.id}
                              >
                                {quickLinkBusyId === listing.id ? (
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Link2 className="mr-1 h-3 w-3" />
                                )}
                                Link to this
                              </Button>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => setCreateTarget(listing)}
                            aria-label={`Create an item for ${listing.title || "untitled listing"}`}
                          >
                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                            Create
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setLinkTarget(listing)}
                            aria-label={`Link ${listing.title || "untitled listing"} to an item`}
                          >
                            <Link2 className="mr-1.5 h-3.5 w-3.5" />
                            Link
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void ignore(listing)}
                            aria-label={`Ignore ${listing.title || "untitled listing"}`}
                          >
                            <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                            Ignore
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Listed in FlipDesk but absent from eBay import */}
          {buckets.listedNotOnEbay.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Listed in FlipDesk, not in the eBay import
                </CardTitle>
                <CardDescription>
                  FlipDesk has these marked as listed, but no imported eBay
                  listing matched. They may have sold or ended on eBay, or were
                  never actually listed there.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {buckets.listedNotOnEbay.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-sm"
                    >
                      <span className="truncate">{it.item_title}</span>
                      <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">
                        SKU {it.item_number ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Matched */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Matched listings
              </CardTitle>
              <CardDescription>
                {buckets.matched.length} eBay listing
                {buckets.matched.length === 1 ? "" : "s"} linked to a FlipDesk
                item.
              </CardDescription>
            </CardHeader>
            {buckets.matched.length > 0 && (
              <CardContent>
                <ul className="space-y-1.5">
                  {buckets.matched.slice(0, 100).map(({ listing, item }) => (
                    <li
                      key={listing.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-sm"
                    >
                      <span className="truncate">{item.item_title}</span>
                      <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">
                        {listing.custom_label ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
                {buckets.matched.length > 100 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    + {buckets.matched.length - 100} more
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Ignored */}
          {buckets.ignored.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Ignored ({buckets.ignored.length})</CardTitle>
                <CardDescription>
                  Excluded from the SKU check. Restore any to re-run matching.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {buckets.ignored.map((listing) => (
                    <li
                      key={listing.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-sm"
                    >
                      <span className="truncate text-muted-foreground">
                        {listing.title || listing.ebay_item_id}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void unignore(listing)}
                        aria-label={`Restore ${listing.title || listing.ebay_item_id}`}
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <LinkItemDialog
        listing={linkTarget}
        items={items}
        onClose={() => setLinkTarget(null)}
      />

      <CreateItemFromListingDialog
        listing={createTarget}
        onClose={() => setCreateTarget(null)}
        onCreate={async (overrides) => {
          if (!createTarget) return;
          try {
            await createItemFromListing(createTarget, overrides);
            await Promise.all([
              qc.invalidateQueries({ queryKey: ["ebay_listings"] }),
              qc.invalidateQueries({ queryKey: ["items_full"] }),
            ]);
            toast.success("Item created and linked to the eBay listing.");
            setCreateTarget(null);
          } catch (err) {
            toast.error(
              err instanceof Error ? err.message : String(err),
            );
          }
        }}
      />
    </div>
  );
}

// Pre-fills title + SKU from the eBay listing; user can edit either before
// confirming. SKU is optional — if blank, the new item has no SKU and the
// user can set one later.
function CreateItemFromListingDialog({
  listing,
  onClose,
  onCreate,
}: {
  listing: EbayListingRow | null;
  onClose: () => void;
  onCreate: (overrides: {
    title: string;
    sku: string | null;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [sku, setSku] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the dialog opens on a different listing. (US-1479: this is
  // a side effect — setState during render via useMemo misbehaves under
  // StrictMode/concurrent rendering — so it belongs in useEffect.)
  useEffect(() => {
    if (listing) {
      setTitle(listing.title ?? "");
      setSku(listing.custom_label ?? "");
    }
  }, [listing]);

  async function handleCreate() {
    setSaving(true);
    try {
      await onCreate({
        title: title.trim(),
        sku: sku.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={!!listing}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create FlipDesk item from eBay listing</DialogTitle>
          <DialogDescription>
            We&apos;ll add this to your inventory pre-listed, link it to the
            live eBay listing, and pre-fill the SKU. Edit either field below
            before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="esm-title" className="text-xs font-medium">Title</label>
            <Input
              id="esm-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Item title"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">
              SKU{" "}
              <span className="text-muted-foreground">
                (optional — copied from eBay&apos;s Custom Label)
              </span>
            </label>
            <Input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="Leave blank to set later"
              className="font-mono"
            />
          </div>
          {listing?.current_price != null && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Current eBay price{" "}
              <span className="font-mono text-foreground">
                ${Number(listing.current_price).toFixed(2)}
              </span>{" "}
              will be used as the target price and live listing price.
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving || !title.trim()}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Create item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkItemDialog({
  listing,
  items,
  onClose,
}: {
  listing: EbayListingRow | null;
  items: ItemListRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncSku, setSyncSku] = useState(true);
  const [saving, setSaving] = useState(false);

  const customLabel = listing?.custom_label?.trim() ?? "";
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const skuDiffers =
    !!customLabel &&
    normalizeSku(selected?.item_number) !== normalizeSku(customLabel);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = q
      ? items.filter(
          (i) =>
            i.item_title.toLowerCase().includes(q) ||
            (i.item_number ?? "").toLowerCase().includes(q),
        )
      : items;
    return pool.slice(0, 60);
  }, [items, search]);

  async function confirm() {
    if (!listing || !selected) return;
    setSaving(true);
    try {
      // Optionally copy the eBay Custom Label into the FlipDesk item's SKU so
      // the two systems agree and future imports auto-match.
      if (syncSku && customLabel && skuDiffers) {
        const { error: itemErr } = await supabase
          .from("inventory_items")
          .update({ sku: customLabel } as never)
          .eq("id", selected.id);
        if (itemErr) {
          throw new Error(
            itemErr.message.includes("duplicate") ||
            itemErr.message.includes("unique")
              ? `Another FlipDesk item already uses SKU "${customLabel}". Resolve that first.`
              : itemErr.message,
          );
        }
      }
      // US-465 AC1: create/update the listings row mirroring the live eBay
      // listing so the linked item carries its eBay URL + platform id.
      await upsertEbayListingRowForItem(selected.id, listing);
      const { error } = await supabase
        .from("flipdesk_ebay_listings")
        .update({
          matched_item_id: selected.id,
          match_status: "matched",
        } as never)
        .eq("id", listing.id);
      if (error) throw error;

      await Promise.all([
        qc.invalidateQueries({ queryKey: ["ebay_listings"] }),
        qc.invalidateQueries({ queryKey: ["items_full"] }),
      ]);
      toast.success("Listing linked.");
      handleClose();
    } catch (err) {
      toast.error(
        `Link failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setSearch("");
    setSelectedId(null);
    setSyncSku(true);
    onClose();
  }

  return (
    <Dialog
      open={!!listing}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link eBay listing to a FlipDesk item</DialogTitle>
          <DialogDescription className="truncate">
            {listing?.title || listing?.ebay_item_id} ·{" "}
            {customLabel ? (
              <>
                Custom Label{" "}
                <span className="font-mono">{customLabel}</span>
              </>
            ) : (
              "no Custom Label on eBay"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            aria-label="Search items"
            placeholder="Search items by title or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
            {results.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No items match.
              </div>
            ) : (
              results.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setSelectedId(it.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                    selectedId === it.id
                      ? "bg-brand-navy text-white"
                      : "hover:bg-muted"
                  }`}
                >
                  <span className="truncate">{it.item_title}</span>
                  <span
                    className={`flex-shrink-0 font-mono text-xs ${
                      selectedId === it.id
                        ? "text-white/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {it.item_number ?? "no SKU"}
                  </span>
                </button>
              ))
            )}
          </div>

          {selected && customLabel && skuDiffers && (
            <label className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <input
                type="checkbox"
                checked={syncSku}
                onChange={(e) => setSyncSku(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-brand-navy"
              />
              <span>
                Set this item&apos;s SKU to{" "}
                <span className="font-mono">{customLabel}</span>
                {selected.item_number ? (
                  <span className="text-muted-foreground">
                    {" "}
                    (currently {selected.item_number})
                  </span>
                ) : null}
                . Keeps FlipDesk and eBay in sync so future imports match
                automatically.
              </span>
            </label>
          )}
          {selected && !customLabel && (
            <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              This eBay listing has no Custom Label. After linking, set its
              Custom Label on eBay to{" "}
              <span className="font-mono">
                {selected.item_number ?? "this item's SKU"}
              </span>{" "}
              so they stay matched.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!selected || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Link item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
