// US-9121: the consent screen.
//
// This is the highest-trust page in the product. It is the one place a seller
// decides whether an AI may spend their money, and everything on it is written
// for someone who has never heard the word "scope".
//
// Three rules it follows, and each one is a way consent screens go wrong:
//
//   1. SAY WHAT IT CAN DO, not what it is called. "submit" means nothing;
//      "Grade items and put listings live, which spends your credits and can
//      change what buyers pay" is the actual decision.
//   2. LET THEM SAY LESS. A seller who wants read-only gets read-only here, by
//      unticking a box, without going to find the API-keys page.
//   3. NEVER DEAD-END A NO. Declining redirects the client back with the error
//      the spec names, so Claude says "connection cancelled" rather than
//      hanging on a page that went nowhere.
//
// The query string is carried verbatim from /oauth/authorize and is NOT trusted
// here — the edge re-validates every parameter before it issues anything. This
// page cannot widen a scope or change a redirect by editing its own URL.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AlertCircle, Check, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

/**
 * Plain-English scope copy.
 *
 * `title` is what it lets the AI do. `detail` is the consequence a seller would
 * want to know before agreeing, stated as a cost rather than as a capability —
 * "can spend your grading credits" is the sentence that changes a decision,
 * "grants write access" is not.
 */
const SCOPE_COPY: Record<string, { title: string; detail: string; required?: boolean }> = {
  read: {
    title: "Read your inventory, grades and listings",
    detail:
      "See your items, their grades, what is listed where, and what has sold. It cannot change anything with this alone.",
    required: true,
  },
  submit: {
    title: "Grade items, write listings and change prices",
    detail:
      "Send items for grading, put listings live, reprice them and take them off sale. This spends your grading credits and changes what buyers see and pay.",
  },
  webhook_manage: {
    title: "Manage webhooks",
    detail:
      "Set up and remove the notifications GradeThread sends to other software you use.",
  },
};

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
  state?: string;
}

function readParams(search: URLSearchParams): AuthorizeParams | null {
  const required = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "resource",
  ];
  for (const key of required) {
    if (!search.get(key)) return null;
  }
  const state = search.get("state");
  return {
    client_id: search.get("client_id")!,
    redirect_uri: search.get("redirect_uri")!,
    response_type: search.get("response_type")!,
    code_challenge: search.get("code_challenge")!,
    code_challenge_method: search.get("code_challenge_method")!,
    scope: search.get("scope")!,
    resource: search.get("resource")!,
    ...(state ? { state } : {}),
  };
}

/** The application's own name for itself, shown as its ORIGIN, never its title. */
function clientLabel(clientId: string): string {
  try {
    // A Client ID Metadata Document id IS a URL, and the host is the only part
    // a seller can verify. A self-declared display name is not evidence.
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

export function ConnectClaudePage() {
  const [search] = useSearchParams();
  const { user } = useAuth();
  const params = useMemo(() => readParams(search), [search]);

  const requested = useMemo(
    () => (params?.scope ?? "").split(/\s+/).filter(Boolean),
    [params],
  );

  const [granted, setGranted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGranted(requested);
  }, [requested]);

  if (!params) {
    return (
      <Shell>
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">This connection link is incomplete.</p>
            <p className="text-sm text-muted-foreground">
              Go back to Claude and start the connection again. Nothing has been shared.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const host = clientLabel(params.client_id);

  async function decide(approved: boolean) {
    if (!params) return;
    setBusy(true);
    setError(null);
    try {
      const res = await edgeFetch("/api/oauth/consent", {
        method: "POST",
        json: { ...params, approved, scopes: granted },
      });
      const body = (await res.json()) as {
        redirect_to?: string;
        error_description?: string;
        error?: string;
      };
      if (!res.ok || !body.redirect_to) {
        setError(
          body.error_description ??
            "We could not complete this connection. Start it again from Claude.",
        );
        setBusy(false);
        return;
      }
      // A full navigation, not a router push: the destination belongs to the
      // client, not to this app.
      window.location.assign(body.redirect_to);
    } catch {
      setError("We could not reach GradeThread. Check your connection and try again.");
      setBusy(false);
    }
  }

  const toggle = (scope: string) => {
    setGranted((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]
    );
  };

  return (
    <Shell>
      <header className="space-y-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Connect <span className="text-primary">{host}</span> to GradeThread?
        </h1>
        <p className="max-w-[68ch] text-muted-foreground">
          It will be able to act on your GradeThread account on your behalf, using the
          permissions you leave switched on below. You can disconnect it at any time from
          Settings.
        </p>
      </header>

      <section aria-labelledby="permissions" className="space-y-3">
        <h2 id="permissions" className="text-sm font-medium">
          What it will be allowed to do
        </h2>
        <ul className="space-y-3">
          {requested.map((scope) => {
            const copy = SCOPE_COPY[scope];
            const on = granted.includes(scope);
            return (
              <li
                key={scope}
                className={cn(
                  "rounded-xl border p-4 transition-colors",
                  on ? "border-border bg-card" : "border-dashed border-border/60 bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <Label
                      htmlFor={`scope-${scope}`}
                      className="text-base font-medium leading-snug"
                    >
                      {copy?.title ?? scope}
                    </Label>
                    <p className="max-w-[68ch] text-sm text-muted-foreground">
                      {copy?.detail ?? "No description is available for this permission."}
                    </p>
                    {copy?.required ? (
                      <p className="text-xs text-muted-foreground">
                        Needed for the connection to do anything at all.
                      </p>
                    ) : null}
                  </div>
                  <Switch
                    id={`scope-${scope}`}
                    checked={on}
                    disabled={busy || copy?.required === true}
                    onCheckedChange={() => toggle(scope)}
                    aria-label={copy?.title ?? scope}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">
          Turn off anything you would rather it could not do. It will still connect.
        </p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <p>
          Signed in as <span className="font-medium text-foreground">{user?.email}</span>.
          This connection applies to that account.
        </p>
        <p className="flex items-center gap-1.5">
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          <span>
            After you allow it, you will be sent back to{" "}
            <span className="font-medium text-foreground">
              {clientLabel(params.redirect_uri)}
            </span>
            .
          </span>
        </p>
      </section>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
        >
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm">{error}</p>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" disabled={busy} onClick={() => decide(false)}>
          Cancel
        </Button>
        <Button disabled={busy || granted.length === 0} onClick={() => decide(true)}>
          <Check className="size-4" aria-hidden />
          {busy ? "Connecting…" : "Allow"}
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-8 px-5 py-12">
      {children}
    </main>
  );
}
