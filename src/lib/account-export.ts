import { supabase } from "./supabase";
import { createZip, type ZipInputFile } from "./zip";
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

// A few PII tables (push_device_tokens, feedback_messages) aren't in the
// generated Database types yet. Fetch them through a loosely-typed query — RLS
// still scopes the rows to the caller — and serialize the JSON as-is (US-381).
async function selectAllUntyped(table: string): Promise<unknown[]> {
  const client = supabase as unknown as {
    from: (t: string) => {
      select: (cols: string) => Promise<{ data: unknown[] | null }>;
    };
  };
  const { data } = await client.from(table).select("*");
  return data ?? [];
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
  onProgress("Fetching submissions…", 8);
  const { data: submissionsRaw, error: subErr } = await supabase
    .from("submissions")
    .select("*");
  if (subErr) throw subErr;
  const submissions = (submissionsRaw ?? []) as SubmissionRow[];

  onProgress("Fetching grade reports…", 18);
  const { data: reportsRaw } = await supabase
    .from("grade_reports")
    .select("*");
  const gradeReports = (reportsRaw ?? []) as GradeReportRow[];

  onProgress("Fetching inventory…", 28);
  const { data: itemsRaw } = await supabase
    .from("inventory_items")
    .select("*");
  const inventory = (itemsRaw ?? []) as InventoryItemRow[];

  onProgress("Fetching sales…", 38);
  const { data: salesRaw } = await supabase.from("sales").select("*");
  const sales = (salesRaw ?? []) as SaleRow[];

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
    supabase.from("disputes").select("*"),
    supabase
      .from("api_keys")
      .select("id, name, key_prefix, scopes, last_used_at, last_rotated_at, expires_at, created_at"),
    supabase.from("notifications").select("*"),
    selectAllUntyped("push_device_tokens"),
    supabase.from("workspace_members").select("*"),
    supabase.from("workspace_invitations").select("*"),
    supabase
      .from("marketplace_connections")
      .select("id, marketplace, account_handle, is_active, scopes, last_synced_at, created_at, updated_at"),
    supabase.from("payout_imports").select("*"),
    selectAllUntyped("feedback_messages"),
    supabase.from("sources").select("*"),
  ]);

  onProgress("Listing image references…", 70);
  const { data: imagesRaw } = await supabase
    .from("submission_images")
    .select("*");
  const images = (imagesRaw ?? []) as SubmissionImageRow[];

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
    jsonFile("submissions.json", submissionsWithImages),
    jsonFile("grade_reports.json", gradeReports),
    jsonFile("inventory.json", inventory),
    jsonFile("sales.json", sales),
    jsonFile("disputes.json", disputes.data ?? []),
    jsonFile("api_keys.json", apiKeys.data ?? []),
    jsonFile("notifications.json", notifications.data ?? []),
    jsonFile("device_tokens.json", deviceTokens),
    jsonFile("workspace_memberships.json", memberships.data ?? []),
    jsonFile("workspace_invitations.json", invitations.data ?? []),
    jsonFile("marketplace_connections.json", connections.data ?? []),
    jsonFile("payout_imports.json", payoutImports.data ?? []),
    jsonFile("feedback.json", feedback),
    jsonFile("sources.json", sources.data ?? []),
    jsonFile("financial_summary.json", financialSummary),
  ]);

  onProgress("Done", 100);
  return zip;
}
