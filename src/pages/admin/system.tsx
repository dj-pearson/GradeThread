import { Wrench } from "lucide-react";

export function AdminSystemPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Wrench className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">System</h1>
      </div>
      <p className="text-muted-foreground">
        System configuration, health checks, and maintenance tools will be available here.
      </p>
    </div>
  );
}
