import { lazy } from "react";
import { Brain } from "lucide-react";
import { AdminTabHost } from "@/pages/admin/admin-tab-host";
import {
  AI_VIEWS,
  resolveAiView,
  type AiView,
} from "@/pages/admin/admin-host-tabs";

// US-2559: AI Models, AI Spend, AI Profitability and Assistant Monitoring were
// four sidebar entries covering one domain.
//
// VERIFIED as a MERGE: Models is the configuration (which model serves what),
// Spend is what it cost, Profitability is whether that cost was earned back,
// and Assistant Monitoring is the support assistant's own behaviour. Nothing
// duplicates anything — Models is the surface the other three measure, which is
// why it leads.

const ModelsPage = lazy(() =>
  import("@/pages/admin/ai-models").then((m) => ({ default: m.AdminAiModelsPage })),
);
const SpendPage = lazy(() =>
  import("@/pages/admin/ai-spend").then((m) => ({ default: m.AdminAiSpendPage })),
);
const ProfitabilityPage = lazy(() =>
  import("@/pages/admin/ai-profitability").then((m) => ({ default: m.AdminAiProfitabilityPage })),
);
const AssistantPage = lazy(() =>
  import("@/pages/admin/monitoring").then((m) => ({ default: m.AdminMonitoringPage })),
);

const VIEWS = [
  { value: "models", label: "Models", Component: ModelsPage },
  { value: "spend", label: "Spend", Component: SpendPage },
  { value: "profitability", label: "Profitability", Component: ProfitabilityPage },
  { value: "assistant", label: "Assistant monitoring", Component: AssistantPage },
] satisfies ReadonlyArray<{ value: AiView; label: string; Component: React.ComponentType }>;

// The tab order IS the order declared in admin-host-tabs.ts, and the first is
// the default. Asserted in the guard so the two cannot drift.
void AI_VIEWS;

export function AdminAiHostPage() {
  return (
    <AdminTabHost
      title="AI Platform"
      subtitle="Which models run, what they cost, whether they pay, and how the assistant behaves."
      icon={Brain}
      views={VIEWS}
      resolve={resolveAiView}
    />
  );
}
