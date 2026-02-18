import { LayoutDashboard } from "lucide-react";

export function AdminDashboardPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
      </div>
      <p className="text-muted-foreground">
        Platform metrics and KPI overview will be displayed here.
      </p>
    </div>
  );
}
