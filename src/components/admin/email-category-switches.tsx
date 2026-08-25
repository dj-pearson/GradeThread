import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mail, Lock, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2854: per-category kill switches for outgoing email.
//
// A typed view of one registry row (email_categories_disabled). The generic
// editor below can still edit that row as raw JSON; this exists so an operator
// sees named switches instead of an array of strings, and so a protected
// category shows as locked rather than as a toggle that silently does nothing.

interface EmailCategory {
  category: string;
  label: string;
  group: "account" | "grading" | "selling" | "billing" | "marketing" | "operator";
  protected: boolean;
  disabled: boolean;
  /** Outbox rows (retry / dead letter / skipped) in the last 24h. NOT a send count. */
  outbox24h: number;
}

interface Response {
  categories: EmailCategory[];
  disabled: string[];
}

const GROUP_LABEL: Record<EmailCategory["group"], string> = {
  account: "Account",
  grading: "Grading",
  selling: "Selling",
  billing: "Billing",
  marketing: "Marketing",
  operator: "Operator alerts",
};

const GROUP_ORDER: EmailCategory["group"][] = [
  "account",
  "grading",
  "selling",
  "billing",
  "marketing",
  "operator",
];

export function EmailCategorySwitches({
  onStepUpRequired,
}: {
  onStepUpRequired: (retry: () => void) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-email-category-switches"],
    queryFn: async (): Promise<Response> => {
      const res = await edgeFetch("/api/admin/settings/email-categories", {
        silentGate: true,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body as Response;
    },
  });

  const grouped = useMemo(() => {
    const map = new Map<EmailCategory["group"], EmailCategory[]>();
    for (const c of query.data?.categories ?? []) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return GROUP_ORDER.map((g) => ({ group: g, items: map.get(g) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [query.data]);

  async function toggle(category: string, nextDisabled: boolean) {
    const current = query.data?.disabled ?? [];
    const next = nextDisabled
      ? [...new Set([...current, category])]
      : current.filter((c) => c !== category);

    const send = async () => {
      setSaving(category);
      try {
        const res = await edgeFetch("/api/admin/settings/email-categories", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: next }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          // Fresh second factor required — the dialog retries this same call.
          onStepUpRequired(() => void send());
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        toast.success(nextDisabled ? "Emails paused." : "Emails resumed.");
        await query.refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't save.");
      } finally {
        setSaving(null);
      }
    };

    await send();
  }

  const offCount = query.data?.disabled.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" />
          Outgoing email
          {offCount > 0 && (
            <Badge variant="destructive">{offCount} paused</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Pause a category of email without a deploy. A paused category is skipped
          at send and recorded, not queued, so nothing floods out when you resume
          it. Sign-in codes, receipts and payment failures are locked and cannot be
          paused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {query.isLoading ? (
          <Skeleton className="h-40" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            {(query.error as Error)?.message ?? "Failed to load email switches."}
          </p>
        ) : (
          grouped.map(({ group, items }) => (
            <div key={group} className="space-y-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {GROUP_LABEL[group]}
              </p>
              <div className="space-y-2">
                {items.map((c) => (
                  <div
                    key={c.category}
                    className="flex items-center justify-between gap-4 rounded-lg px-3 py-2 odd:bg-muted/40"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        {c.label}
                        {c.protected && (
                          <Lock
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="Locked — cannot be paused"
                          />
                        )}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {c.category}
                        {c.outbox24h > 0 && (
                          <span className="ml-2">
                            · {c.outbox24h} retry/skip in 24h
                          </span>
                        )}
                      </p>
                    </div>
                    {saving === c.category ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={!c.disabled}
                        disabled={c.protected || saving !== null}
                        onCheckedChange={(on) => void toggle(c.category, !on)}
                        aria-label={`${c.label} email`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
