import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import { AlertTriangle, KeyRound, ShieldCheck, UserCog } from "lucide-react";

// US-908: granular RBAC scope management. View/edit which permission scopes each
// role holds, plus per-admin additive grants (give one admin a scope without
// changing their role). Reads are admin; mutations are super_admin + a fresh MFA
// step-up server-side (the page mirrors config-pricing.tsx's step-up runner).

interface PermissionScope {
  key: string;
  label: string;
  description: string;
  category: string;
}

interface RoleScopes {
  role: string;
  editable: boolean;
  scopes: string[];
}

interface ScopesResponse {
  scopes: PermissionScope[];
  roles: RoleScopes[];
}

interface UserScopesResponse {
  user: { id: string; email: string; role: string };
  role_scopes: string[];
  granted_scopes: string[];
  effective_scopes: string[];
}

function formatRole(role: string): string {
  if (role === "super_admin") return "Super Admin";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

// A clickable scope chip used for both role + per-admin editors.
function ScopeChip({
  scope,
  active,
  disabled,
  onToggle,
}: {
  scope: PermissionScope;
  active: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      title={scope.description}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-border bg-background text-muted-foreground hover:bg-muted"
      } ${disabled ? "cursor-default opacity-70" : "cursor-pointer"}`}
    >
      {scope.label}
    </button>
  );
}

export function AdminRolesPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  // Staged per-role edits (role → scope set). Empty until the operator toggles.
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});

  // Per-admin grant editor.
  const [lookupId, setLookupId] = useState("");
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [grantDraft, setGrantDraft] = useState<Set<string> | null>(null);

  const scopesQuery = useQuery({
    queryKey: ["admin-scopes"],
    queryFn: async (): Promise<ScopesResponse> => {
      const res = await edgeFetch("/api/admin/scopes");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load scopes.");
      return json;
    },
    staleTime: 60_000,
  });

  const userScopes = useQuery({
    queryKey: ["admin-user-scopes", activeUserId],
    enabled: !!activeUserId,
    queryFn: async (): Promise<UserScopesResponse> => {
      const res = await edgeFetch(`/api/admin/scopes/users/${encodeURIComponent(activeUserId!)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load admin scopes.");
      return json;
    },
  });

  const catalog = scopesQuery.data?.scopes ?? [];

  // Step-up-aware runner (mirrors AdminConfigPricingPage).
  async function run(doFetch: () => Promise<Response>, onOk: () => void) {
    setWorking(true);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Save failed");
        return;
      }
      onOk();
    } finally {
      setWorking(false);
    }
  }

  // Current scope set for a role: the staged draft if present, else the server value.
  function roleScopeSet(r: RoleScopes): Set<string> {
    return drafts[r.role] ?? new Set(r.scopes);
  }

  function toggleRoleScope(r: RoleScopes, scopeKey: string) {
    setDrafts((prev) => {
      const next = new Set(prev[r.role] ?? r.scopes);
      if (next.has(scopeKey)) next.delete(scopeKey);
      else next.add(scopeKey);
      return { ...prev, [r.role]: next };
    });
  }

  function roleDirty(r: RoleScopes): boolean {
    const draft = drafts[r.role];
    if (!draft) return false;
    const orig = new Set(r.scopes);
    if (draft.size !== orig.size) return true;
    for (const s of draft) if (!orig.has(s)) return true;
    return false;
  }

  function saveRole(r: RoleScopes) {
    const scopes = [...roleScopeSet(r)];
    run(
      () =>
        edgeFetch(`/api/admin/scopes/roles/${encodeURIComponent(r.role)}`, {
          method: "PUT",
          json: { scopes },
          silentGate: true,
        }),
      () => {
        toast.success(`Updated ${formatRole(r.role)} permissions`);
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[r.role];
          return next;
        });
        qc.invalidateQueries({ queryKey: ["admin-scopes"] });
      },
    );
  }

  function loadUser() {
    const id = lookupId.trim();
    if (!id) return;
    setGrantDraft(null);
    setActiveUserId(id);
  }

  const grantSet = useMemo(() => {
    if (grantDraft) return grantDraft;
    return new Set(userScopes.data?.granted_scopes ?? []);
  }, [grantDraft, userScopes.data]);

  function toggleGrant(scopeKey: string) {
    setGrantDraft(() => {
      const base = grantDraft ?? new Set(userScopes.data?.granted_scopes ?? []);
      const next = new Set(base);
      if (next.has(scopeKey)) next.delete(scopeKey);
      else next.add(scopeKey);
      return next;
    });
  }

  const grantsDirty = useMemo(() => {
    if (!grantDraft || !userScopes.data) return false;
    const orig = new Set(userScopes.data.granted_scopes);
    if (grantDraft.size !== orig.size) return true;
    for (const s of grantDraft) if (!orig.has(s)) return true;
    return false;
  }, [grantDraft, userScopes.data]);

  function saveGrants() {
    if (!activeUserId) return;
    const scopes = [...grantSet];
    run(
      () =>
        edgeFetch(`/api/admin/scopes/users/${encodeURIComponent(activeUserId)}`, {
          method: "PUT",
          json: { scopes },
          silentGate: true,
        }),
      () => {
        toast.success("Updated per-admin grants");
        setGrantDraft(null);
        qc.invalidateQueries({ queryKey: ["admin-user-scopes", activeUserId] });
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Roles &amp; Permissions</h1>
        <p className="text-muted-foreground">
          Scope-based admin permissions on top of the fixed roles.{" "}
          {isSuperAdmin
            ? "Edits apply across the fleet within ~60s — no deploy."
            : "Read-only for your role (super-admin required to edit)."}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Scopes are <strong>additive</strong> — they sit on top of the role and
          MFA gates, never replace them. <strong>Super Admin</strong> implicitly
          holds every scope and cannot be edited. The defaults match each role's
          existing permissions exactly.
        </span>
      </div>

      {scopesQuery.error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(scopesQuery.error as Error).message}
        </div>
      )}

      {/* Role → scopes matrix */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Role permissions
          </CardTitle>
          <CardDescription>
            Which permission scopes each role holds. Toggle a scope, then save the
            role.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {scopesQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            (scopesQuery.data?.roles ?? []).map((r) => {
              const set = roleScopeSet(r);
              const canEdit = isSuperAdmin && r.editable;
              return (
                <div key={r.role} className="rounded-lg border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{formatRole(r.role)}</span>
                      {!r.editable && (
                        <Badge variant="secondary" className="text-xs">all scopes</Badge>
                      )}
                    </div>
                    {canEdit && roleDirty(r) && (
                      <Button size="sm" disabled={working} onClick={() => saveRole(r)}>
                        {working ? "Saving…" : "Save"}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {catalog.map((scope) => (
                      <ScopeChip
                        key={scope.key}
                        scope={scope}
                        active={!r.editable || set.has(scope.key)}
                        disabled={!canEdit}
                        onToggle={canEdit ? () => toggleRoleScope(r, scope.key) : undefined}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Per-admin additive grants */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5" />
            Per-admin grants
          </CardTitle>
          <CardDescription>
            Grant a specific admin extra scopes beyond their role — e.g. give a
            support agent grading + support access without making them super-admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="admin-scope-lookup">Admin user ID</Label>
              <Input
                id="admin-scope-lookup"
                placeholder="user UUID"
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") loadUser(); }}
              />
            </div>
            <Button variant="outline" onClick={loadUser} disabled={!lookupId.trim()}>
              Load
            </Button>
          </div>

          {userScopes.isLoading && <Skeleton className="h-24 w-full" />}
          {userScopes.error && (
            <div className="text-sm text-red-600">{(userScopes.error as Error).message}</div>
          )}

          {userScopes.data && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{userScopes.data.user.email}</span>
                <Badge variant="secondary">{formatRole(userScopes.data.user.role)}</Badge>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  From role (always granted)
                </p>
                <div className="flex flex-wrap gap-2">
                  {catalog
                    .filter((s) => userScopes.data!.role_scopes.includes(s.key))
                    .map((s) => (
                      <ScopeChip key={s.key} scope={s} active disabled />
                    ))}
                  {userScopes.data.role_scopes.length === 0 && (
                    <span className="text-xs text-muted-foreground">None.</span>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    Additional grants
                  </p>
                  {isSuperAdmin && grantsDirty && (
                    <Button size="sm" disabled={working} onClick={saveGrants}>
                      {working ? "Saving…" : "Save grants"}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {catalog
                    // A scope already granted by the role can't be "added".
                    .filter((s) => !userScopes.data!.role_scopes.includes(s.key))
                    .map((s) => (
                      <ScopeChip
                        key={s.key}
                        scope={s}
                        active={grantSet.has(s.key)}
                        disabled={!isSuperAdmin}
                        onToggle={isSuperAdmin ? () => toggleGrant(s.key) : undefined}
                      />
                    ))}
                </div>
              </div>
            </div>
          )}
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
