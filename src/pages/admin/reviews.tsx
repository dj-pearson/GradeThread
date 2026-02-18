import { MessageSquare } from "lucide-react";

export function AdminReviewsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">Human Reviews</h1>
      </div>
      <p className="text-muted-foreground">
        Queue for low-confidence grades needing human review will be displayed here.
      </p>
    </div>
  );
}
