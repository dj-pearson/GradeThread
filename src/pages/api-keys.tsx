import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion, TableLoadingSkeleton } from "@/components/ui/skeletons";
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
import { Key, Plus, Copy, Trash2, Check, Loader2, AlertTriangle, Crown, ShieldCheck, BookOpen, Code, FlaskConical, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { useAuth } from "@/hooks/use-auth";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { edgeFetch } from "@/lib/edge-fetch";
import { ApiUsagePanel } from "@/components/api/api-usage-panel";
import { ApiOverageCard } from "@/components/api/api-overage-card";
import { WhiteLabelPanel } from "@/components/api/white-label-panel";
import { ConnectedAppsPanel } from "@/components/api/connected-apps-panel";
import { HelpLink } from "@/components/help/help-link";

interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[] | null;
  last_used_at: string | null;
  last_rotated_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// The three scopes the backend enforces (lib/api-key.ts API_KEY_SCOPES). A key
// with no scopes selected can't do anything, so the create dialog defaults to
// all three and requires at least one.
const SCOPE_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  { value: "submit", label: "Submit", description: "Submit garments for grading (single + batch)" },
  { value: "read", label: "Read", description: "Read grade reports, usage, and the price guide" },
  { value: "webhook_manage", label: "Manage webhooks", description: "Set or clear the grade-completion webhook URL" },
];

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
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(SCOPE_OPTIONS.map((s) => s.value));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Rotation reuses the same "shown once" secret pattern as creation.
  const [rotateKey, setRotateKey] = useState<ApiKeyItem | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [rotatedCopied, setRotatedCopied] = useState(false);

  function toggleScope(value: string) {
    setNewKeyScopes((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }

  // Gate on the effective FlipDesk plan from the billing summary — the SAME
  // source of truth the backend enforces (plan-gate apiAccess, business-only).
  // The old `profile.plan` check used the legacy user_plan enum, which no longer
  // tracks the live FlipDesk plan, so paid resellers were mis-gated and a
  // downgrade wasn't reflected until refresh (US-796).
  const { plan, isLoading: planLoading } = usePlanUsage();
  const hasApiAccess = FLIPDESK_PLANS[plan]?.gateFlags.apiAccess ?? false;

  const { data: keys, isLoading } = useQuery<ApiKeyItem[]>({
    queryKey: ["api-keys", user?.id],
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

    if (newKeyScopes.length === 0) {
      toast.error("Select at least one scope");
      return;
    }

    setCreating(true);
    try {
      const body: Record<string, unknown> = { name: newKeyName.trim(), scopes: newKeyScopes };
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

  async function handleRotate() {
    if (!rotateKey) return;

    setRotating(true);
    try {
      const res = await edgeFetch(`/api/keys/${rotateKey.id}/rotate`, {
        method: "POST",
      });
      const json = await res.json();

      if (!res.ok) {
        toast.error(json.error || "Failed to rotate API key");
        return;
      }

      setRotatedKey(json.data.full_key);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key rotated — the old secret is now invalid");
    } catch {
      toast.error("Failed to rotate API key");
    } finally {
      setRotating(false);
    }
  }

  async function copyToClipboard(value: string | null, setFlag: (v: boolean) => void) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setFlag(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setFlag(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }

  async function handleCopyKey() {
    await copyToClipboard(newlyCreatedKey, setCopied);
  }

  function handleRotateDialogClose(open: boolean) {
    if (!open) {
      setRotateKey(null);
      setRotatedKey(null);
      setRotatedCopied(false);
    }
  }

  function handleCreateDialogClose(open: boolean) {
    if (!open) {
      setNewKeyName("");
      setNewKeyExpiry("");
      setNewKeyScopes(SCOPE_OPTIONS.map((s) => s.value));
      setNewlyCreatedKey(null);
      setCopied(false);
    }
    setCreateOpen(open);
  }

  // Wait for the billing summary before deciding access, so we never flash the
  // upgrade gate at a user who actually has API access (US-796).
  if (planLoading) {
    return (
      <LoadingRegion label="Loading API keys" className="space-y-6">
        <TableLoadingSkeleton rows={5} columns={4} className="rounded-lg border" />
      </LoadingRegion>
    );
  }

  // Plan gate: API access is a Business-plan feature.
  if (!hasApiAccess) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="API Keys"
          subtitle="Manage your API keys for programmatic access."
                  actions={<HelpLink slug="api-keys-and-the-sandbox" label="Help: API keys and the sandbox" />}
        />

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
              onClick={() => navigate("/dashboard/account?tab=billing")}
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
      <PageHeader
        title="API Keys"
        subtitle="Manage your API keys for programmatic access."
        actions={
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
                  <div className="space-y-2">
                    <Label>Scopes</Label>
                    <div className="space-y-2 rounded-md border p-3">
                      {SCOPE_OPTIONS.map((scope) => (
                        <label
                          key={scope.value}
                          htmlFor={`scope-${scope.value}`}
                          className="flex cursor-pointer items-start gap-3"
                        >
                          <Checkbox
                            id={`scope-${scope.value}`}
                            checked={newKeyScopes.includes(scope.value)}
                            onCheckedChange={() => toggleScope(scope.value)}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="block text-sm font-medium leading-none">{scope.label}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {scope.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Grant only the scopes this key needs. Read is required to poll grade results.
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => handleCreateDialogClose(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={creating || !newKeyName.trim() || newKeyScopes.length === 0}
                  >
                    {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Key
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
          </Dialog>
        }
      />

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
            <EmptyState
              icon={Key}
              title="No API keys"
              description="Create your first key to call the grading API. The full key is shown once, at creation."
              action={{ label: "Create a key", onClick: () => setCreateOpen(true) }}
            />
          ) : (
            /* Seven columns on a phone: without the wrapper the row is
               clipped and the revoke button is unreachable, which is how a
               leaked key stays live. */
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-[100px]" />
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
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(key.scopes ?? SCOPE_OPTIONS.map((s) => s.value)).map((s) => (
                          <Badge key={s} variant="secondary" className="text-xs font-normal">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(key.created_at)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(key.last_used_at)}
                      {key.last_rotated_at && (
                        <span className="block text-xs text-muted-foreground/70">
                          Rotated {formatDate(key.last_rotated_at)}
                        </span>
                      )}
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
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setRotateKey(key)}
                          aria-label={`Rotate the ${key.name} API key`}
                          title="Rotate — issue a new secret, invalidate the old one"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRevokeKeyId(key.id)}
                          aria-label={`Revoke the ${key.name} API key`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
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
          {/* US-2554: these two were non-interactive divs styled exactly like
              the link beside them. Both have a real destination — /developers
              documents the SDK and the sandbox — so the fix is to make them
              behave the way they already looked. */}
          <Link
            to="/developers#sdk"
            className="flex items-start gap-3 rounded-lg border p-4 transition hover:bg-accent"
          >
            <Code className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">JavaScript SDK</p>
              <p className="text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1">npm i @gradethread/sdk</code>
              </p>
            </div>
          </Link>
          <Link
            to="/developers#sandbox"
            className="flex items-start gap-3 rounded-lg border p-4 transition hover:bg-accent"
          >
            <FlaskConical className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">Free sandbox</p>
              <p className="text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1">/api/v1/sandbox/grades</code> — no credits.
              </p>
            </div>
          </Link>
        </CardContent>
      </Card>

      {/* US-9122: apps a seller has allowed to act on their account. Here
          rather than on a page of its own, because "what can reach my
          account" is one question and answering it twice means one answer
          gets forgotten. Renders nothing when nothing is connected. */}
      <ConnectedAppsPanel />

      {/* Usage / billing dashboard (US-596). */}
      <ApiUsagePanel />

      {/* API overage credits (US-1792). */}
      <ApiOverageCard />

      {/* White-label embeddable results (US-596). */}
      <WhiteLabelPanel />

      {/* Rotate Dialog (US-1793): confirm, then show the new secret once. */}
      <Dialog open={!!rotateKey} onOpenChange={handleRotateDialogClose}>
        <DialogContent>
          {rotatedKey ? (
            <>
              <DialogHeader>
                <DialogTitle>API Key Rotated</DialogTitle>
                <DialogDescription>
                  Copy your new API key now. The previous secret is now invalid.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex-1 rounded-md border bg-muted p-3 font-mono text-sm break-all">
                    {rotatedKey}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(rotatedKey, setRotatedCopied)}
                    aria-label={rotatedCopied ? "API key copied" : "Copy API key"}
                  >
                    {rotatedCopied ? (
                      <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    Update every application using this key. The old secret stopped working the
                    moment you rotated. The key's name and scopes are unchanged.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => handleRotateDialogClose(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Rotate API Key</DialogTitle>
                <DialogDescription>
                  Issue a new secret for "{rotateKey?.name}", keeping its name and scopes. The
                  current secret stops working immediately. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handleRotateDialogClose(false)}
                  disabled={rotating}
                >
                  Cancel
                </Button>
                <Button onClick={handleRotate} disabled={rotating}>
                  {rotating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Rotate Key
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

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
