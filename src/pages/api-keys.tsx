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
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { Key, Plus, Copy, Trash2, Check, Loader2, AlertTriangle, Crown, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import type { UserPlan } from "@/types/database";

const EDGE_URL = import.meta.env.VITE_SUPABASE_URL
  ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, "")}`
  : "";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

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
  const { profile } = useAuth();
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

  const userPlan = (profile?.plan ?? "free") as UserPlan;
  const hasApiAccess = userPlan === "professional" || userPlan === "enterprise";

  const { data: keys, isLoading } = useQuery<ApiKeyItem[]>({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${EDGE_URL}/api/keys`, { headers });
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
      const headers = await getAuthHeaders();
      const body: Record<string, string> = { name: newKeyName.trim() };
      if (newKeyExpiry) {
        body.expires_at = new Date(newKeyExpiry).toISOString();
      }

      const res = await fetch(`${EDGE_URL}/api/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
      const headers = await getAuthHeaders();
      const res = await fetch(`${EDGE_URL}/api/keys/${revokeKeyId}`, {
        method: "DELETE",
        headers,
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

  // Plan gate: show upgrade prompt for Free/Starter
  if (!hasApiAccess) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-muted-foreground">Manage your API keys for programmatic access.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-amber-100 p-4">
              <Crown className="h-8 w-8 text-amber-600" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">API Access Requires an Upgrade</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              API keys are available on Professional and Enterprise plans. Upgrade your plan to
              access the GradeThread API for programmatic grading.
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
                    <Button variant="outline" size="icon" onClick={handleCopyKey}>
                      {copied ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <p className="text-sm text-amber-800">
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
