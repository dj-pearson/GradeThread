import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Award, Share2, Sparkles, Trophy, Zap, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  LeaderboardSaveError,
  type LeaderboardPeriod,
  useMyLeaderboard,
  useSetLeaderboardOptIn,
} from "@/hooks/use-leaderboards";

// US-1856: the seller's own view of the public leaderboards — join, choose the
// name you appear under, and see where you currently stand.
//
// The opt-in is SEPARATE from the referral-board opt-in (US-864) and the buyer
// one (US-1814) on purpose. Each of those toggles' copy names what it publishes;
// these boards publish XP, graded volume and reactions, which neither sentence
// covers. Reusing an old toggle would make a promise somebody already read
// retroactively untrue, so this card states its own terms.

const ICONS: Record<string, LucideIcon> = { Award, Share2, Sparkles, Zap };

const PERIODS: { key: LeaderboardPeriod; label: string }[] = [
  { key: "weekly", label: "This week" },
  { key: "all_time", label: "All time" },
];

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

export function LeaderboardPanel() {
  const [period, setPeriod] = useState<LeaderboardPeriod>("all_time");
  const [alias, setAlias] = useState("");
  // Once the seller has typed, a refetch (a period switch, a window refocus)
  // must not overwrite what they typed with the stored value.
  const dirty = useRef(false);
  const { data, isLoading, isError, isFetching, refetch } = useMyLeaderboard(period);
  const save = useSetLeaderboardOptIn();

  // Seed the field with the name the seller TYPED, never the fallback. The
  // fallback shows as the placeholder instead, so an untouched field sends no
  // alias and joining does not pin a copy of the Verified or referral name.
  const savedAlias = data?.alias ?? "";
  useEffect(() => {
    if (!dirty.current) setAlias(savedAlias);
  }, [savedAlias]);

  const header = (
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-lg">
        <Trophy className="h-5 w-5 text-primary" />
        Leaderboards
      </CardTitle>
      <p className="text-sm text-muted-foreground">
        Four public boards (XP, grades, best finds and share-driven signups),
        ranked this week and all time. Joining publishes the name you choose,
        your rank and your score on each board. Nothing else: never your email,
        your real name or your account.{" "}
        <Link to="/leaderboards" className="font-medium hover:underline">
          See the boards
        </Link>
      </p>
    </CardHeader>
  );

  // First load: hold the space. Rendering the opted-out copy here told a
  // seller who IS on the boards that they were not, for a moment, every time.
  if (isLoading && !data) {
    return (
      <Card className="shadow-none">
        {header}
        <CardContent>
          <div role="status" aria-label="Loading your leaderboard standing" className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-8 w-48" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // A failed read keeps the card. Returning nothing hid the only "Hide me"
  // control a seller has, on exactly the day something was wrong.
  if (isError && !data) {
    return (
      <Card className="shadow-none">
        {header}
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Couldn't load your standing.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ enabled: false })}
            >
              Hide me from the boards
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const optIn = data?.opt_in === true;
  const trimmed = alias.trim();
  const resolved = data?.resolved_alias ?? null;
  // What to send as the alias: nothing when the field matches what they would
  // already appear as, so the fallback name is never pinned as a copy.
  const aliasToSend = trimmed && trimmed !== resolved ? trimmed : undefined;
  const renameChanged = trimmed ? trimmed !== resolved : !!data?.alias;
  // R4: the server's own sentence for a refused name, under the field.
  const aliasError = save.error instanceof LeaderboardSaveError && save.error.status === 400
    ? save.error.message
    : null;

  const submit = () => {
    if (save.isPending) return;
    if (optIn) {
      if (!renameChanged) return;
      save.mutate({ alias: trimmed || null }, { onSuccess: () => { dirty.current = false; } });
    } else {
      if (!trimmed && !resolved) return;
      save.mutate(
        { enabled: true, alias: aliasToSend },
        { onSuccess: () => { dirty.current = false; } },
      );
    }
  };

  return (
    <Card className="shadow-none">
      {header}
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="leaderboard-alias" className="text-xs text-muted-foreground">
              Public display name
            </Label>
            <Input
              id="leaderboard-alias"
              value={alias}
              onChange={(e) => {
                dirty.current = true;
                setAlias(e.target.value.slice(0, 40));
                if (save.isError) save.reset();
              }}
              placeholder={resolved ?? "e.g. ThriftKing"}
              maxLength={40}
              aria-invalid={aliasError ? true : undefined}
              aria-describedby={aliasError ? "leaderboard-alias-error" : undefined}
            />
            {aliasError ? (
              <p id="leaderboard-alias-error" role="alert" className="text-xs text-destructive">
                {aliasError}
              </p>
            ) : !data?.alias && resolved ? (
              <p className="text-xs text-muted-foreground">
                Leave this empty to use {resolved}, the name you already use publicly.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {optIn ? "You're on the boards." : "You're not on the boards yet."}
            </p>
            <div className="flex gap-2">
              {optIn ? (
                <>
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={save.isPending || !renameChanged}
                  >
                    Save name
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ enabled: false })}
                  >
                    Hide me
                  </Button>
                </>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  disabled={save.isPending || (!trimmed && !resolved)}
                >
                  {save.isPending ? "Saving…" : "Join the boards"}
                </Button>
              )}
            </div>
          </div>
        </form>

        {optIn ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Board period">
              {PERIODS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={period === p.key ? "default" : "outline"}
                  aria-pressed={period === p.key}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <ul
              className={cn("space-y-2 transition-opacity", isFetching && "opacity-60")}
              aria-busy={isFetching || undefined}
            >
              {(data?.standings ?? []).map((s) => {
                const Icon = ICONS[s.icon] ?? Trophy;
                return (
                  <li key={s.metric} className="flex items-center gap-3 text-sm">
                    <Icon
                      className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Link to={s.path} className="min-w-0 flex-1 truncate hover:underline">
                      {s.name}
                    </Link>
                    {s.rank == null ? (
                      // A zero score is "not on this board yet", never "last".
                      // Inventing a position would be a number nobody earned.
                      <Badge variant="outline" className="text-xs">
                        Not ranked yet
                      </Badge>
                    ) : (
                      <>
                        <span className="text-muted-foreground tabular-nums">
                          {num(s.score)} {s.score_label.toLowerCase()}
                        </span>
                        {/* aria-label on a plain span is ignored by most screen
                            readers (a generic role cannot be named), so the
                            spoken form is real text and the glyphs are hidden. */}
                        <span className="font-semibold tabular-nums">
                          <span aria-hidden="true">
                            #{s.rank}
                            {s.tied ? "=" : ""}
                          </span>
                          <span className="sr-only" data-testid="rank-spoken">
                            {s.tied ? `Rank ${s.rank}, tied` : `Rank ${s.rank}`}
                          </span>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
