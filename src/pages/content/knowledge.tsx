import { useEffect, useState } from "react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SEED_KNOWLEDGE_KEYS } from "@/lib/constants";
import {
  useKnowledgeDoc,
  useKnowledgeDocs,
  useSaveKnowledgeDoc,
} from "@/hooks/use-content";

// Knowledge docs page. List on the left, editor on the right.
// We use a plain textarea here (not Tiptap) — these docs are markdown
// references loaded straight into prompts; an HTML WYSIWYG would
// generate HTML the prompts can't easily consume.
export function KnowledgePage() {
  const { data: docs, isLoading } = useKnowledgeDocs();
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Default to first doc on first load.
  useEffect(() => {
    if (!activeKey && docs && docs.length > 0) {
      const first = docs[0];
      if (first) setActiveKey(first.key);
    }
  }, [docs, activeKey]);

  return (
    <div className="space-y-4">
      <SEO title="Knowledge Docs" noindex />
      <div>
        <h1 className="text-2xl font-bold">Knowledge</h1>
        <p className="text-sm text-muted-foreground">
          Reference docs loaded into every AI prompt. Edit voice, style, and SEO
          pillars here — changes take effect on the next generation.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Docs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            {isLoading && (
              <p className="p-2 text-sm text-muted-foreground">Loading…</p>
            )}
            {(docs ?? []).map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setActiveKey(d.key)}
                className={`flex w-full flex-col rounded-md p-2 text-left text-sm hover:bg-accent ${
                  activeKey === d.key ? "bg-accent" : ""
                }`}
              >
                <span className="font-medium">{d.title}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {d.key} · ~{d.token_count_est} tok
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="md:col-span-2">
          {activeKey ? (
            <KnowledgeEditor docKey={activeKey} />
          ) : (
            <Card>
              <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                Select a doc to edit.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function KnowledgeEditor({ docKey }: { docKey: string }) {
  const { data: doc, isLoading } = useKnowledgeDoc(docKey);
  const save = useSaveKnowledgeDoc();
  const isSeed = SEED_KNOWLEDGE_KEYS.includes(
    docKey as (typeof SEED_KNOWLEDGE_KEYS)[number],
  );

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (doc) {
      setTitle(doc.title);
      setBody(doc.body_md);
    }
  }, [doc]);

  if (isLoading || !doc) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  const tokenEst = Math.ceil(body.length / 4);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle className="text-base">
            <span className="font-mono text-sm text-muted-foreground">
              {doc.key}
            </span>
          </CardTitle>
          {isSeed && (
            <Badge variant="secondary" className="text-xs">
              Seed doc
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">~{tokenEst} tokens</div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label htmlFor="kd-title">Title</Label>
          <Input
            id="kd-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="kd-body">Body (Markdown)</Label>
          <Textarea
            id="kd-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[420px] font-mono text-sm"
          />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ key: doc.key, title, body_md: body })
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
