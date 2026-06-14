import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollText, Loader2, Upload, ShieldAlert, Users } from "lucide-react";

// US-904: Legal/ToS version manager. Publish a new Terms/Privacy version and
// (optionally) force re-acceptance; track who is on the current version. All
// reads/writes go through the admin-MFA-gated /api/admin/compliance/legal
// endpoints; publishing additionally requires super_admin + a fresh MFA step-up.

type DocKind = "tos" | "privacy";

interface LegalDocument {
  id: string;
  kind: DocKind;
  version: string;
  effective_date: string;
  url: string | null;
  body: string | null;
  requires_reacceptance: boolean;
  published_at: string;
  published_by: string | null;
  published_by_email: string | null;
  created_at: string;
}

interface LegalResponse {
  documents: LegalDocument[];
  current: { tos: string; privacy: string };
  required_since: { tos: string; privacy: string };
  coverage: { total_active: number; on_current: number; coverage_pct: number };
}

const KIND_LABEL: Record<DocKind, string> = {
  tos: "Terms of Service",
  privacy: "Privacy Policy",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

export function AdminLegalPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);

  // Publish-form state.
  const [kind, setKind] = useState<DocKind>("tos");
  const [version, setVersion] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [url, setUrl] = useState("");
  const [requiresReacceptance, setRequiresReacceptance] = useState(true);

  const query = useQuery({
    queryKey: ["admin-legal"],
    queryFn: async (): Promise<LegalResponse> => {
      const res = await edgeFetch("/api/admin/compliance/legal", {
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((json as { error?: string }).error ?? "Failed to load");
      }
      return json as LegalResponse;
    },
  });

  function handleStepUp(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  async function publish() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(version.trim())) {
      toast.error("Version must be a date in YYYY-MM-DD format.");
      return;
    }
    setBusy(true);
    try {
      const res = await edgeFetch("/api/admin/compliance/legal", {
        method: "POST",
        silentGate: true,
        json: {
          kind,
          version: version.trim(),
          effective_date: effectiveDate.trim() || version.trim(),
          url: url.trim() || undefined,
          requires_reacceptance: requiresReacceptance,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403 && (json as { code?: string })?.code === "STEP_UP_REQUIRED") {
        handleStepUp(() => void publish());
        return;
      }
      if (!res.ok) {
        toast.error((json as { error?: string })?.error ?? "Failed to publish");
        return;
      }
      toast.success(
        requiresReacceptance
          ? "Version published — users will be prompted to re-accept."
          : "Version published.",
      );
      setVersion("");
      setEffectiveDate("");
      setUrl("");
      void query.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to publish");
    } finally {
      setBusy(false);
    }
  }

  const data = query.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ScrollText className="h-6 w-6 text-brand-red" />
          Legal &amp; Terms versions
        </h1>
        <p className="text-sm text-muted-foreground">
          Publish a new Terms of Service or Privacy Policy version. Flagging it
          for re-acceptance prompts every affected user to re-accept on their next
          visit; every acceptance is recorded for audit.
        </p>
      </div>

      {/* Current versions + coverage */}
      {query.isLoading
        ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        )
        : data
        ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Terms of Service</CardDescription>
                <CardTitle className="text-xl">{data.current.tos}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Re-acceptance required since {data.required_since.tos}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Current Privacy Policy</CardDescription>
                <CardTitle className="text-xl">{data.current.privacy}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Re-acceptance required since {data.required_since.privacy}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  Acceptance coverage
                </CardDescription>
                <CardTitle className="text-xl">{data.coverage.coverage_pct}%</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {data.coverage.on_current.toLocaleString()} of{" "}
                {data.coverage.total_active.toLocaleString()} active users on the
                current versions
              </CardContent>
            </Card>
          </div>
        )
        : (
          <Card>
            <CardContent className="p-6 text-sm text-destructive">
              {query.error instanceof Error
                ? query.error.message
                : "Failed to load legal documents."}
            </CardContent>
          </Card>
        )}

      {/* Publish a new version (super_admin + step-up) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Publish a new version</CardTitle>
          <CardDescription>
            Versions use the document's effective date (YYYY-MM-DD). Publishing is
            restricted to super admins and requires re-verifying your second
            factor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isSuperAdmin && (
            <div className="flex items-center gap-2 rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <ShieldAlert className="h-4 w-4 flex-shrink-0" />
              Only super admins can publish a legal version.
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Document</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as DocKind)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tos">Terms of Service</SelectItem>
                  <SelectItem value="privacy">Privacy Policy</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="legal-version">Version (YYYY-MM-DD)</Label>
              <Input
                id="legal-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="2026-07-01"
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="legal-effective">Effective date</Label>
              <Input
                id="legal-effective"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                placeholder="(defaults to version)"
                className="w-44"
              />
            </div>
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label htmlFor="legal-url">Document URL (optional)</Label>
              <Input
                id="legal-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="/terms"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={requiresReacceptance}
              onChange={(e) => setRequiresReacceptance(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-brand-red"
            />
            Force re-acceptance (uncheck for a minor, non-material edit)
          </label>
          <Button onClick={publish} disabled={!isSuperAdmin || busy}>
            {busy
              ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              : <Upload className="mr-1 h-4 w-4" />}
            Publish version
          </Button>
        </CardContent>
      </Card>

      {/* Published version history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Published versions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Re-acceptance</TableHead>
                <TableHead>Published</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.documents ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{KIND_LABEL[d.kind]}</TableCell>
                  <TableCell className="font-medium">{d.version}</TableCell>
                  <TableCell>{d.effective_date}</TableCell>
                  <TableCell>
                    {d.requires_reacceptance
                      ? <Badge variant="secondary" className="bg-brand-red/15 text-brand-red-text">Forced</Badge>
                      : <Badge variant="secondary">Minor</Badge>}
                  </TableCell>
                  <TableCell>{fmtDate(d.published_at)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.published_by_email ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {data && data.documents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No versions published yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
