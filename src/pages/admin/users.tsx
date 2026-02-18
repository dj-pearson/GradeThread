import { Users } from "lucide-react";

export function AdminUsersPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">User Management</h1>
      </div>
      <p className="text-muted-foreground">
        User list, role management, and account actions will be available here.
      </p>
    </div>
  );
}
