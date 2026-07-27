import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  ListChecks,
  Plus,
  Upload,
  ArrowRight,
  MoreVertical,
  Archive,
  ArchiveRestore,
  Trash2,
  FileText,
} from "lucide-react";
import { SEO } from "@/components/seo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useAllTasks,
  useCreateProject,
  useDeleteProject,
  useImportMarkdown,
  useTaskProjects,
  useUpdateProject,
} from "@/hooks/use-admin-tasks";
import {
  parseTaskMarkdown,
  summarizeImport,
  type ParsedImport,
} from "@/lib/admin-tasks-import";
import type { AdminTaskProjectRow, AdminTaskRow } from "@/types/database";

const SAMPLE_MARKDOWN = `# Project Title
> Short description of what this guide accomplishes.

## Phase 1 · First section
- [ ] First step !high @2026-06-01
  Indented lines become the step's instructions.
- [x] A step already done

## Phase 2 · Next section
- [ ] Another step`;

export function AdminTasksPage() {
  const { data: projects = [], isLoading } = useTaskProjects();
  const { data: allTasks = [] } = useAllTasks();
  const [showArchived, setShowArchived] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, AdminTaskRow[]>();
    for (const t of allTasks) {
      const arr = map.get(t.project_id) ?? [];
      arr.push(t);
      map.set(t.project_id, arr);
    }
    return map;
  }, [allTasks]);

  const visible = projects.filter((p) => showArchived || !p.archived);

  return (
    <div className="space-y-6">
      <SEO title="Tasks" noindex />
      <PageHeader
        icon={ListChecks}
        title="Tasks"
        subtitle={
          <>
            Break setup guides into trackable steps. Each project opens as a
            kanban board.
          </>
        }
        actions={
          <>
            <div className="flex items-center gap-2 pr-2">
              <Switch
                id="show-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
              />
              <Label htmlFor="show-archived" className="text-sm font-normal">
                Show archived
              </Label>
            </div>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Import from Markdown
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              No projects yet. Create one or import a Markdown checklist.
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                Import from Markdown
              </Button>
              <Button onClick={() => setNewOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New Project
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              tasks={tasksByProject.get(project.id) ?? []}
            />
          ))}
        </div>
      )}

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projects={projects}
      />
    </div>
  );
}

function ProjectCard({
  project,
  tasks,
}: {
  project: AdminTaskProjectRow;
  tasks: AdminTaskRow[];
}) {
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const ordered = [...tasks].sort((a, b) => a.position - b.position);
  const nextUp = ordered.find((t) => t.status !== "done");
  const counts = {
    todo: tasks.filter((t) => t.status === "todo").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
  };

  return (
    <Card className={project.archived ? "opacity-60" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              <Link
                to={`/admin/tasks/${project.id}`}
                className="hover:underline"
              >
                {project.title}
              </Link>
              {project.archived && (
                <Badge variant="secondary" className="ml-2 align-middle">
                  Archived
                </Badge>
              )}
            </CardTitle>
            {project.description && (
              <CardDescription className="mt-1 line-clamp-2">
                {project.description}
              </CardDescription>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                aria-label="Project actions"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  updateProject.mutate(
                    { id: project.id, patch: { archived: !project.archived } },
                    {
                      onSuccess: () =>
                        toast.success(
                          project.archived ? "Project restored." : "Project archived.",
                        ),
                      onError: (e) => toast.error((e as Error).message),
                    },
                  )
                }
              >
                {project.archived ? (
                  <>
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                    Restore
                  </>
                ) : (
                  <>
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {done} / {total} done
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <Progress value={pct} className="h-2" />
        </div>

        <div className="flex flex-wrap gap-1.5 text-xs">
          {counts.todo > 0 && (
            <Badge variant="outline">{counts.todo} to do</Badge>
          )}
          {counts.in_progress > 0 && (
            <Badge variant="outline" className="border-sky-400 text-sky-700 dark:text-sky-300">
              {counts.in_progress} in progress
            </Badge>
          )}
          {counts.blocked > 0 && (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-300">
              {counts.blocked} blocked
            </Badge>
          )}
        </div>

        {nextUp ? (
          <div className="rounded-md border border-brand-navy/30 bg-brand-navy/5 p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-brand-navy dark:text-foreground">
              Next up
            </div>
            <div className="mt-0.5 line-clamp-2 text-sm">{nextUp.title}</div>
          </div>
        ) : total > 0 ? (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2.5 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            All steps complete 🎉
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-2.5 text-sm text-muted-foreground">
            No steps yet.
          </div>
        )}

        <Button asChild variant="outline" className="w-full">
          <Link to={`/admin/tasks/${project.id}`}>
            Open board
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              "{project.title}" and its {total} task
              {total === 1 ? "" : "s"} (plus comments) will be permanently
              deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleteProject.mutate(project.id, {
                  onSuccess: () => toast.success("Project deleted."),
                  onError: (e) => toast.error((e as Error).message),
                })
              }
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const createProject = useCreateProject();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  function reset() {
    setTitle("");
    setDescription("");
  }

  function submit() {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    createProject.mutate(
      { title: title.trim(), description: description.trim() || null },
      {
        onSuccess: () => {
          toast.success("Project created.");
          reset();
          onOpenChange(false);
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Create an empty project, then add steps on its board.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="np-title">Title</Label>
            <Input
              id="np-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. iOS Release Setup"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-desc">Description</Label>
            <Textarea
              id="np-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createProject.isPending}>
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projects: AdminTaskProjectRow[];
}) {
  const importMarkdown = useImportMarkdown();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>("new");

  const parsed: ParsedImport | null = useMemo(
    () => (text.trim() ? parseTaskMarkdown(text) : null),
    [text],
  );
  const summary = parsed ? summarizeImport(parsed) : null;

  function reset() {
    setText("");
    setTarget("new");
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setText);
  }

  function submit() {
    if (!parsed || parsed.tasks.length === 0) {
      toast.error("Nothing to import — add at least one - [ ] step.");
      return;
    }
    importMarkdown.mutate(
      {
        parsed,
        existingProjectId: target === "new" ? undefined : target,
      },
      {
        onSuccess: () => {
          toast.success(
            `Imported ${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}.`,
          );
          reset();
          onOpenChange(false);
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  }

  const activeProjects = projects.filter((p) => !p.archived);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import from Markdown</DialogTitle>
          <DialogDescription>
            Paste a checklist in the supported format. <code>#</code> = project,{" "}
            <code>##</code> = section, <code>- [ ]</code> = step. Optional{" "}
            <code>!high</code>/<code>!low</code> and <code>@YYYY-MM-DD</code>{" "}
            tokens set priority and due date.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-1">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">Create new project</SelectItem>
                {activeProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    Add to: {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload className="mr-2 h-4 w-4" />
                Upload .md
                <input
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  className="hidden"
                  onChange={onFile}
                />
              </label>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setText(SAMPLE_MARKDOWN)}
            >
              Insert sample
            </Button>
          </div>

          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE_MARKDOWN}
            rows={12}
            className="h-64 resize-y overflow-y-auto font-mono text-xs [field-sizing:fixed]"
          />

          {summary && parsed && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              {target === "new" ? (
                <>
                  Will create project{" "}
                  <span className="font-medium">"{parsed.title}"</span> with{" "}
                </>
              ) : (
                <>Will add </>
              )}
              <span className="font-medium">{summary.taskCount}</span> task
              {summary.taskCount === 1 ? "" : "s"} across{" "}
              <span className="font-medium">{summary.sectionCount}</span> section
              {summary.sectionCount === 1 ? "" : "s"}
              {summary.sections.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({summary.sections.join(", ")})
                </span>
              )}
              .
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              importMarkdown.isPending || !parsed || parsed.tasks.length === 0
            }
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
