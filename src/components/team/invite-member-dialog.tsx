import { useState } from "react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ASSIGNABLE_WORKSPACE_ROLES,
  WORKSPACE_ROLE_LABEL,
  WORKSPACE_ROLE_DESCRIPTION,
} from "@/lib/workspace-permissions";
import type { WorkspaceRole } from "@/types/database";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: { inviteUrl: string; emailSent: boolean }) => void;
}

export function InviteMemberDialog({ open, onOpenChange, onCreated }: Props) {
  const { workspaceOwnerId } = useWorkspace();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("listing_manager");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceOwnerId) return;
    if (!email.trim()) {
      toast.error("Enter an email address");
      return;
    }
    setSubmitting(true);
    try {
      // The edge route creates the invitation row + sends the email via
      // Resend in one round-trip. Auth + workspace header are applied
      // automatically by edgeFetch.
      const res = await edgeFetch("/api/workspace/invitations", {
        method: "POST",
        json: { email: email.trim().toLowerCase(), role },
      });
      const data = (await res.json().catch(() => ({}))) as {
        accept_url?: string;
        email_sent?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Failed to create invitation");
        return;
      }
      const inviteUrl =
        data.accept_url ?? `${window.location.origin}/accept-invite`;
      onCreated({ inviteUrl, emailSent: !!data.email_sent });
      setEmail("");
      setRole("listing_manager");
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite a team member</DialogTitle>
            <DialogDescription>
              They'll get a link to sign up (or sign in) and join your workspace
              with the role you choose.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
                <SelectTrigger id="invite-role">
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
              <p className="text-xs text-muted-foreground">
                {WORKSPACE_ROLE_DESCRIPTION[role]}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating invite…" : "Create invitation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
