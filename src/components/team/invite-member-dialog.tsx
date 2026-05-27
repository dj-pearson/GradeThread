import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
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
  onCreated: (inviteUrl: string) => void;
}

function generateToken(): string {
  // 64-char hex token. Two UUIDs combined for ~256 bits of entropy.
  const a = crypto.randomUUID().replace(/-/g, "");
  const b = crypto.randomUUID().replace(/-/g, "");
  return `${a}${b}`;
}

export function InviteMemberDialog({ open, onOpenChange, onCreated }: Props) {
  const { user } = useAuth();
  const { workspaceOwnerId } = useWorkspace();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("listing_manager");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceOwnerId || !user) return;
    if (!email.trim()) {
      toast.error("Enter an email address");
      return;
    }
    setSubmitting(true);
    const token = generateToken();
    const { error } = await supabase.from("workspace_invitations").insert({
      owner_id: workspaceOwnerId,
      email: email.trim().toLowerCase(),
      role,
      token,
      invited_by: user.id,
    } as never);
    setSubmitting(false);
    if (error) {
      if (error.code === "23505") {
        toast.error("There's already a pending invite for that email");
      } else {
        toast.error(error.message);
      }
      return;
    }
    const url = `${window.location.origin}/accept-invite?token=${token}`;
    onCreated(url);
    setEmail("");
    setRole("listing_manager");
    onOpenChange(false);
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
