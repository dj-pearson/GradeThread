import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BookOpen,
  Search,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownPreview } from "@/components/admin/markdown-preview";
import {
  getRunbook,
  searchRunbooks,
  type Runbook,
  type RunbookControl,
} from "@/lib/admin/runbooks";

// US-910 — Operations runbooks. Curated, build-time-bundled operational
// playbooks (deploy order, rollback, restore drill, crons, kill-switches,
// incident response, launch readiness) rendered in-app so on-call has the
// playbook where the controls are. Each runbook deep-links to the relevant
// admin control. Read-only; no secrets are rendered (content-check enforced).

function ControlLink({ control }: { control: RunbookControl }) {
  return (
    <Button asChild variant="outline" size="sm" className="h-auto justify-start py-2">
      <Link to={control.to} className="flex flex-col items-start gap-0.5 text-left">
        <span className="flex items-center gap-1.5 font-medium">
          <ExternalLink className="h-3.5 w-3.5" />
          {control.label}
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {control.description}
        </span>
      </Link>
    </Button>
  );
}

function RunbookDetail({ runbook }: { runbook: Runbook }) {
  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/admin/ops/runbooks">
            <ArrowLeft className="mr-1 h-4 w-4" />
            All runbooks
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-brand-navy" />
          <h1 className="text-2xl font-bold">{runbook.title}</h1>
          <Badge variant="secondary">{runbook.category}</Badge>
        </div>
        <p className="mt-1 text-muted-foreground">{runbook.summary}</p>
      </div>

      {runbook.controls.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jump to the controls</CardTitle>
            <CardDescription>
              Deep links to the live admin controls this runbook governs.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {runbook.controls.map((control) => (
              <ControlLink key={control.to} control={control} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <MarkdownPreview source={runbook.body} />
        </CardContent>
      </Card>
    </div>
  );
}

function RunbookIndex() {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchRunbooks(query), [query]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-brand-navy" />
          <h1 className="text-2xl font-bold">Operations runbooks</h1>
        </div>
        <p className="mt-1 text-muted-foreground">
          The on-call playbook, in-app — deploy order, rollback, restore drill,
          scheduled jobs, kill-switches and incident response, each linked to the
          control it governs.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search runbooks…"
          className="pl-9"
          aria-label="Search runbooks"
        />
      </div>

      {results.length === 0 ? (
        <p className="px-1 py-6 text-sm text-muted-foreground">
          No runbooks match “{query}”.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {results.map((runbook) => (
            <Link
              key={runbook.slug}
              to={`/admin/ops/runbooks/${runbook.slug}`}
              className="group block focus:outline-none"
            >
              <Card className="h-full transition-colors group-hover:border-brand-navy/40 group-focus-visible:border-brand-navy">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{runbook.title}</CardTitle>
                    <Badge variant="secondary">{runbook.category}</Badge>
                  </div>
                  <CardDescription>{runbook.summary}</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="flex items-center text-sm font-medium text-brand-navy">
                    Open runbook
                    <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminOpsRunbooksPage() {
  const { slug } = useParams<{ slug?: string }>();
  const runbook = slug ? getRunbook(slug) : undefined;

  if (slug && !runbook) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/admin/ops/runbooks">
            <ArrowLeft className="mr-1 h-4 w-4" />
            All runbooks
          </Link>
        </Button>
        <p className="text-muted-foreground">
          No runbook found for “{slug}”.
        </p>
      </div>
    );
  }

  return runbook ? <RunbookDetail runbook={runbook} /> : <RunbookIndex />;
}
