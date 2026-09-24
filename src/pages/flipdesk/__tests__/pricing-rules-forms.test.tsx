// Pricing plan P10: the two rules lists show an outage as an error rather than
// "no rules yet", the forms refuse what the server refuses instead of coercing
// it, and the Automations scope picker offers only the fields the server takes.
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const failed = { data: undefined, isLoading: false, isError: true, isFetching: false, refetch: vi.fn() };
const empty = { data: [], isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

vi.mock("@/hooks/use-automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-automations")>()),
  useAutomationRules: () => failed,
  useRunAutomations: () => idle,
}));

vi.mock("@/hooks/use-repricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-repricing")>()),
  useRepricingSuggestions: () => empty,
  useRepriceRules: () => failed,
  useRepriceActions: () => empty,
  useScanRepricing: () => idle,
  useApplyReprice: () => idle,
  useBulkRepriceApply: () => idle,
  useDismissReprice: () => idle,
  useRunRepriceRules: () => idle,
  useCreateRepriceRule: () => idle,
  useUpdateRepriceRule: () => idle,
  useToggleRepriceRule: () => idle,
  useDeleteRepriceRule: () => idle,
}));

const { FlipdeskAutomationsPage } = await import("@/pages/flipdesk/automations");
const { FlipdeskRepricingPage } = await import("@/pages/flipdesk/repricing");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");
const { AUTOMATION_SCOPE_FIELDS } = await import("@/hooks/use-automations");
const { automationFormError, repriceRuleFormError } = await import(
  "@/pages/flipdesk/rule-form-validation"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ConfirmProvider>{node}</ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("a failed rules read is an error, not an empty list", () => {
  it("Automations", () => {
    render(<FlipdeskAutomationsPage />);
    expect(host.textContent).toContain("Couldn't load your rules");
    expect(host.textContent).not.toContain("No automation rules yet");
  });

  it("Repricing's markdown rules card", () => {
    render(<FlipdeskRepricingPage />);
    expect(host.textContent).toContain("Couldn't load your rules");
    expect(host.textContent).not.toContain("No markdown rules yet");
    expect(host.textContent).toContain("Markdown rules");
  });
});

const base = {
  name: "Age out",
  triggerType: "days_listed_gt",
  triggerNeedsDays: true,
  triggerDays: "30",
  cooldownDays: "7",
  actionType: "price_drop_pct",
  actionPctMax: 90,
  actionPct: "10",
  mdDays: "45",
  mdPct: "20",
};

describe("automationFormError", () => {
  it("a valid rule saves", () => {
    expect(automationFormError(base)).toBeNull();
  });
  it("a cleared days field blocks Save instead of becoming 1", () => {
    expect(automationFormError({ ...base, triggerDays: "" })).toMatch(/number of days/);
  });
  it("a cleared cooldown or percent blocks Save", () => {
    expect(automationFormError({ ...base, cooldownDays: "" })).not.toBeNull();
    expect(automationFormError({ ...base, actionPct: "" })).not.toBeNull();
  });
  it("holds each action to its own range", () => {
    expect(automationFormError({ ...base, actionPct: "91" })).toMatch(/1 to 90/);
    expect(
      automationFormError({ ...base, actionType: "create_coded_coupon", actionPctMax: 70, actionPct: "3" }),
    ).toMatch(/5 to 70/);
  });
  it("a markdown rule is 5 to 70% and needs no action or cooldown", () => {
    const md = { ...base, triggerType: "markdown_schedule", cooldownDays: "", actionPct: "" };
    expect(automationFormError(md)).toBeNull();
    expect(automationFormError({ ...md, mdPct: "2" })).toMatch(/5 to 70/);
    expect(automationFormError({ ...md, mdPct: "90" })).toMatch(/5 to 70/);
  });
});

describe("repriceRuleFormError", () => {
  const r = { name: "Weekly", dropPct: "10", intervalDays: "7", minAgeDays: "0" };
  it("accepts the server's ranges and refuses outside them", () => {
    expect(repriceRuleFormError(r)).toBeNull();
    expect(repriceRuleFormError({ ...r, dropPct: "95" })).not.toBeNull();
    expect(repriceRuleFormError({ ...r, intervalDays: "" })).not.toBeNull();
    expect(repriceRuleFormError({ ...r, intervalDays: "91" })).not.toBeNull();
    expect(repriceRuleFormError({ ...r, minAgeDays: "400" })).not.toBeNull();
  });
});

describe("the Automations scope picker", () => {
  it("offers exactly the fields the server accepts", () => {
    const src = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/automation-rules.ts"),
      "utf8",
    );
    const block = /const SCOPE_FIELDS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, "SCOPE_FIELDS in automation-rules.ts").toBeTruthy();
    const server = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
    expect([...AUTOMATION_SCOPE_FIELDS].sort()).toEqual(server);
  });

  it("the rule dialog passes that list to the FilterBuilder", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/automations.tsx"), "utf8");
    expect(page).toMatch(/fields=\{AUTOMATION_SCOPE_FIELDS\}/);
  });
});
