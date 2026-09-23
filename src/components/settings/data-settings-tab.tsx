import { useState } from "react";
import { Link } from "react-router";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/use-auth";
import { downloadBlob } from "@/lib/download";
import { buildAccountExport } from "@/lib/account-export";
import { edgeFetch } from "@/lib/edge-fetch";
import { toastError } from "@/lib/toast-error";
import { readStored } from "@/lib/safe-storage";

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// The Data tab of /dashboard/settings: the instant ZIP export and formal
// GDPR/CCPA requests. Split out of settings.tsx (web-growth action 6).
export function DataSettingsTab() {
  const { user } = useAuth();

  const [exporting, setExporting] = useState(false);
  const [filingRequest, setFilingRequest] = useState<"export" | "delete" | null>(null);
  const [exportStage, setExportStage] = useState("");
  const [exportPct, setExportPct] = useState(0);

  async function handleExportData() {
    if (!user) return;
    const key = `gt-last-export-${user.id}`;
    const last = Number(readStored(key) ?? 0);
    const sinceLast = Date.now() - last;
    if (last && sinceLast < EXPORT_COOLDOWN_MS) {
      const hours = Math.ceil((EXPORT_COOLDOWN_MS - sinceLast) / 3600000);
      toast.error(
        `You can export once per day. Try again in about ${hours} hour${
          hours === 1 ? "" : "s"
        }.`
      );
      return;
    }

    setExporting(true);
    setExportPct(0);
    setExportStage("Starting…");
    try {
      const blob = await buildAccountExport((stage, pct) => {
        setExportStage(stage);
        setExportPct(pct);
      });
      localStorage.setItem(key, String(Date.now()));

      downloadBlob(
        blob,
        `gradethread-export-${new Date().toISOString().split("T")[0]}.zip`,
      );

      toast.success("Your data export has been downloaded.");
    } catch (err) {
      toastError(err, "Failed to export data.");
    } finally {
      setExporting(false);
    }
  }

  // US-903: file a formal GDPR/CCPA data-subject request (export or deletion).
  // Unlike the instant export above, this lands an audited, tracked request in
  // the compliance queue for an operator to fulfill.
  async function handleFileDataRequest(type: "export" | "delete") {
    setFilingRequest(type);
    try {
      const res = await edgeFetch("/api/account/data-requests", {
        method: "POST",
        json: { type },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to file your request.");
      }
      toast.success(
        type === "export"
          ? "Data export request filed. We'll process it and email you."
          : "Deletion request filed. Our team will process it.",
      );
    } catch (err) {
      toastError(err, "Failed to file request.");
    } finally {
      setFilingRequest(null);
    }
  }

  return (
    <>
          {/* Data Export Section */}
          <Card>
        <CardHeader>
          <CardTitle>Data Export</CardTitle>
          <CardDescription>
            Download all of your account data as a ZIP archive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The archive contains all of your account data as JSON — submissions,
            grade reports, inventory, sales, disputes, API-key metadata,
            notifications, workspace memberships and invitations, connected
            marketplaces, payout imports, feedback, and a financial summary, plus
            a README. Image files are not included (a private store); each
            submission lists its image paths. Limited to one export per day.
          </p>
          {exporting && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{exportStage}</span>
                <span>{exportPct}%</span>
              </div>
              <Progress value={exportPct} />
            </div>
          )}
          <Button onClick={handleExportData} disabled={exporting}>
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export My Data
          </Button>
          <p className="text-xs text-muted-foreground">
            See our{" "}
            <Link to="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>{" "}
            for how we handle and retain your data.
          </p>
        </CardContent>
      </Card>

          {/* US-903: formal data-subject requests (tracked compliance queue). */}
          <Card>
            <CardHeader>
              <CardTitle>Formal data requests</CardTitle>
              <CardDescription>
                File a tracked GDPR/CCPA request. We log it, fulfill it, and keep
                a compliance record — distinct from the instant export above.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => handleFileDataRequest("export")}
                disabled={filingRequest !== null}
              >
                {filingRequest === "export" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Request data export
              </Button>
              <Button
                variant="outline"
                onClick={() => handleFileDataRequest("delete")}
                disabled={filingRequest !== null}
              >
                {filingRequest === "delete" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Request data deletion
              </Button>
            </CardContent>
          </Card>
    </>
  );
}
