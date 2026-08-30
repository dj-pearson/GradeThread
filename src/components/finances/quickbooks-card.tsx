import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Link2Off,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SYSTEM_ACCOUNTS } from "@/lib/chart-of-accounts";
import {
  accountsNotNeeded,
  blockedAccounts,
  proposalToChoice,
  proposeMapping,
  validateMapping,
  type MappingChoice,
} from "@/lib/qbo-mapping";
import {
  disconnectQbo,
  fetchQboAccounts,
  fetchQboMappings,
  fetchQboStatus,
  saveQboMappings,
  startQboConnect,
} from "@/lib/qbo";

// US-2997 — connect QuickBooks, and map the accounts.
//
// NOTHING IS PUSHED FROM HERE. That is US-2998. The split is the point: a sale
// posted into the wrong QBO account is a mess an accountant unpicks by hand,
// and QuickBooks has no undo for a bulk sync, so the mapping gets its own
// screen and its own sign-off before a single transaction moves.

const NOT_NEEDED = new Map(accountsNotNeeded().map((n) => [n.code, n.reason]));

export function QuickBooksCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [choice, setChoice] = useState<MappingChoice | null>(null);

  const { data: status } = useQuery({
    queryKey: ["qbo-status", user?.id],
    enabled: !!user,
    queryFn: fetchQboStatus,
    staleTime: 60 * 1000,
  });

  const connected = status?.connected ?? false;

  const { data: chart } = useQuery({
    queryKey: ["qbo-accounts", user?.id],
    enabled: !!user && connected,
    queryFn: fetchQboAccounts,
    staleTime: 10 * 60 * 1000,
  });

  const { data: stored } = useQuery({
    queryKey: ["qbo-mappings", user?.id],
    enabled: !!user && connected,
    queryFn: fetchQboMappings,
    staleTime: 60 * 1000,
  });

  // The callback comes back with ?qbo=<status>. Report it once, then clear it
  // so a refresh does not re-announce a connection made ten minutes ago.
  useEffect(() => {
    const result = params.get("qbo");
    if (!result) return;
    const messages: Record<string, string> = {
      connected: "QuickBooks is connected. Map your accounts next.",
      cancelled: "You cancelled before QuickBooks finished.",
      invalid_state: "That connection link had expired. Start again.",
      state_expired: "That connection link had expired. Start again.",
      no_realm: "QuickBooks didn't say which company file. Start again.",
      exchange_failed: "QuickBooks refused the connection. Try again.",
    };
    const msg =
      messages[result] ?? "Something went wrong connecting QuickBooks.";
    if (result === "connected") toast.success(msg);
    else toast.error(msg);
    const next = new URLSearchParams(params);
    next.delete("qbo");
    setParams(next, { replace: true });
    void qc.invalidateQueries({ queryKey: ["qbo-status"] });
  }, [params, setParams, qc]);

  // Memoised, not `chart?.accounts ?? []`: the fallback would be a new array
  // every render, so proposeMapping would re-run on every keystroke elsewhere
  // on the page.
  const accounts = useMemo(() => chart?.accounts ?? [], [chart]);

  // The proposal is computed fresh from the live chart, and the SELLER'S saved
  // choices win over it. A re-proposal that overwrote a manual pick would undo
  // the seller's work every time the page loaded.
  const proposed = useMemo(() => proposeMapping(accounts), [accounts]);
  const effective: MappingChoice = useMemo(() => {
    if (choice) return choice;
    const base = proposalToChoice(proposed);
    for (const m of stored ?? []) base[m.account_code] = m.qbo_account_id;
    return base;
  }, [choice, proposed, stored]);

  const problems = useMemo(
    () => validateMapping(effective, accounts),
    [effective, accounts],
  );
  // Every account is treated as "in use" here, because this screen is set up
  // rather than a sync run: the seller wants to see the whole list, and
  // US-2998 narrows it to what a period actually touched.
  const unmapped = useMemo(
    () =>
      blockedAccounts(
        effective,
        SYSTEM_ACCOUNTS.map((a) => a.code),
      ),
    [effective],
  );

  const connect = useMutation({
    mutationFn: async () => {
      const url = await startQboConnect(
        `${window.location.pathname}${window.location.search}`,
      );
      window.location.href = url;
    },
    onError: (err) => toastError(err, "Couldn't start the connection."),
  });

  const disconnect = useMutation({
    mutationFn: disconnectQbo,
    onSuccess: () => {
      toast.success("QuickBooks is disconnected.");
      void qc.invalidateQueries({ queryKey: ["qbo-status"] });
    },
    onError: (err) => toastError(err, "Couldn't disconnect."),
  });

  const save = useMutation({
    mutationFn: async () => {
      const byId = new Map(accounts.map((a) => [a.Id, a]));
      await saveQboMappings(
        Object.entries(effective).map(([code, id]) => ({
          account_code: code,
          qbo_account_id: id,
          qbo_account_name: id ? (byId.get(id)?.Name ?? null) : null,
          basis: "manual",
        })),
      );
    },
    onSuccess: () => {
      toast.success("Mapping saved.");
      setChoice(null);
      void qc.invalidateQueries({ queryKey: ["qbo-mappings"] });
    },
    onError: (err) => toastError(err, "Couldn't save the mapping."),
  });

  if (!status) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">QuickBooks Online</CardTitle>
            <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              Send your books straight into QuickBooks. This screen connects it
              and lines your accounts up. Nothing is sent until you say so.
            </p>
          </div>
          {/* AC5. Which company file, and which environment, on the screen at
              all times. A seller who cannot see this cannot tell a sandbox sync
              from a real one until the damage is in a real company file. */}
          <Badge
            variant={status.environment === "sandbox" ? "secondary" : "outline"}
          >
            {status.environment === "sandbox"
              ? "Sandbox (test data)"
              : "Live company"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!status.configured && (
          <p className="rounded-md bg-amber-500/10 p-3 text-[13px] leading-relaxed">
            QuickBooks is not switched on for this server yet. Nothing here can
            reach Intuit.
          </p>
        )}

        {status.connection?.refresh_error && (
          // AC6. A silent stop is how a seller finds out in March that nothing
          // has synced since November. It says what to do, and the button is
          // right there.
          <div className="rounded-md bg-destructive/10 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {status.connection.refresh_error}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !status.configured}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reconnect
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {connected ? (
            <>
              <span className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Connected to{" "}
                <strong>
                  {status.connection?.company_name ??
                    `company ${status.connection?.realm_id}`}
                </strong>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                <Link2Off className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !status.configured}
            >
              <Link2 className="mr-2 h-4 w-4" />
              Connect QuickBooks
            </Button>
          )}
        </div>

        {connected && chart?.reconnect && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Your QuickBooks sign-in has run out. Reconnect above and the
            accounts will load.
          </p>
        )}

        {connected && !chart?.reconnect && accounts.length > 0 && (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Line up your accounts</p>
              <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                We picked the closest match in your QuickBooks file for each
                one. Check them. A sale posted into the wrong account has to be
                unpicked by hand.
              </p>
            </div>

            {problems.length > 0 && (
              <ul className="space-y-1 rounded-md bg-destructive/10 p-3 text-[13px] leading-relaxed">
                {problems.map((p) => (
                  <li key={p.code}>{p.message}</li>
                ))}
              </ul>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Your account</th>
                    <th className="py-1.5 font-medium">Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {SYSTEM_ACCOUNTS.map((a) => {
                    const skip = NOT_NEEDED.get(a.code);
                    const p = proposed.find((x) => x.code === a.code);
                    return (
                      <tr key={a.code} className="border-t align-top">
                        <td className="py-2 pr-3">
                          <div>{a.name}</div>
                          {a.schedule_c_line && (
                            <div className="text-[12px] text-muted-foreground">
                              Schedule C line {a.schedule_c_line}
                            </div>
                          )}
                        </td>
                        <td className="py-2">
                          {skip ? (
                            <span className="text-[12px] leading-relaxed text-muted-foreground">
                              {skip}
                            </span>
                          ) : (
                            <>
                              <Select
                                value={effective[a.code] ?? "__none"}
                                onValueChange={(v) =>
                                  setChoice({
                                    ...effective,
                                    [a.code]: v === "__none" ? null : v,
                                  })
                                }
                              >
                                <SelectTrigger
                                  className="h-8 w-full max-w-[320px]"
                                  aria-label={`QuickBooks account for ${a.name}`}
                                >
                                  <SelectValue placeholder="Not mapped" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none">
                                    Not mapped
                                  </SelectItem>
                                  {accounts
                                    .filter((q) => q.Active !== false)
                                    .map((q) => (
                                      <SelectItem key={q.Id} value={q.Id}>
                                        {q.FullyQualifiedName ?? q.Name}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              {/* A guess is labelled a guess. Marking every row
                                  "check this" would train the seller to check
                                  none of them. */}
                              {p?.note && effective[a.code] === p.qboId && (
                                <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                                  {p.note}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* AC4. Unmapped is not a failure, it is a wait. Saying which
                accounts wait, and that the rest still go, is the difference
                between a seller finishing setup and a seller giving up. */}
            {unmapped.length > 0 && (
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {unmapped.length} account{unmapped.length === 1 ? "" : "s"}{" "}
                still need a home. Those wait; everything else syncs.
              </p>
            )}

            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving" : "Save the mapping"}
            </Button>
          </div>
        )}

        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Sync runs one way, from GradeThread into QuickBooks. Edits you make in
          QuickBooks stay there.
        </p>
      </CardContent>
    </Card>
  );
}
