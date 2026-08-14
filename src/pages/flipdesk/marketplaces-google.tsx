import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreateSyncSheet,
  useDisconnectGoogle,
  useGoogleConfig,
  useGoogleConnection,
  useStartGoogleOauth,
  useSyncNow,
  useUseExistingSheet,
} from "@/hooks/use-google-sheets";
import { SheetMapCard } from "@/components/flipdesk/sheet-map-card";

// Result codes the OAuth callback appends to the wizard URL.
const CALLBACK_MESSAGES: Record<
  string,
  { type: "success" | "info" | "error"; message: string }
> = {
  connected: {
    type: "success",
    message: "Google connected. Now pick or create your FlipDesk Sync sheet.",
  },
  cancelled: { type: "info", message: "Google sign-in cancelled." },
  invalid_state: {
    type: "error",
    message: "Google sign-in expired or was tampered with. Please try again.",
  },
  state_expired: {
    type: "error",
    message: "Google sign-in took too long and expired. Please try again.",
  },
  exchange_failed: {
    type: "error",
    message: "Could not complete Google sign-in. Please retry, and contact support if it persists.",
  },
  error: {
    type: "error",
    message: "Something went wrong connecting Google. Please try again.",
  },
};

// Pulls the spreadsheet id out of a pasted Google Sheets URL, or accepts a bare
// id. Returns null when it can't find a plausible id.
function extractSheetId(raw: string): string | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1]!;
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export function FlipdeskMarketplacesGooglePage() {
  const [params, setParams] = useSearchParams();
  const { data: config } = useGoogleConfig();
  const { data: connection, isLoading } = useGoogleConnection();
  const startOauth = useStartGoogleOauth();
  const createSheet = useCreateSyncSheet();
  const useExisting = useUseExistingSheet();
  const disconnect = useDisconnectGoogle();
  const syncNow = useSyncNow();

  const [existing, setExisting] = useState("");

  // Surface the OAuth callback result once, then strip it from the URL.
  useEffect(() => {
    const code = params.get("google");
    if (!code) return;
    const entry = CALLBACK_MESSAGES[code];
    if (entry) {
      if (entry.type === "success") toast.success(entry.message);
      else if (entry.type === "info") toast.info(entry.message);
      else toast.error(entry.message);
    }
    const next = new URLSearchParams(params);
    next.delete("google");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const connected = !!connection?.connected;
  const hasSheet = !!connection?.has_sheet;
  const notConfigured = config && !config.configured;

  const linkExisting = async () => {
    const id = extractSheetId(existing);
    if (!id) {
      toast.error("Paste a Google Sheets link or its spreadsheet id.");
      return;
    }
    try {
      await useExisting.mutateAsync({ sheetId: id });
      setExisting("");
    } catch {
      /* surfaced by the hook */
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          to="/dashboard/flipdesk/marketplaces"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Marketplaces
        </Link>
        <PageHeader
          icon={FileSpreadsheet}
          title="Google Sheets sync"
          subtitle="Connect a Google account so FlipDesk can keep a live sync spreadsheet on your Drive."
        />
      </div>

      {notConfigured ? (
        <Card>
          <CardHeader>
            <CardTitle>Not available yet</CardTitle>
            <CardDescription>
              Google Sheets sync isn&apos;t configured on this server yet. Check
              back soon.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking your Google connection…
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Step 1 — connect the account */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    1
                  </span>
                  Connect Google
                </CardTitle>
                {connected ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">
                    <Check className="mr-1 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary">Not connected</Badge>
                )}
              </div>
              <CardDescription>
                We request the minimum scopes: access only to files FlipDesk
                creates or you select (<code>drive.file</code>) plus Sheets
                read/write. We never see the rest of your Drive.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {connected && connection?.google_email && (
                <p className="text-sm">
                  Signed in as{" "}
                  <span className="font-medium">{connection.google_email}</span>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => startOauth.mutate()}
                  disabled={startOauth.isPending}
                  variant={connected ? "outline" : "default"}
                >
                  {startOauth.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {connected ? "Reconnect" : "Connect Google"}
                </Button>
                {connected && (
                  <Button
                    variant="ghost"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                  >
                    {disconnect.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Unplug className="mr-2 h-4 w-4" />
                    )}
                    Disconnect
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Step 2 — pick the sync sheet */}
          <Card className={connected ? "" : "opacity-60"}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    2
                  </span>
                  Choose your sync sheet
                </CardTitle>
                {hasSheet && (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">
                    <Check className="mr-1 h-3 w-3" />
                    Sheet linked
                  </Badge>
                )}
              </div>
              <CardDescription>
                FlipDesk keeps one spreadsheet — &quot;FlipDesk Sync&quot; — in
                step with your inventory.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasSheet && connection?.sheet_url ? (
                <div className="flex flex-col gap-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <FileSpreadsheet className="h-4 w-4" />
                    Your FlipDesk Sync sheet is ready.
                  </span>
                  <Button asChild size="sm" variant="outline">
                    <a
                      href={connection.sheet_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open sheet
                    </a>
                  </Button>
                </div>
              ) : (
                <div className="rounded-lg border p-3">
                  <p className="text-sm font-medium">Create a new sync sheet</p>
                  <p className="mb-3 text-xs text-muted-foreground">
                    We&apos;ll make a fresh &quot;FlipDesk Sync&quot; spreadsheet
                    in your Drive — owned by you.
                  </p>
                  <Button
                    size="sm"
                    onClick={() => createSheet.mutate()}
                    disabled={!connected || createSheet.isPending}
                  >
                    {createSheet.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Create new sync sheet
                  </Button>
                </div>
              )}

              {/* Use existing — paste a link/id. Under drive.file, the app can
                  reach a sheet you select via the Drive Picker or one it
                  created; an arbitrary sheet you've never opened with FlipDesk
                  returns a clear "can't access" message from the server. */}
              <div className="rounded-lg border p-3">
                <Label htmlFor="existing-sheet" className="text-sm font-medium">
                  {hasSheet ? "Switch to a different sheet" : "Use an existing sheet"}
                </Label>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  Paste a Google Sheets link (or its id). Pick it with the Drive
                  Picker first so FlipDesk is granted access to just that file.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="existing-sheet"
                    placeholder="https://docs.google.com/spreadsheets/d/…"
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                    disabled={!connected}
                  />
                  <Button
                    variant="outline"
                    onClick={linkExisting}
                    disabled={!connected || useExisting.isPending || !existing.trim()}
                  >
                    {useExisting.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Use this sheet
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Optional: sync the seller's own tab via a column map (00433). */}
          <SheetMapCard />

          {/* Step 3 — live sync */}
          <Card className={connected && hasSheet ? "" : "opacity-60"}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    3
                  </span>
                  Live sync
                </CardTitle>
                {connection?.sync_status === "error" ? (
                  <Badge variant="destructive">
                    <AlertTriangle className="mr-1 h-3 w-3" />
                    Error
                  </Badge>
                ) : connection?.last_sync_at ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">
                    <Check className="mr-1 h-3 w-3" />
                    Syncing
                  </Badge>
                ) : null}
              </div>
              <CardDescription>
                Your sheet syncs both ways every 5 minutes. Edits to Title,
                Brand, Size, Status, Cost Basis, Target Price, SKU, and Notes
                flow back into FlipDesk; gray columns are read-only. When both
                sides change the same field, FlipDesk wins and the row is
                flagged in the Conflicts tab where you can choose Accept Sheet.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {connection?.last_sync_at && (
                <p className="text-sm text-muted-foreground">
                  Last synced{" "}
                  <span className="font-medium text-foreground">
                    {new Date(connection.last_sync_at).toLocaleString()}
                  </span>
                </p>
              )}
              {connection?.sync_status === "error" && connection.sync_error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {connection.sync_error}
                </p>
              )}
              <Button
                onClick={() => syncNow.mutate()}
                disabled={!connected || !hasSheet || syncNow.isPending}
              >
                {syncNow.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Sync now
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
