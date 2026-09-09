import { supabase } from "./supabase";
import { fetchAllPages } from "./paged-read";
import { createZip, type ZipInputFile } from "./zip";
import { fetchShippingProfile, type ShippingProfile } from "./shipping-profile";
import type {
  SubmissionRow,
  GradeReportRow,
  InventoryItemRow,
  SaleRow,
  SubmissionImageRow,
} from "@/types/database";

export type ExportProgress = (stage: string, pct: number) => void;

function jsonFile(name: string, value: unknown): ZipInputFile {
  return {
    name,
    data: new TextEncoder().encode(JSON.stringify(value, null, 2)),
  };
}

function textFile(name: string, value: string): ZipInputFile {
  return { name, data: new TextEncoder().encode(value) };
}

/**
 * One record set for the export, read WHOLE and read HONESTLY.
 *
 * Two things were wrong with the reads this replaces, and they compounded.
 *
 * They discarded the error and fell through to `[]`. A subject access request
 * is the one document where an empty section is a statement of fact: the
 * person is being told, in a file they may take to a regulator, that
 * GradeThread holds no grade reports for them. A failed read said exactly that
 * and looked identical to a genuinely empty account. The financial summary is
 * built from the same rows, so a dropped table also zeroed their revenue.
 *
 * And they were unbounded. PostgREST clips any response at `db-max-rows` and
 * reports it only in a header supabase-js drops, so a long-standing seller's
 * export would have been short with nothing anywhere saying so.
 *
 * So: pages until the data runs out, and throws the moment a read fails. The
 * caller surfaces that as a failed export the person can retry, which is the
 * honest outcome — a partial archive that cannot say which part is missing is
 * worse than no archive.
 *
 * Loosely typed on purpose: a few PII tables (push_device_tokens,
 * feedback_messages) aren't in the generated Database types, and RLS scopes
 * every row here to the caller regardless (US-381).
 */
async function exportRows<T>(table: string, columns = "*"): Promise<T[]> {
  const client = supabase as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        order: (
          c: string,
          o: { ascending: boolean },
        ) => {
          range: (
            a: number,
            b: number,
          ) => Promise<{
            data: unknown[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
  return fetchAllPages<T>(async (from, to) => {
    // Ordered by primary key, so a page boundary cannot repeat or skip a row
    // the way an unordered read can once the table is being written to.
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) {
      throw new Error(
        `Your export could not be completed: the ${table} records could not be read (${error.message}). Nothing was left out silently — please try again.`,
      );
    }
    return (data ?? []) as T[];
  });
}

/**
 * Gathers ALL of the signed-in user's data for a GDPR SAR / CCPA export (RLS
 * scopes every query) and packages it into a downloadable ZIP. Image binaries
 * are excluded (documented in README) — the archive lists each image's storage
 * path. Sensitive secrets are NEVER exported: api_keys exclude key_hash and
 * marketplace_connections exclude the encrypted OAuth tokens (US-381).
 */
export async function buildAccountExport(
  onProgress: ExportProgress
): Promise<Blob> {
  onProgress("Fetching profile…", 6);
  // US-1442: include the user's own profile row (identity + business/ship-from
  // details) so the new fields are part of the GDPR/CCPA export. RLS scopes
  // `users` to self. Curated columns — no internal billing/subscription state.
  const { data: profileRaw, error: profileErr } = await supabase
    .from("users")
    .select(
      "id, email, full_name, avatar_url, business_name, use_case, created_at, updated_at",
    )
    .maybeSingle();
  // An unread profile row is not an absent one. Left unchecked this shipped
  // `profile.json` as `null` — the export saying GradeThread holds no account
  // details for a person who is signed in as that account.
  if (profileErr) {
    throw new Error(
      `Your export could not be completed: your profile could not be read (${profileErr.message}). Please try again.`,
    );
  }
  // US-2417: business_phone and ship_from_address are NOT in the select above
  // any more — they are AES-GCM ciphertext on that row and exporting the
  // envelope would hand the person a string they cannot read while looking like
  // compliance. The plaintext comes from the edge, which holds the key.
  //
  // Best-effort on purpose: a GDPR export must not fail wholesale because one
  // optional field could not be unlocked. A failure exports the rest and marks
  // these two null, which is honest — the alternative is no export at all.
  let shipping: ShippingProfile | null = null;
  try {
    shipping = await fetchShippingProfile();
  } catch (err) {
    console.warn(
      "[account-export] shipping profile unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }
  const profile = profileRaw
    ? {
      ...(profileRaw as Record<string, unknown>),
      business_phone: shipping?.business_phone ?? null,
      ship_from_address: shipping?.ship_from_address ?? null,
    }
    : null;

  onProgress("Fetching submissions…", 8);
  const submissions = await exportRows<SubmissionRow>("submissions");

  onProgress("Fetching grade reports…", 18);
  const gradeReports = await exportRows<GradeReportRow>("grade_reports");

  onProgress("Fetching inventory…", 28);
  const inventory = await exportRows<InventoryItemRow>("inventory_items");

  onProgress("Fetching sales…", 38);
  const sales = await exportRows<SaleRow>("sales");

  // US-381: the remaining tables that hold the user's PII / records. Each is
  // RLS-scoped to the caller. Secret-bearing tables are column-restricted so a
  // key hash or OAuth token never lands in the export.
  onProgress("Fetching account records…", 52);
  const [
    disputes,
    apiKeys,
    notifications,
    deviceTokens,
    memberships,
    invitations,
    connections,
    payoutImports,
    feedback,
    sources,
  ] = await Promise.all([
    exportRows("disputes"),
    exportRows(
      "api_keys",
      "id, name, key_prefix, scopes, last_used_at, last_rotated_at, expires_at, created_at",
    ),
    exportRows("notifications"),
    exportRows("push_device_tokens"),
    exportRows("workspace_members"),
    exportRows("workspace_invitations"),
    exportRows(
      "marketplace_connections",
      "id, marketplace, account_handle, is_active, scopes, last_synced_at, created_at, updated_at",
    ),
    exportRows("payout_imports"),
    exportRows("feedback_messages"),
    exportRows("sources"),
  ]);

  onProgress("Listing image references…", 70);
  // These become `image_paths` on every submission. A dropped read here would
  // have told the person their graded photos do not exist, in the one file
  // that documents where to ask for the binaries.
  const images = await exportRows<SubmissionImageRow>("submission_images");

  // Image BINARIES are excluded (private bucket — public URLs don't resolve and
  // signed URLs would expire before the archive is opened). We list each image's
  // storage path instead; the README documents how to retrieve the files.
  const pathsBySubmission = new Map<string, string[]>();
  for (const img of images) {
    const list = pathsBySubmission.get(img.submission_id) ?? [];
    list.push(img.storage_path);
    pathsBySubmission.set(img.submission_id, list);
  }
  const submissionsWithImages = submissions.map((s) => ({
    ...s,
    image_paths: pathsBySubmission.get(s.id) ?? [],
  }));

  onProgress("Building financial summary…", 84);
  const totalAcquisitionCost = inventory.reduce(
    (sum, i) => sum + (i.acquired_price ?? 0),
    0
  );
  const totalRevenue = sales.reduce((sum, s) => sum + s.sale_price, 0);
  const totalPlatformFees = sales.reduce(
    (sum, s) => sum + s.platform_fees,
    0
  );
  const soldItemIds = new Set(sales.map((s) => s.inventory_item_id));
  const financialSummary = {
    generated_at: new Date().toISOString(),
    counts: {
      submissions: submissions.length,
      grade_reports: gradeReports.length,
      inventory_items: inventory.length,
      sales: sales.length,
    },
    inventory: {
      total_items: inventory.length,
      sold_items: soldItemIds.size,
      unsold_items: inventory.length - soldItemIds.size,
      total_acquisition_cost: Math.round(totalAcquisitionCost * 100) / 100,
    },
    sales: {
      total_sales: sales.length,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_platform_fees: Math.round(totalPlatformFees * 100) / 100,
      net: Math.round(
        (totalRevenue - totalPlatformFees - totalAcquisitionCost) * 100
      ) / 100,
    },
  };

  onProgress("Packaging archive…", 94);
  const readme = [
    "GradeThread data export",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This archive contains a copy of your personal data held by GradeThread,",
    "provided under GDPR (Art. 15/20) and CCPA. Each .json file is one record set:",
    "",
    "  profile.json              your account profile (name, business & ship-from details)",
    "  submissions.json          your grading submissions (with image_paths)",
    "  grade_reports.json        the resulting grade reports",
    "  inventory.json            your FlipDesk inventory items",
    "  sales.json                recorded sales",
    "  disputes.json             grade disputes you filed",
    "  api_keys.json             your API keys (metadata only — secret hashes excluded)",
    "  notifications.json        your in-app notifications",
    "  device_tokens.json        push-notification device registrations",
    "  workspace_memberships.json workspaces you belong to",
    "  workspace_invitations.json invitations involving you",
    "  marketplace_connections.json connected marketplaces (OAuth tokens excluded)",
    "  payout_imports.json       imported payout records",
    "  feedback.json             feedback messages you sent",
    "  sources.json              your sourcing records",
    "  financial_summary.json    aggregate totals",
    "",
    "IMAGES: photo files are NOT included to keep the archive small and because",
    "they live in a private store. submissions.json lists each image's storage",
    "path under image_paths; you can view/download the originals from the app, or",
    "request the binaries from privacy@gradethread.com.",
    "",
    "SECRETS: for your security this export deliberately omits API-key hashes and",
    "marketplace OAuth tokens.",
  ].join("\n");

  const zip = createZip([
    textFile("README.txt", readme),
    jsonFile("profile.json", profile),
    jsonFile("submissions.json", submissionsWithImages),
    jsonFile("grade_reports.json", gradeReports),
    jsonFile("inventory.json", inventory),
    jsonFile("sales.json", sales),
    jsonFile("disputes.json", disputes),
    jsonFile("api_keys.json", apiKeys),
    jsonFile("notifications.json", notifications),
    jsonFile("device_tokens.json", deviceTokens),
    jsonFile("workspace_memberships.json", memberships),
    jsonFile("workspace_invitations.json", invitations),
    jsonFile("marketplace_connections.json", connections),
    jsonFile("payout_imports.json", payoutImports),
    jsonFile("feedback.json", feedback),
    jsonFile("sources.json", sources),
    jsonFile("financial_summary.json", financialSummary),
  ]);

  onProgress("Done", 100);
  return zip;
}
