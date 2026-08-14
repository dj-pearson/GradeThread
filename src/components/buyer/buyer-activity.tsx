import { Link } from "react-router";
import { Bell, ShieldCheck, Shirt } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useBuyerAlertMatches } from "@/hooks/use-buyer-alert-matches";
import { useBuyerCloset } from "@/hooks/use-buyer-closet";

// US-2553: the buyer's own activity, on the buyer's own home page.
//
// Nothing on this page was about what the buyer had actually done: a trust card,
// an impact card and two grids of links. Both feeds below already existed and
// were already recorded — the alert matches since US-1809, the closet since
// US-1825 — there was simply nowhere on the home page that read them.
//
// Kept to the two things a buyer comes back FOR: what matched while they were
// away, and what they saved. Each row is a link to the thing itself, because a
// feed you cannot click is a list of regrets.

const SHOWN = 4;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days > 1) return `${days} days ago`;
  if (days === 1) return "yesterday";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return "just now";
}

export function BuyerActivity() {
  const matches = useBuyerAlertMatches(SHOWN);
  const closet = useBuyerCloset();

  const recentMatches = matches.matches.slice(0, SHOWN);
  const recentCloset = (closet.items ?? []).slice(0, SHOWN);

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-primary" />
            Recent alert matches
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/buyer/alerts">All alerts</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {/* Error first: react-query leaves data undefined on error, so a
              loading check above this one would always win. */}
          {matches.isError ? (
            <ErrorState
              title="Couldn't load your matches"
              description="They're still recorded — we just couldn't fetch them."
              onRetry={() => matches.refetch()}
              retrying={matches.isFetching}
            />
          ) : matches.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : recentMatches.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Nothing has matched yet. An alert watches for graded items in your
              brands and sizes, and tells you the moment one lists.
            </p>
          ) : (
            <ul className="space-y-2">
              {recentMatches.map((m) => (
                <li key={m.id} className="rounded-md border p-2">
                  <Link
                    to={m.link ?? "/buyer/alerts"}
                    className="block text-sm font-medium hover:underline"
                  >
                    {m.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {timeAgo(m.created_at)}
                    {m.is_read ? "" : " · new"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shirt className="h-4 w-4 text-primary" />
            Recently saved
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/buyer/portfolio">Your closet</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {closet.isError ? (
            <ErrorState
              title="Couldn't load your closet"
              description="Your items are safe — we just couldn't fetch them."
              onRetry={() => closet.refetch()}
              retrying={closet.isFetching}
            />
          ) : closet.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : recentCloset.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Nothing saved yet.{" "}
              <Link to="/verify" className="font-medium text-primary hover:underline">
                Verify a certificate
              </Link>{" "}
              and keep it here.
            </p>
          ) : (
            <ul className="space-y-2">
              {recentCloset.map((item) => {
                const label =
                  item.title || [item.brand, item.garment_type].filter(Boolean).join(" ") ||
                  "Saved item";
                return (
                  <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                    <div className="min-w-0">
                      {item.certificate_id ? (
                        <Link
                          to={`/cert/${item.certificate_id}`}
                          className="block truncate text-sm font-medium hover:underline"
                        >
                          {label}
                        </Link>
                      ) : (
                        <span className="block truncate text-sm font-medium">{label}</span>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {item.condition_grade != null
                          ? `Grade ${item.condition_grade.toFixed(1)} · `
                          : ""}
                        {timeAgo(item.created_at)}
                      </p>
                    </div>
                    {item.certificate_id && (
                      <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-600" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
