import { Brain } from "lucide-react";

export function AdminAiModelsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="h-6 w-6 text-brand-red" />
        <h1 className="text-2xl font-bold">AI Models</h1>
      </div>
      <p className="text-muted-foreground">
        AI prompt version management and accuracy tracking will be available here.
      </p>
    </div>
  );
}
