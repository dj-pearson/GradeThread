import { FileText } from "lucide-react";

export function AdminSubmissionsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FileText className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">All Submissions</h1>
      </div>
      <p className="text-muted-foreground">
        Platform-wide submission browsing and moderation will be available here.
      </p>
    </div>
  );
}
