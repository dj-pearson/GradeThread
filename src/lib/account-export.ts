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

/**
 * Gathers all of the signed-in user's data (RLS scopes every query) and
 * packages it into a downloadable ZIP. Image binaries are excluded — only
 * their public URLs are included to keep the archive small.
 */
export async function buildAccountExport(
  onProgress: ExportProgress
): Promise<Blob> {
  onProgress("Fetching submissions…", 12);
  const { data: submissionsRaw, error: subErr } = await supabase
    .from("submissions")
    .select("*");
  if (subErr) throw subErr;
  const submissions = (submissionsRaw ?? []) as SubmissionRow[];

  onProgress("Fetching grade reports…", 28);
  const { data: reportsRaw } = await supabase
    .from("grade_reports")
    .select("*");
  const gradeReports = (reportsRaw ?? []) as GradeReportRow[];

  onProgress("Fetching inventory…", 44);
  const { data: itemsRaw } = await supabase
    .from("inventory_items")
    .select("*");
  const inventory = (itemsRaw ?? []) as InventoryItemRow[];

  onProgress("Fetching sales…", 58);
  const { data: salesRaw } = await supabase.from("sales").select("*");
  const sales = (salesRaw ?? []) as SaleRow[];

  onProgress("Resolving image URLs…", 72);
  const { data: imagesRaw } = await supabase
    .from("submission_images")
    .select("*");
  const images = (imagesRaw ?? []) as SubmissionImageRow[];

  // Attach image URLs (not binaries) to each submission.
  const urlsBySubmission = new Map<string, string[]>();
  for (const img of images) {
    const { data: urlData } = supabase.storage
      .from("submission-images")
      .getPublicUrl(img.storage_path);
    const list = urlsBySubmission.get(img.submission_id) ?? [];
    list.push(urlData.publicUrl);
    urlsBySubmission.set(img.submission_id, list);
  }
  const submissionsWithImages = submissions.map((s) => ({
    ...s,
    image_urls: urlsBySubmission.get(s.id) ?? [],
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
  const zip = createZip([
    jsonFile("submissions.json", submissionsWithImages),
    jsonFile("grade_reports.json", gradeReports),
    jsonFile("inventory.json", inventory),
    jsonFile("sales.json", sales),
    jsonFile("financial_summary.json", financialSummary),
  ]);

  onProgress("Done", 100);
  return zip;
}
