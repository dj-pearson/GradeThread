import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Loader2,
  Mail,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { InviteMemberDialog } from "@/components/team/invite-member-dialog";
import {
  ASSIGNABLE_WORKSPACE_ROLES,
  WORKSPACE_ROLE_LABEL,
} from "@/lib/workspace-permissions";
import type {
  WorkspaceInvitationRow,
  WorkspaceMemberRow,
  WorkspaceRole,
} from "@/types/database";

interface MemberWithProfile extends WorkspaceMemberRow {
  member_email: string;
  member_name: string | null;
}

export function TeamPage() {
  const { user, profile } = useAuth();
  const { workspaceOwnerId, role, can, isPersonal, isOwner } = useWorkspace();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [lastInvite, setLastInvite] = useState<
    | { inviteUrl: string; emailSent: boolean }
    | null
  >(null);
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null);

  // Only the owner of the workspace can manage members. Admins can VIEW
  // members but cannot promote/demote (RLS allows update only by owner).
  const canManage = can("manage_members");
  const canSeeBilling = can("manage_billing");

  const membersQuery = useQuery({
    queryKey: ["workspace-members", workspaceOwnerId],
    queryFn: async (): Promise<MemberWithProfile[]> => {
      if (!workspaceOwnerId) return [];
      const { data: rawMembers, error } = await supabase
        .from("workspace_members")
        .select("*")
        .eq("owner_id", workspaceOwnerId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const members = (rawMembers ?? []) as unknown as WorkspaceMemberRow[];
      if (members.length === 0) return [];
      const ids = members.map((m) => m.member_id);
      const { data: rawProfiles } = await supabase
        .from("users")
        .select("id, email, full_name")
        .in("id", ids);
      const profiles = (rawProfiles ?? []) as unknown as Array<{
        id: string;
        email: string;
        full_name: string | null;
      }>;
      const map = new Map(profiles.map((p) => [p.id, p] as const));
      return members.map((m) => ({
        ...m,
        member_email: map.get(m.member_id)?.email ?? "",
        member_name: map.get(m.member_id)?.full_name ?? null,
      }));
    },
    enabled: !!workspaceOwnerId,
  });

  const invitesQuery = useQuery({
    queryKey: ["workspace-invitations", workspaceOwnerId],
    queryFn: async (): Promise<WorkspaceInvitationRow[]> => {
      if (!workspaceOwnerId) return [];
      const { data, error } = await supabase
        .from("workspace_invitations")
        .select("*")
        .eq("owner_id", workspaceOwnerId)
        .is("accepted_at", null)
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as WorkspaceInvitationRow[];
      return rows.filter((i) => new Date(i.expires_at) > new Date());
    },
    enabled: !!workspaceOwnerId && canManage,
  });

  useEffect(() => {
    // Auto-clear the "copy invite link" banner after 60s.
    if (!lastInvite) return;
    const t = setTimeout(() => setLastInvite(null), 60_000);
    return () => clearTimeout(t);
  }, [lastInvite]);

  useEffect(() => {
    // Refresh the pending invitations list whenever a new invite is created.
    if (lastInvite) {
      queryClient.invalidateQueries({
        queryKey: ["workspace-invitations", workspaceOwnerId],
      });
    }
  }, [lastInvite, queryClient, workspaceOwnerId]);

  // US-799: role changes + removals go through audited, server-enforced edge
  // endpoints (role cap, owner protection, last-admin guard, audit log) instead
  // of a direct workspace_members RLS write from the browser.
  async function updateRole(memberId: string, newRole: WorkspaceRole) {
    if (!workspaceOwnerId) return;
    const res = await edgeFetch(`/api/workspace/members/${memberId}/role`, {
      method: "PATCH",
      json: { role: newRole },
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(data.error ?? "Couldn't update that member's role.");
      return;
    }
    toast.success("Role updated");
    queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceOwnerId] });
  }

  async function removeMember(memberId: string) {
    if (!workspaceOwnerId) return;
    const res = await edgeFetch(`/api/workspace/members/${memberId}/remove`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(data.error ?? "Couldn't remove that member.");
      return;
    }
    toast.success("Member removed");
    queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceOwnerId] });
  }

  async function revokeInvitation(id: string) {
    const { error } = await supabase
      .from("workspace_invitations")
      .update({ revoked_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Invitation revoked");
    queryClient.invalidateQueries({ queryKey: ["workspace-invitations", workspaceOwnerId] });
  }

  async function copyInviteLink(token: string) {
    const url = `${window.location.origin}/accept-invite?token=${token}`;
    // clipboard.writeText throws in denied-permission / insecure-origin contexts
    // — guard it so the page doesn't crash on an unhandled rejection (US-798).
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      toast.error("Couldn't copy — copy the link manually from the address bar.");
    }
  }

  async function resendInvitation(id: string) {
    const res = await edgeFetch(`/api/workspace/invitations/${id}/resend`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as {
      email_sent?: boolean;
      error?: string;
    };
    if (!res.ok) {
      toast.error(data.error || "Could not resend invitation");
      return;
    }
    if (data.email_sent) {
      toast.success("Invitation email resent");
    } else {
      toast.warning(
        "Email service failed — share the invite link manually for now",
      );
    }
  }

  // If you're a member viewing someone else's workspace, you can't see the
  // owner's team — only owners/admins of THAT workspace can. Show a
  // read-only banner with your own role.
  if (!isPersonal && !canManage) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Team</h1>
          <p className="text-muted-foreground">
            You're a {WORKSPACE_ROLE_LABEL[role ?? "viewer"]} in this workspace.
          </p>
        </div>
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Only the workspace owner and admins can manage team members.
          </CardContent>
        </Card>
      </div>
    );
  }

  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Team</h1>
          <p className="text-muted-foreground">
            Invite teammates and manage their access to your workspace.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite member
          </Button>
        )}
      </div>

      {lastInvite && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <Mail className="h-4 w-4 text-primary" />
            <span className="text-sm">
              {lastInvite.emailSent
                ? "Invitation sent. Backup link in case it doesn't arrive:"
                : "Invitation created — email delivery failed. Share this link manually:"}
            </span>
            <code className="flex-1 min-w-[200px] truncate rounded bg-background px-2 py-1 text-xs">
              {lastInvite.inviteUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(lastInvite.inviteUrl);
                toast.success("Copied");
              }}
            >
              <Copy className="mr-2 h-4 w-4" /> Copy
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Members
          </CardTitle>
          <CardDescription>
            The Owner always has full access and can&apos;t be removed or
            demoted. Admins can change roles and remove members.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* The owner row — synthetic, not in workspace_members. */}
              <TableRow>
                <TableCell>
                  <div className="font-medium">
                    {profile?.full_name || profile?.email || "You"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {profile?.email}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="default">
                    {WORKSPACE_ROLE_LABEL.owner}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  Workspace owner
                </TableCell>
                <TableCell />
              </TableRow>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">
                      {m.member_name || m.member_email}
                    </div>
                    {m.member_name && (
                      <div className="text-xs text-muted-foreground">
                        {m.member_email}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <Select
                        value={m.role}
                        onValueChange={(v) => updateRole(m.member_id, v as WorkspaceRole)}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_WORKSPACE_ROLES.map((r) => (
                            <SelectItem key={r} value={r}>
                              {WORKSPACE_ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary">
                        {WORKSPACE_ROLE_LABEL[m.role]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(m.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {canManage && m.member_id !== user?.id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRemoveMemberId(m.member_id)}
                        aria-label="Remove member"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                    No additional members yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isOwner && <WorkspaceMfaPolicyCard ownerId={workspaceOwnerId} />}

      {canManage && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>
              These haven't been accepted yet. Copy the link to share it
              again, or revoke if no longer needed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {WORKSPACE_ROLE_LABEL[inv.role]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resendInvitation(inv.id)}
                          title="Resend invitation email"
                        >
                          <Send className="mr-1 h-3.5 w-3.5" />
                          Resend
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyInviteLink(inv.token)}
                        >
                          <Copy className="mr-1 h-3.5 w-3.5" />
                          Copy link
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => revokeInvitation(inv.id)}
                          aria-label="Revoke invitation"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {canManage && !canSeeBilling && (
        <p className="text-xs text-muted-foreground">
          Note: only the workspace owner can manage billing. Admins can manage
          members, marketplaces, and API keys but not subscriptions.
        </p>
      )}

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={setLastInvite}
      />

      <AlertDialog
        open={!!removeMemberId}
        onOpenChange={(open) => !open && setRemoveMemberId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll lose access to all data in this workspace. You can
              re-invite them later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removeMemberId) removeMember(removeMemberId);
                setRemoveMemberId(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// US-374: owner-only control to require MFA (2FA) for members at/above a role
// threshold. Persisted as users.workspace_mfa_required_role; enforced server-
// side by workspaceMiddleware (a non-AAL2 member at/above the threshold is
// blocked with error_code 'workspace_mfa_required').
const MFA_POLICY_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "off", label: "Not required", hint: "Members sign in with a password only." },
  { value: "admin", label: "Admins", hint: "Admins must use 2FA." },
  {
    value: "listing_manager",
    label: "Managers and above",
    hint: "Managers and Admins must use 2FA.",
  },
  {
    value: "member",
    label: "Staff and above",
    hint: "Everyone except Viewers must use 2FA.",
  },
  { value: "viewer", label: "Everyone", hint: "All members must use 2FA." },
];

function WorkspaceMfaPolicyCard({ ownerId }: { ownerId: string | null }) {
  const [value, setValue] = useState<string>("off");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await edgeFetch("/api/workspace/mfa-policy", { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as {
          required_role?: string | null;
        };
        if (active && res.ok) setValue(data.required_role ?? "off");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [ownerId]);

  async function save(next: string) {
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await edgeFetch("/api/workspace/mfa-policy", {
        method: "PUT",
        json: { required_role: next === "off" ? null : next },
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setValue(prev);
        toast.error(data.error ?? "Couldn't update the MFA requirement.");
        return;
      }
      toast.success(
        next === "off"
          ? "Two-factor authentication is no longer required."
          : "Two-factor authentication requirement updated.",
      );
    } catch (err) {
      setValue(prev);
      toast.error(err instanceof Error ? err.message : "Failed to update policy.");
    } finally {
      setSaving(false);
    }
  }

  const activeHint = MFA_POLICY_OPTIONS.find((o) => o.value === value)?.hint;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Require two-factor authentication
        </CardTitle>
        <CardDescription>
          Require members at or above a role to have 2FA enabled before they can
          act in your workspace. Members enable 2FA under Settings → Two-Factor
          Authentication. You (the owner) are not affected by this rule.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <Select value={value} onValueChange={save} disabled={loading || saving}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MFA_POLICY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(loading || saving) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        {activeHint && (
          <p className="text-xs text-muted-foreground">{activeHint}</p>
        )}
      </CardContent>
    </Card>
  );
}
