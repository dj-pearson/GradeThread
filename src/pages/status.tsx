import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import { Image } from "@/components/responsive-image";
import { SITE_URL } from "@/lib/seo/site";
import { cn } from "@/lib/utils";
import { edgeApiUrl } from "@/lib/edge-api";

// Public status page (US-500). Probes run FROM THE VISITOR'S BROWSER against
// each component directly, so this page keeps working (and shows red) even
// when the edge service or Supabase is down — the only shared dependency is
// Cloudflare Pages serving the SPA itself, which the page reports as
// operational by construction (you couldn't load it otherwise). The
// independent external monitor is .github/workflows/uptime.yml.

type ProbeStatus = "operational" | "degraded" | "down" | "unknown" | "checking";

interface ProbeResult {
  status: ProbeStatus;
  latencyMs?: number;
  detail?: string;
}

interface ComponentState extends ProbeResult {
  id: string;
  name: string;
  description: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 60_000;

async function timedFetch(
  url: string,
  headers?: Record<string, string>,
): Promise<{ response: Response; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...(headers ? { headers } : {}),
    });
    return { response, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

function safeEdgeUrl(): string | null {
  try {
    return edgeApiUrl();
  } catch {
    return null;
  }
}

// Edge liveness — is the API process up at all?
async function probeEdge(): Promise<ProbeResult> {
  const base = safeEdgeUrl();
  if (!base) return { status: "unknown", detail: "Edge URL not configured" };
  try {
    const { response, latencyMs } = await timedFetch(`${base}/health`);
    if (response.ok) return { status: "operational", latencyMs };
    return { status: "down", latencyMs, detail: `HTTP ${response.status}` };
  } catch {
    return { status: "down", detail: "Unreachable" };
  }
}

// Edge readiness — probes the database THROUGH the edge service. A 503 with
// checks.database === "fail" means the DB is unreachable; if the edge itself
// is unreachable we can't see the DB from here, so report unknown (the edge
// row already shows the outage).
async function probeDatabase(): Promise<ProbeResult> {
  const base = safeEdgeUrl();
  if (!base) return { status: "unknown", detail: "Edge URL not configured" };
  try {
    const { response, latencyMs } = await timedFetch(`${base}/health/ready`);
    if (response.ok) return { status: "operational", latencyMs };
    let dbFailed = false;
    try {
      const body = (await response.json()) as {
        checks?: { database?: string };
      };
      dbFailed = body.checks?.database === "fail";
    } catch {
      /* non-JSON 5xx — treat as a generic degradation below */
    }
    if (dbFailed) {
      return { status: "down", latencyMs, detail: "Database unreachable" };
    }
    return { status: "degraded", latencyMs, detail: `HTTP ${response.status}` };
  } catch {
    return { status: "unknown", detail: "Edge API unreachable" };
  }
}

// Supabase Auth (GoTrue) health via Kong — the same origin + apikey the app's
// own sign-in calls use, so reachable from any browser.
async function probeAuth(): Promise<ProbeResult> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) {
    return { status: "unknown", detail: "Supabase URL not configured" };
  }
  try {
    const { response, latencyMs } = await timedFetch(
      `${supabaseUrl.replace(/\/$/, "")}/auth/v1/health`,
      { apikey: anonKey },
    );
    if (response.ok) return { status: "operational", latencyMs };
    return { status: "degraded", latencyMs, detail: `HTTP ${response.status}` };
  } catch {
    return { status: "down", detail: "Unreachable" };
  }
}

const COMPONENTS: Array<{
  id: string;
  name: string;
  description: string;
  probe: (() => Promise<ProbeResult>) | null;
}> = [
  {
    id: "web",
    name: "Web app",
    description: "gradethread.com — the app you're using right now",
    // You loaded this page from the same deployment, so it's up by definition.
    probe: null,
  },
  {
    id: "edge",
    name: "API & grading service",
    description: "Grading, payments, FlipDesk and integrations backend",
    probe: probeEdge,
  },
  {
    id: "database",
    name: "Database",
    description: "Submissions, reports and account data",
    probe: probeDatabase,
  },
  {
    id: "auth",
    name: "Authentication",
    description: "Sign-in, sign-up and sessions",
    probe: probeAuth,
  },
];

const STATUS_META: Record<
  ProbeStatus,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  operational: {
    label: "Operational",
    className: "text-emerald-600",
    Icon: CheckCircle2,
  },
  degraded: {
    label: "Degraded",
    className: "text-amber-600",
    Icon: AlertTriangle,
  },
  down: { label: "Down", className: "text-destructive", Icon: XCircle },
  unknown: {
    label: "Unknown",
    className: "text-muted-foreground",
    Icon: CircleHelp,
  },
  checking: {
    label: "Checking…",
    className: "text-muted-foreground",
    Icon: RefreshCw,
  },
};

function overallBanner(components: ComponentState[]): {
  label: string;
  className: string;
} {
  const statuses = components.map((c) => c.status);
  if (statuses.includes("checking")) {
    return { label: "Checking systems…", className: "bg-muted text-foreground" };
  }
  if (statuses.includes("down")) {
    return {
      label: "Service disruption",
      className: "bg-destructive text-white",
    };
  }
  if (statuses.includes("degraded") || statuses.includes("unknown")) {
    return {
      label: "Degraded performance",
      className: "bg-amber-500 text-white",
    };
  }
  return {
    label: "All systems operational",
    className: "bg-emerald-600 text-white",
  };
}

export function StatusPage() {
  const [components, setComponents] = useState<ComponentState[]>(() =>
    COMPONENTS.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.probe ? "checking" : "operational",
    })),
  );
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlight = useRef(false);

  const runChecks = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsRefreshing(true);
    const results = await Promise.all(
      COMPONENTS.map(async (c) => {
        const result: ProbeResult = c.probe
          ? await c.probe()
          : { status: "operational" };
        return { id: c.id, name: c.name, description: c.description, ...result };
      }),
    );
    setComponents(results);
    setLastChecked(new Date());
    setIsRefreshing(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
    void runChecks();
    const interval = setInterval(() => void runChecks(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [runChecks]);

  const banner = overallBanner(components);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SEO
        title="System Status"
        description="Live operational status of GradeThread's web app, grading API, database and authentication."
        canonicalUrl={`${SITE_URL}/status`}
      />

      <header className="flex h-16 items-center justify-between border-b px-6 lg:px-12">
        <Link to="/" aria-label="GradeThread home">
          <Image
            src="/logo_primary.png"
            alt="GradeThread"
            width={154}
            height={32}
            priority
            className="h-8 w-auto"
          />
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runChecks()}
          disabled={isRefreshing}
        >
          <RefreshCw
            className={cn("mr-1 h-4 w-4", isRefreshing && "animate-spin")}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <h1 className="text-2xl font-bold">System Status</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Checks run live from your browser against each GradeThread component.
        </p>

        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mt-6 rounded-lg px-4 py-3 text-sm font-medium",
            banner.className,
          )}
        >
          {banner.label}
        </div>

        <ul className="mt-6 divide-y rounded-lg border">
          {components.map((c) => {
            const meta = STATUS_META[c.status];
            return (
              <li
                key={c.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.description}
                  </p>
                </div>
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 text-sm font-medium",
                    meta.className,
                  )}
                >
                  <meta.Icon
                    className={cn(
                      "h-4 w-4",
                      c.status === "checking" && "animate-spin",
                    )}
                    aria-hidden="true"
                  />
                  <span>{meta.label}</span>
                  {c.latencyMs !== undefined && (
                    <span className="font-normal text-muted-foreground">
                      · {c.latencyMs} ms
                    </span>
                  )}
                  {c.detail && (
                    <span className="font-normal text-muted-foreground">
                      ({c.detail})
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          {lastChecked
            ? `Last checked ${lastChecked.toLocaleTimeString()} — refreshes every minute.`
            : "Running first check…"}{" "}
          A "Down" result can also indicate a problem between your network and
          GradeThread.
        </p>
      </main>

      <footer className="border-t px-6 py-6 text-center text-xs text-muted-foreground">
        &copy; {new Date().getFullYear()} Pearson Media LLC ·{" "}
        <Link to="/" className="hover:text-foreground">
          gradethread.com
        </Link>
      </footer>
    </div>
  );
}
