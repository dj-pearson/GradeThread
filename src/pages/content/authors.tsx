import { useEffect, useState } from "react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Plus, Trash2, ExternalLink } from "lucide-react";
import {
  useBlogAuthors,
  useCreateAuthor,
  useDeleteAuthor,
  useUpdateAuthor,
} from "@/hooks/use-content";
import type { ContentAuthorRow } from "@/types/database";
import { toast } from "sonner";

// US-874: author-entity management. Authors picked here back the blog editor's
// author dropdown and the public /authors/:slug E-E-A-T pages.
export function AuthorsPage() {
  const { data: authors = [], isLoading } = useBlogAuthors();
  const create = useCreateAuthor();
  const del = useDeleteAuthor();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = authors.find((a) => a.id === selectedId) ?? null;

  const newAuthor = async () => {
    const name = window.prompt("Author name?");
    if (!name?.trim()) return;
    const created = await create.mutateAsync({ name: name.trim() });
    setSelectedId(created.id);
  };

  return (
    <div className="space-y-4">
      <SEO title="Authors" noindex />
      <PageHeader
        title="Authors"
        subtitle="Named authors with bio pages + Person structured data for E-E-A-T. Link a post to an author in the blog editor."
        actions={
          <Button onClick={newAuthor} disabled={create.isPending}>
            <Plus className="mr-2 h-4 w-4" /> New author
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4">
                <LoadingRegion label="Loading authors">
                  <SkeletonRows rows={4} />
                </LoadingRegion>
              </div>
            ) : authors.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                No authors yet.
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {authors.map((a) => (
                    <tr
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${a.name}`}
                      className={`cursor-pointer border-b hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                        a.id === selectedId ? "bg-muted/50" : ""
                      }`}
                      onClick={() => setSelectedId(a.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        setSelectedId(a.id);
                      }}
                    >
                      <td className="p-3">
                        <div className="font-medium">{a.name}</div>
                        {a.title && (
                          <div className="text-xs text-muted-foreground">
                            {a.title}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        <a
                          href={`/authors/${a.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mr-1 inline-flex"
                          title="View live"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`View ${a.name}'s author page`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          title="Delete"
                          aria-label={`Delete ${a.name}`}
                          disabled={del.isPending}
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (
                              await confirm({
                                title: `Delete "${a.name}"?`,
                                description:
                                  "Posts linked to this author keep their byline text but lose the entity link.",
                                confirmLabel: "Delete author",
                                destructive: true,
                              })
                            ) {
                              if (selectedId === a.id) setSelectedId(null);
                              del.mutate(a.id);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {selected ? (
          <AuthorForm key={selected.id} author={selected} />
        ) : (
          <Card>
            <CardContent className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              Select an author to edit, or create one.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function AuthorForm({ author }: { author: ContentAuthorRow }) {
  const update = useUpdateAuthor();
  const [name, setName] = useState(author.name);
  const [slug, setSlug] = useState(author.slug);
  const [title, setTitle] = useState(author.title ?? "");
  const [avatarUrl, setAvatarUrl] = useState(author.avatar_url ?? "");
  const [bioMd, setBioMd] = useState(author.bio_md ?? "");
  const [credentials, setCredentials] = useState(
    (author.credentials ?? []).join("\n"),
  );
  const [sameAs, setSameAs] = useState((author.same_as ?? []).join("\n"));

  // Reset local state when the selected author changes (key remounts, but be safe).
  useEffect(() => {
    setName(author.name);
    setSlug(author.slug);
    setTitle(author.title ?? "");
    setAvatarUrl(author.avatar_url ?? "");
    setBioMd(author.bio_md ?? "");
    setCredentials((author.credentials ?? []).join("\n"));
    setSameAs((author.same_as ?? []).join("\n"));
  }, [author]);

  const linesOf = (s: string) =>
    s.split("\n").map((l) => l.trim()).filter(Boolean);

  const save = async () => {
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    await update.mutateAsync({
      id: author.id,
      name: name.trim(),
      slug: slug.trim() || undefined,
      title: title.trim() || null,
      avatar_url: avatarUrl.trim() || null,
      bio_md: bioMd.trim() || null,
      credentials: linesOf(credentials),
      same_as: linesOf(sameAs),
    });
    toast.success("Saved.");
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="au-name">Name</Label>
            <Input
              id="au-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="au-slug">Slug</Label>
            <Input
              id="au-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto from name"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="au-title">Title (jobTitle)</Label>
          <Input
            id="au-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Lead Condition Analyst"
          />
        </div>
        <div>
          <Label htmlFor="au-avatar">Avatar URL</Label>
          <Input
            id="au-avatar"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div>
          <Label htmlFor="au-bio">Bio (Markdown)</Label>
          <Textarea
            id="au-bio"
            value={bioMd}
            onChange={(e) => setBioMd(e.target.value)}
            rows={5}
            placeholder="A short professional bio. Blank lines separate paragraphs."
          />
        </div>
        <div>
          <Label htmlFor="au-credentials">Credentials (one per line)</Label>
          <Textarea
            id="au-credentials"
            value={credentials}
            onChange={(e) => setCredentials(e.target.value)}
            rows={3}
            placeholder={"Authored the GradeThread grading standard\n10+ years reselling apparel"}
          />
        </div>
        <div>
          <Label htmlFor="au-sameas">Profile links (one URL per line)</Label>
          <Textarea
            id="au-sameas"
            value={sameAs}
            onChange={(e) => setSameAs(e.target.value)}
            rows={3}
            placeholder={"https://www.linkedin.com/in/…\nhttps://x.com/…"}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Surfaced as Person.sameAs structured data + visible links.
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save author"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
