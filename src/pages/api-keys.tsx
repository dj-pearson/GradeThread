import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Key, Plus, Copy, Trash2, Check, Loader2, AlertTriangle, Crown, ShieldCheck, BookOpen, Code, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { edgeFetch } from "@/lib/edge-fetch";
import { ApiUsagePanel } from "@/components/api/api-usage-panel";
import { WhiteLabelPanel } from "@/components/api/white-label-panel";

interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ApiKeysPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Gate on the effective FlipDesk plan from the billing summary — the SAME
  // source of truth the backend enforces (plan-gate apiAccess, business-only).
  // The old `profile.plan` check used the legacy user_plan enum, which no longer
  // tracks the live FlipDesk plan, so paid resellers were mis-gated and a
  // downgrade wasn't reflected until refresh (US-796).
  const { plan, isLoading: planLoading } = usePlanUsage();
  const hasApiAccess = FLIPDESK_PLANS[plan]?.gateFlags.apiAccess ?? false;

  const { data: keys, isLoading } = useQuery<ApiKeyItem[]>({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const res = await edgeFetch("/api/keys");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to fetch" }));
        throw new Error(err.error || "Failed to fetch API keys");
      }
      const json = await res.json();
      return json.data as ApiKeyItem[];
    },
    enabled: hasApiAccess,
    staleTime: 5 * 60 * 1000,
  });

  async function handleCreate() {
    if (!newKeyName.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }

    setCreating(true);
    try {
      const body: Record<string, string> = { name: newKeyName.trim() };
      if (newKeyExpiry) {
        body.expires_at = new Date(newKeyExpiry).toISOString();
      }

      const res = await edgeFetch("/api/keys", {
        method: "POST",
        json: body,
      });

      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || "Failed to create API key");
        return;
      }

      setNewlyCreatedKey(json.data.full_key);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key created successfully");
    } catch {
      toast.error("Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeKeyId) return;

    setRevoking(true);
    try {
      const res = await edgeFetch(`/api/keys/${revokeKeyId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "Failed to revoke" }));
        toast.error(json.error || "Failed to revoke API key");
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key revoked successfully");
      setRevokeKeyId(null);
    } catch {
      toast.error("Failed to revoke API key");
    } finally {
      setRevoking(false);
    }
  }

  async function handleCopyKey() {
    if (!newlyCreatedKey) return;
    try {
      await navigator.clipboard.writeText(newlyCreatedKey);
      setCopied(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }

  function handleCreateDialogClose(open: boolean) {
    if (!open) {
      setNewKeyName("");
      setNewKeyExpiry("");
      setNewlyCreatedKey(null);
      setCopied(false);
    }
    setCreateOpen(open);
  }

  // Wait for the billing summary before deciding access, so we never flash the
  // upgrade gate at a user who actually has API access (US-796).
  if (planLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  // Plan gate: API access is a Business-plan feature.
  if (!hasApiAccess) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-muted-foreground">Manage your API keys for programmatic access.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-amber-100 p-4 dark:bg-amber-950/50">
              <Crown className="h-8 w-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">API Access Requires the Business Plan</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              API keys are available on the Business plan. Upgrade to access the GradeThread API
              for programmatic grading.
            </p>
            <Button
              className="mt-6"
              onClick={() => navigate("/dashboard/billing")}
            >
              View Plans
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get minimum date for expiry picker (tomorrow)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minExpiryDate = tomorrow.toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-muted-foreground">Manage your API keys for programmatic access.</p>
        </div>

        <Dialog open={createOpen} onOpenChange={handleCreateDialogClose}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Key
            </Button>
          </DialogTrigger>
          <DialogContent>
            {newlyCreatedKey ? (
              <>
                <DialogHeader>
                  <DialogTitle>API Key Created</DialogTitle>
                  <DialogDescription>
                    Copy your API key now. You won't be able to see it again.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 rounded-md border bg-muted p-3 font-mono text-sm break-all">
                      {newlyCreatedKey}
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyKey}
                      aria-label={copied ? "API key copied" : "Copy API key"}
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-sm text-amber-800 dark:text-amber-300">
                      Store this key securely. It will not be shown again. If you lose it,
                      you'll need to create a new key.
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => handleCreateDialogClose(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Create API Key</DialogTitle>
                  <DialogDescription>
                    Create a new API key for programmatic access to the GradeThread API.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                      id="key-name"
                      placeholder="e.g., Production Server"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      maxLength={100}
                    />
                    <p className="text-xs text-muted-foreground">
                      A descriptive name to help you identify this key.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="key-expiry">Expiration Date (optional)</Label>
                    <Input
                      id="key-expiry"
                      type="date"
                      value={newKeyExpiry}
                      onChange={(e) => setNewKeyExpiry(e.target.value)}
                      min={minExpiryDate}
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank for a non-expiring key. Expiring keys are recommended for security.
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => handleCreateDialogClose(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate} disabled={creating || !newKeyName.trim()}>
                    {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Key
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Your API Keys
          </CardTitle>
          <CardDescription>
            API keys allow you to access the GradeThread grading API directly.
            Keys are hashed and stored securely — the full key is only shown once at creation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !keys || keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Key className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No API keys</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create your first API key to get started with the GradeThread API.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-2 py-1 text-sm">
                        {key.key_prefix}...
                      </code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(key.created_at)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(key.last_used_at)}
                    </TableCell>
                    <TableCell>
                      {key.expires_at ? (
                        isExpired(key.expires_at) ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {formatDate(key.expires_at)}
                          </span>
                        )
                      ) : (
                        <span className="text-sm text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setRevokeKeyId(key.id)}
                        aria-label="Revoke API key"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Developer resources (US-596): docs, SDK, and the free sandbox. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Developer Resources
          </CardTitle>
          <CardDescription>
            Everything you need to integrate the GradeThread grading API.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Link
            to="/developers"
            className="flex items-start gap-3 rounded-lg border p-4 transition hover:bg-accent"
          >
            <BookOpen className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">API documentation</p>
              <p className="text-xs text-muted-foreground">
                Endpoints, auth, rate limits, quotas, and pricing.
              </p>
            </div>
          </Link>
          <div className="flex items-start gap-3 rounded-lg border p-4">
            <Code className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">JavaScript SDK</p>
              <p className="text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1">npm i @gradethread/sdk</code>
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-4">
            <FlaskConical className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">Free sandbox</p>
              <p className="text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1">/api/v1/sandbox/grades</code> — no credits.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Usage / billing dashboard (US-596). */}
      <ApiUsagePanel />

      {/* White-label embeddable results (US-596). */}
      <WhiteLabelPanel />

      {/* Revoke Confirmation Dialog */}
      <Dialog open={!!revokeKeyId} onOpenChange={(open) => !open && setRevokeKeyId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke this API key? Any applications using this key
              will immediately lose access. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeKeyId(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={revoking}>
              {revoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Revoke Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
