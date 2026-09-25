import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
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
import { useWorkspace } from "@/hooks/use-workspace";
import { useTenantKey } from "@/hooks/use-tenant-key";
import { useApiUsage } from "@/hooks/use-api-usage";
import { roleNeededNote } from "@/lib/workspace-permissions";
import { endOfLocalDayIso, localYmd } from "@/lib/utils";
import { edgeFetch } from "@/lib/edge-fetch";
import { ApiUsagePanel } from "@/components/api/api-usage-panel";
import { ApiOverageCard } from "@/components/api/api-overage-card";
import { WhiteLabelPanel } from "@/components/api/white-label-panel";
import { ConnectedAppsPanel } from "@/components/api/connected-apps-panel";
import { WebhookPanel } from "@/components/api/webhook-panel";
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

const ALL_SCOPES = SCOPE_OPTIONS.map((s) => s.value);

const EXPIRY_PRESETS = [30, 90, 365];

const PAGE_TITLE = "Developers";
const PAGE_SUBTITLE = "API keys, webhooks, usage and embeds for your own code";

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

function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

function formatYmd(ymd: string): string {
  const iso = endOfLocalDayIso(ymd);
  return iso ? formatDate(iso) : ymd;
}

const helpLink = <HelpLink slug="api-keys-and-the-sandbox" label="Help: API keys and the sandbox" />;

export function ApiKeysPage() {
  // DEV-03: members below admin cannot manage keys or the webhook, and every
  // route here answers them 403. Showing them a wall of "Couldn't load" and a
  // live Create button was a set of false failures; one plain line replaces it,
  // and no query mounts.
  const { can } = useWorkspace();
  if (!can("manage_api_keys")) {
    return (
      <div className="space-y-6">
        <PageHeader title={PAGE_TITLE} subtitle={PAGE_SUBTITLE} actions={helpLink} />
        <p className="text-sm text-muted-foreground">
          {roleNeededNote("manage_api_keys", "manage API keys and webhooks")} Ask your workspace
          owner if you need access.
        </p>
      </div>
    );
  }
  return <DevelopersConsole />;
}

type CreatedSecret = { name: string; secret: string };
type RotatedSecret = { keyId: string; name: string; prefix: string; secret: string };

function DevelopersConsole() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantKey = useTenantKey();
  const { isOwner } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeKey, setRevokeKey] = useState<ApiKeyItem | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(ALL_SCOPES);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // DEV-02: a shown-once secret is stored WITH the key it belongs to, so a
  // late answer can never be shown under another key's name.
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [copied, setCopied] = useState(false);
  const [createdSaved, setCreatedSaved] = useState(false);
  const [rotateKey, setRotateKey] = useState<ApiKeyItem | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState<RotatedSecret | null>(null);
  const [rotatedCopied, setRotatedCopied] = useState(false);
  const [rotatedSaved, setRotatedSaved] = useState(false);
  // Each request takes a ticket. A response whose ticket no longer matches the
  // open dialog is from a dialog that has since closed, and is dropped.
  const createTicket = useRef(0);
  const rotateTicket = useRef(0);

  function toggleScope(value: string) {
    setNewKeyScopes((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }

  // DEV-03: gate on the workspace OWNER's plan, which is what every key route
  // enforces, as reported by /api/keys/usage. The viewer's own plan says
  // nothing about the workspace they are acting in.
  const usage = useApiUsage();
  const hasApiAccess = usage.data?.api_access === true;

  const {
    data: keys,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery<ApiKeyItem[]>({
    queryKey: ["api-keys", tenantKey],
    queryFn: async () => {
      const res = await edgeFetch("/api/keys");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to fetch" }));
        throw new Error(err.error || "Failed to fetch API keys");
      }
      const json = await res.json();
      return json.data as ApiKeyItem[];
    },
    enabled: hasApiAccess && Boolean(tenantKey),
    staleTime: 5 * 60 * 1000,
  });

  async function handleCreate(e?: FormEvent) {
    e?.preventDefault();
    if (creating) return;
    if (!newKeyName.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }

    if (newKeyScopes.length === 0) {
      toast.error("Select at least one scope");
      return;
    }

    const ticket = ++createTicket.current;
    const name = newKeyName.trim();
    setCreating(true);
    try {
      const body: Record<string, unknown> = { name, scopes: newKeyScopes };
      if (newKeyExpiry) {
        const expiresAt = endOfLocalDayIso(newKeyExpiry);
        if (!expiresAt) {
          toast.error("Pick a valid expiry date");
          return;
        }
        body.expires_at = expiresAt;
      }

      const res = await edgeFetch("/api/keys", {
        method: "POST",
        json: body,
      });

      const json = await res.json();
      if (ticket !== createTicket.current) return;

      if (!res.ok) {
        toast.error(json.error || "Failed to create API key");
        return;
      }

      setCreated({ name, secret: json.data.full_key });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key created successfully");
    } catch {
      if (ticket === createTicket.current) toast.error("Failed to create API key");
    } finally {
      if (ticket === createTicket.current) setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeKey) return;

    setRevoking(true);
    try {
      const res = await edgeFetch(`/api/keys/${revokeKey.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "Failed to revoke" }));
        toast.error(json.error || "Failed to revoke API key");
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key revoked successfully");
      setRevokeKey(null);
    } catch {
      toast.error("Failed to revoke API key");
    } finally {
      setRevoking(false);
    }
  }

  async function handleRotate() {
    if (!rotateKey || rotating) return;
    const target = rotateKey;
    const ticket = ++rotateTicket.current;
    setRotated(null);
    setRotating(true);
    try {
      const res = await edgeFetch(`/api/keys/${target.id}/rotate`, {
        method: "POST",
      });
      const json = await res.json();
      if (ticket !== rotateTicket.current) return;

      if (!res.ok) {
        toast.error(json.error || "Failed to rotate API key");
        return;
      }

      setRotated({
        keyId: target.id,
        name: target.name,
        prefix: json.data.key_prefix ?? target.key_prefix,
        secret: json.data.full_key,
      });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key rotated. The old secret no longer works.");
    } catch {
      if (ticket === rotateTicket.current) toast.error("Failed to rotate API key");
    } finally {
      if (ticket === rotateTicket.current) setRotating(false);
    }
  }

  async function copyToClipboard(
    value: string | null | undefined,
    setFlag: (v: boolean) => void,
    setSaved: (v: boolean) => void,
  ) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setFlag(true);
      setSaved(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setFlag(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }

  // The rotated secret only shows under the key it was issued for.
  const rotatedForOpenKey = rotated && rotateKey && rotated.keyId === rotateKey.id ? rotated : null;

  // DEV-02: while a request is running, or a secret is on screen and not yet
  // saved, Escape, an overlay click and the corner X all do nothing. The only
  // copy of a secret is not something a stray click should throw away.
  const rotateLocked = rotating || (rotatedForOpenKey !== null && !rotatedSaved);
  const createLocked = creating || (created !== null && !createdSaved);

  function handleRotateDialogClose(open: boolean) {
    if (open) return;
    if (rotating) return;
    if (rotatedForOpenKey && !rotatedSaved) return;
    rotateTicket.current++;
    setRotateKey(null);
    setRotated(null);
    setRotatedCopied(false);
    setRotatedSaved(false);
  }

  function handleCreateDialogClose(open: boolean) {
    if (!open) {
      if (creating) return;
      if (created && !createdSaved) return;
      createTicket.current++;
      setNewKeyName("");
      setNewKeyExpiry("");
      setNewKeyScopes(ALL_SCOPES);
      setCreated(null);
      setCopied(false);
      setCreatedSaved(false);
    }
    setCreateOpen(open);
  }

  // DEV-06: an expired key cannot be rotated back to life (rotation keeps the
  // expiry). Replace opens Create with the same name and scopes instead.
  function openReplace(key: ApiKeyItem) {
    setNewKeyName(key.name);
    setNewKeyScopes(key.scopes ?? ALL_SCOPES);
    setNewKeyExpiry("");
    setCreateOpen(true);
  }

  // Minimum pickable expiry: tomorrow, in the seller's own time zone.
  const minExpiryDate = daysFromToday(1);

  const createDialog = (
    <Dialog open={createOpen} onOpenChange={handleCreateDialogClose}>
      <Button onClick={() => setCreateOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        Create Key
      </Button>
      <DialogContent
        showCloseButton={!createLocked}
        onEscapeKeyDown={(e) => { if (createLocked) e.preventDefault(); }}
        onInteractOutside={(e) => { if (createLocked) e.preventDefault(); }}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created: {created.name}</DialogTitle>
              <DialogDescription>
                Copy your API key now. You won't be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-md border bg-muted p-3 font-mono text-sm break-all">
                  {created.secret}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(created.secret, setCopied, setCreatedSaved)}
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
              <label htmlFor="created-saved" className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  id="created-saved"
                  checked={createdSaved}
                  onCheckedChange={(v) => setCreatedSaved(v === true)}
                />
                I saved this key
              </label>
            </div>
            <DialogFooter>
              <Button onClick={() => handleCreateDialogClose(false)} disabled={!createdSaved}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleCreate} className="grid gap-4">
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
                  autoFocus
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
                <div className="flex flex-wrap gap-2">
                  {EXPIRY_PRESETS.map((days) => (
                    <Button
                      key={days}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setNewKeyExpiry(daysFromToday(days))}
                    >
                      {days} days
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {newKeyExpiry
                    ? `Expires at the end of ${formatYmd(newKeyExpiry)}, your time.`
                    : "Leave blank for a non-expiring key. Expiring keys are recommended for security."}
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
              <Button
                type="button"
                variant="outline"
                onClick={() => handleCreateDialogClose(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creating || !newKeyName.trim() || newKeyScopes.length === 0}
              >
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      subtitle={PAGE_SUBTITLE}
      actions={hasApiAccess ? <>{helpLink}{createDialog}</> : helpLink}
    />
  );

  // Wait for the owner's plan before deciding, so a Business workspace never
  // flashes the upgrade gate (US-796). The header stays put while it loads.
  if (usage.isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <LoadingRegion label="Loading API keys" className="space-y-6">
          <TableLoadingSkeleton rows={5} columns={4} className="rounded-lg border" />
        </LoadingRegion>
      </div>
    );
  }

  // A failed plan check is not "you are on Free". Paying customers were shown
  // the upgrade wall whenever the billing read failed.
  if (usage.isError || !usage.data) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Couldn't check your workspace plan"
          description="We could not tell whether this workspace has API access. Your keys and webhook are unaffected."
          onRetry={() => void usage.refetch()}
          retrying={usage.isFetching}
        />
      </div>
    );
  }

  // Plan gate: API access is a Business-plan feature of the WORKSPACE.
  if (!hasApiAccess) {
    return (
      <div className="space-y-6">
        {header}

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-amber-100 p-4 dark:bg-amber-950/50">
              <Crown className="h-8 w-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">API access needs the Business plan</h3>
            {isOwner ? (
              <>
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
              </>
            ) : (
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                This workspace is not on Business. Ask the owner to upgrade.
              </p>
            )}
          </CardContent>
        </Card>

        {/* DEV-04: connected apps are a security control, not an upsell.
            Connector access starts below Business, and a downgrade leaves
            grants live, so the list and its Disconnect stay visible here. */}
        <ConnectedAppsPanel />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            API keys
          </CardTitle>
          <CardDescription>
            API keys allow you to access the GradeThread grading API directly.
            Keys are hashed and stored securely. The full key is only shown once, at creation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* US-3237: a failed read leaves `keys` undefined, which is exactly
              what having none looks like -- and "No API keys" reads to a
              developer as keys that were revoked, whose obvious next move is
              to mint a duplicate. */}
          {isError ? (
            <ErrorState
              title="Couldn't load your API keys"
              description="The list didn't load. Your existing keys are unaffected; don't create a replacement until this loads."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          ) : isLoading ? (
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
                {keys.map((key) => {
                  const expired = isExpired(key.expires_at);
                  return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-2 py-1 text-sm">
                        {key.key_prefix}...
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(key.scopes ?? ALL_SCOPES).map((s) => (
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
                        expired ? (
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
                        {expired ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openReplace(key)}
                            aria-label={`Replace the expired ${key.name} API key`}
                          >
                            Replace
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setRotated(null);
                              setRotatedSaved(false);
                              setRotateKey(key);
                            }}
                            aria-label={`Rotate the ${key.name} API key`}
                            title="Rotate: issue a new secret and invalidate the old one"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRevokeKey(key)}
                          aria-label={`Revoke the ${key.name} API key`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
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
              the link beside them. Both have a real destination: /developers
              documents the SDK and the sandbox, so the fix is to make them
              behave the way they already looked. */}
          <Link
            to="/developers#sdk"
            className="flex items-start gap-3 rounded-lg border p-4 transition hover:bg-accent"
          >
            <Code className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">JavaScript SDK</p>
              <p className="text-xs text-muted-foreground">
                Typed Node and browser client. Build it from the repo.
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
                <code className="rounded bg-muted px-1">/api/v1/sandbox/grades</code> spends no credits.
              </p>
            </div>
          </Link>
        </CardContent>
      </Card>

      {/* The account webhook: URL, test send, delivery log, signing secret. */}
      <WebhookPanel />

      {/* Usage / billing dashboard (US-596). */}
      <ApiUsagePanel />

      {/* US-9122: apps a seller has allowed to act on their account. Here
          rather than on a page of its own, because "what can reach my
          account" is one question and answering it twice means one answer
          gets forgotten. Renders nothing when nothing is connected. */}
      <ConnectedAppsPanel />

      {/* API overage credits (US-1792). Hidden until a key has a quota. */}
      <ApiOverageCard />

      {/* White-label embeddable results (US-596). */}
      <WhiteLabelPanel />

      {/* Rotate Dialog (US-1793): confirm, then show the new secret once. */}
      <Dialog open={!!rotateKey} onOpenChange={handleRotateDialogClose}>
        <DialogContent
          showCloseButton={!rotateLocked}
          onEscapeKeyDown={(e) => { if (rotateLocked) e.preventDefault(); }}
          onInteractOutside={(e) => { if (rotateLocked) e.preventDefault(); }}
        >
          {rotatedForOpenKey ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  API key rotated: {rotatedForOpenKey.name} ({rotatedForOpenKey.prefix}...)
                </DialogTitle>
                <DialogDescription>
                  Copy the new secret for "{rotatedForOpenKey.name}" now. The previous secret is now invalid.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex-1 rounded-md border bg-muted p-3 font-mono text-sm break-all">
                    {rotatedForOpenKey.secret}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(rotatedForOpenKey.secret, setRotatedCopied, setRotatedSaved)}
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
                <label htmlFor="rotated-saved" className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    id="rotated-saved"
                    checked={rotatedSaved}
                    onCheckedChange={(v) => setRotatedSaved(v === true)}
                  />
                  I saved this key
                </label>
              </div>
              <DialogFooter>
                <Button onClick={() => handleRotateDialogClose(false)} disabled={!rotatedSaved}>
                  Done
                </Button>
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

      {/* Revoke Confirmation Dialog. Revoke is a permanent delete, so the
          dialog names the exact key rather than "this API key". */}
      <Dialog open={!!revokeKey} onOpenChange={(open) => { if (!open && !revoking) setRevokeKey(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
            <DialogDescription>
              Revoke "{revokeKey?.name}" ({revokeKey?.key_prefix}...)? Apps using it stop working
              right away. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeKey && (
            <p className="text-sm text-muted-foreground">
              Last used: {revokeKey.last_used_at ? formatDateTime(revokeKey.last_used_at) : "never"}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeKey(null)} disabled={revoking}>
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
