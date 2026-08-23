import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { BadgeCheck, ExternalLink, Loader2, Tag } from "lucide-react";
import { safeHref } from "@/lib/safe-url";
import {
  useRegisteredNumbers,
  useResolveRegisteredNumber,
  type RegisteredNumberRegistryRow,
  type RegisteredNumberSighting,
} from "@/hooks/use-registered-numbers";

// US-2808: the operator queue for RN/CA registered numbers.
//
// US-2244 built the whole server side — a most-sighted-first queue, an
// include_resolved filter, an upsert that also takes the number off the queue
// and drops the 5-minute cross-check cache — and no screen ever reached any of
// it. This is that screen.
//
// AC1 asked whether the surface is wanted before building it, and the answer is
// in the pipeline rather than in an opinion: grading-pipeline.ts:1966 already
// records a sighting for every tag it reads, so this queue has been filling on
// live traffic the whole time. Resolving a number makes the very next grade
// corroborate the brand a tag claims. That is a live loop with a missing human
// step, not a speculative page.

const EMPTY_DRAFT = {
  company_name: "",
  brand_keys: "",
  source_url: "",
  notes: "",
  verified: false,
};

type Draft = typeof EMPTY_DRAFT;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function AdminRegisteredNumbersPage() {
  const [includeResolved, setIncludeResolved] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const { data, isLoading, isError, refetch } = useRegisteredNumbers(includeResolved);
  const resolve = useResolveRegisteredNumber();

  const registryByKey = useMemo(() => {
    const m = new Map<string, RegisteredNumberRegistryRow>();
    for (const row of data?.registry ?? []) m.set(row.registry_key, row);
    return m;
  }, [data]);

  const sightings = data?.sightings ?? [];
  const unresolvedCount = sightings.filter((s) => !s.resolved).length;
  const totalSightings = sightings.reduce((n, s) => n + (s.sighting_count ?? 0), 0);

  function startEdit(s: RegisteredNumberSighting) {
    const existing = registryByKey.get(s.registry_key);
    setActiveKey(s.registry_key);
    setDraft({
      company_name: existing?.company_name ?? "",
      // Prefill from the brands the TAGS declared. It is the operator's best
      // starting guess and it is already on screen; retyping it is the kind of
      // friction that makes a queue not get worked.
      brand_keys: (existing?.brand_keys ?? s.declared_brands ?? []).join(", "),
      source_url: existing?.source_url ?? "",
      notes: existing?.notes ?? "",
      verified: existing?.verified ?? false,
    });
  }

  function submit() {
    if (!activeKey) return;
    const brandKeys = draft.brand_keys
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    resolve.mutate(
      {
        registry_key: activeKey,
        company_name: draft.company_name.trim() || undefined,
        brand_keys: brandKeys,
        source_url: draft.source_url.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        verified: draft.verified,
      },
      { onSuccess: () => setActiveKey(null) },
    );
  }

  // The server rejects a row with neither a company nor a brand, because it
  // records nothing. Say so here rather than sending it and surfacing a 400.
  const canSubmit =
    draft.company_name.trim().length > 0 ||
    draft.brand_keys.split(",").some((b) => b.trim().length > 0);

  return (
    <>
      <PageHeader
        title="Registered Numbers"
        subtitle={
          <>
            RN and CA numbers read off care tags, most-sighted first. The FTC
            registry has no API, so these are resolved by hand — and resolving
            one makes the next grade corroborate the brand its tag claims.
          </>
        }
        actions={
          <div className="flex items-center gap-3">
            <Label htmlFor="include-resolved" className="text-sm font-normal">
              Show resolved
            </Label>
            <Switch
              id="include-resolved"
              checked={includeResolved}
              onCheckedChange={setIncludeResolved}
            />
          </div>
        }
      />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && (
        <ErrorState
          title="Could not load the queue"
          description="The registered-number queue did not load."
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !isError && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Unresolved numbers
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold">{unresolvedCount}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Tags they appear on
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold">{totalSightings}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Registrants recorded
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold">
                {data?.registry.length ?? 0}
              </CardContent>
            </Card>
          </div>

          {sightings.length === 0 && (
            // A real state with a real explanation. An empty queue here means
            // no graded tag has carried a number yet, not that the page broke.
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Tag className="mx-auto mb-3 h-8 w-8 opacity-40" />
                <p>
                  No {includeResolved ? "" : "unresolved "}numbers yet. Sightings
                  are recorded as grading reads care tags.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="space-y-4">
            {sightings.map((s) => {
              const known = registryByKey.get(s.registry_key);
              const isActive = activeKey === s.registry_key;
              // safeHref returns null for anything it will not vouch for
              // (javascript:, data:, a malformed URL). Render nothing rather
              // than an anchor with an empty href, which looks clickable and
              // is not, and tells the operator nothing about why.
              const sourceHref = safeHref(known?.source_url);
              return (
                <Card key={s.registry_key}>
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <CardTitle className="font-mono text-lg">
                          {s.kind} {s.digits}
                        </CardTitle>
                        <Badge variant="secondary">
                          {s.sighting_count} tag{s.sighting_count === 1 ? "" : "s"}
                        </Badge>
                        {s.resolved && <Badge variant="outline">Resolved</Badge>}
                        {known?.verified && (
                          <Badge className="gap-1">
                            <BadgeCheck className="h-3 w-3" />
                            Verified
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant={isActive ? "secondary" : "default"}
                        size="sm"
                        onClick={() => (isActive ? setActiveKey(null) : startEdit(s))}
                        aria-label={`${isActive ? "Cancel editing" : known ? "Edit" : "Resolve"} ${s.kind} ${s.digits}`}
                      >
                        {isActive ? "Cancel" : known ? "Edit" : "Resolve"}
                      </Button>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                      <div>
                        <span className="text-muted-foreground">Brands on the tags: </span>
                        {s.declared_brands?.length
                          ? s.declared_brands.join(", ")
                          : "none recorded"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Seen: </span>
                        {formatDate(s.first_seen_at)} to {formatDate(s.last_seen_at)}
                      </div>
                      {known?.company_name && (
                        <div>
                          <span className="text-muted-foreground">Registrant: </span>
                          {known.company_name}
                        </div>
                      )}
                      {sourceHref && (
                        <div>
                          <a
                            href={sourceHref}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 underline"
                          >
                            Source
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}
                    </div>

                    {isActive && (
                      <div className="space-y-4 border-t pt-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div>
                            <Label htmlFor={`company-${s.registry_key}`}>
                              Registered company
                            </Label>
                            <Input
                              id={`company-${s.registry_key}`}
                              value={draft.company_name}
                              onChange={(e) =>
                                setDraft({ ...draft, company_name: e.target.value })
                              }
                              placeholder="As the FTC registry spells it"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`brands-${s.registry_key}`}>
                              Brand keys (comma separated)
                            </Label>
                            <Input
                              id={`brands-${s.registry_key}`}
                              value={draft.brand_keys}
                              onChange={(e) =>
                                setDraft({ ...draft, brand_keys: e.target.value })
                              }
                              placeholder="levis, dockers"
                            />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor={`source-${s.registry_key}`}>Source URL</Label>
                          <Input
                            id={`source-${s.registry_key}`}
                            value={draft.source_url}
                            onChange={(e) =>
                              setDraft({ ...draft, source_url: e.target.value })
                            }
                            placeholder="Where this was confirmed"
                          />
                        </div>
                        <div>
                          <Label htmlFor={`notes-${s.registry_key}`}>Notes</Label>
                          <Textarea
                            id={`notes-${s.registry_key}`}
                            value={draft.notes}
                            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                            rows={2}
                          />
                        </div>
                        <div className="flex items-center gap-3">
                          <Switch
                            id={`verified-${s.registry_key}`}
                            checked={draft.verified}
                            onCheckedChange={(v) => setDraft({ ...draft, verified: v })}
                          />
                          <Label htmlFor={`verified-${s.registry_key}`} className="font-normal">
                            Confirmed against the FTC registry
                          </Label>
                        </div>
                        <div className="flex items-center gap-3">
                          <Button
                            onClick={submit}
                            disabled={!canSubmit || resolve.isPending}
                            aria-label={`Save the registrant for ${s.kind} ${s.digits}`}
                          >
                            {resolve.isPending && (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            Save
                          </Button>
                          {!canSubmit && (
                            <span className="text-sm text-muted-foreground">
                              Give a company, brand keys, or both — an empty row
                              records nothing.
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
