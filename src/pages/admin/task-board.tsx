import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  MessageSquare,
  CalendarClock,
  Sparkles,
  Filter,
} from "lucide-react";
import { toast } from "sonner";
import { SEO } from "@/components/seo";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import {
  projectTasksKey,
  useAddComment,
  useCreateTask,
  useDeleteComment,
  useDeleteTask,
  useProjectTasks,
  useTaskComments,
  useTaskCommentCounts,
  useTaskProjects,
  useUpdateProject,
  useUpdateTask,
} from "@/hooks/use-admin-tasks";
import type {
  AdminTaskPriority,
  AdminTaskRow,
  AdminTaskStatus,
} from "@/types/database";

const COLUMNS: { status: AdminTaskStatus; label: string }[] = [
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const STATUS_LABEL: Record<AdminTaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
};

const PRIORITY_BADGE: Record<AdminTaskPriority, { label: string; cls: string }> = {
  high: { label: "High", cls: "border-brand-red text-brand-red-text" },
  medium: { label: "Med", cls: "border-slate-300 text-slate-600" },
  low: { label: "Low", cls: "border-slate-200 text-slate-400" },
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(task: AdminTaskRow): boolean {
  return (
    task.status !== "done" &&
    task.due_date != null &&
    task.due_date < todayISO()
  );
}

function fmtDue(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AdminTaskBoardPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: projects = [] } = useTaskProjects();
  const project = projects.find((p) => p.id === projectId);

  const { data: tasks = [], isLoading } = useProjectTasks(projectId);
  const updateTask = useUpdateTask();

  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState<string>("all");
  const [activeDrag, setActiveDrag] = useState<AdminTaskRow | null>(null);
  const [detailTask, setDetailTask] = useState<AdminTaskRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addStatus, setAddStatus] = useState<AdminTaskStatus>("todo");
  const [editProjectOpen, setEditProjectOpen] = useState(false);

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const { data: commentCounts = {} } = useTaskCommentCounts(taskIds);

  const sections = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.section) set.add(t.section);
    return Array.from(set);
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (sectionFilter !== "all" && (t.section ?? "") !== sectionFilter) {
        return false;
      }
      if (q) {
        const hay = [t.title, t.body, t.section]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, search, sectionFilter]);

  const groups = useMemo(() => {
    const map = new Map<AdminTaskStatus, AdminTaskRow[]>();
    for (const c of COLUMNS) map.set(c.status, []);
    for (const t of filtered) map.get(t.status)?.push(t);
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [filtered]);

  // The first To-Do card (by position) is the "Next up" step.
  const nextUpId = groups.get("todo")?.[0]?.id ?? null;

  function handleDragStart(e: DragStartEvent) {
    setActiveDrag(tasks.find((t) => t.id === String(e.active.id)) ?? null);
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    if (!e.over || !projectId) return;
    const taskId = String(e.active.id);
    const target = String(e.over.id) as AdminTaskStatus;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === target) return;

    const completed_at =
      target === "done" ? new Date().toISOString() : null;

    // Optimistic cache write, mirroring the FlipDesk pipeline board.
    const prev = tasks;
    qc.setQueryData<AdminTaskRow[]>(projectTasksKey(projectId), (old) =>
      (old ?? []).map((t) =>
        t.id === taskId ? { ...t, status: target, completed_at } : t,
      ),
    );

    try {
      await updateTask.mutateAsync({
        id: taskId,
        patch: { status: target, completed_at },
      });
    } catch (err) {
      qc.setQueryData(projectTasksKey(projectId), prev);
      toast.error(`Move failed: ${(err as Error).message}`);
    }
  }

  if (!isLoading && !project) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/admin/tasks">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to projects
          </Link>
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Project not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SEO title={project ? `${project.title} · Tasks` : "Tasks"} noindex />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-2 h-7">
            <Link to="/admin/tasks">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Projects
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">
              {project?.title ?? "…"}
            </h1>
            {project && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setEditProjectOpen(true)}
                aria-label="Edit project"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {project?.description && (
            <p className="max-w-2xl text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
        </div>
        <Button
          onClick={() => {
            setAddStatus("todo");
            setAddOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add task
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search tasks"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="w-56"
        />
        {sections.length > 0 && (
          <Select value={sectionFilter} onValueChange={setSectionFilter}>
            <SelectTrigger className="w-52" aria-label="Filter tasks by section">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Section" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sections</SelectItem>
              {sections.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Loading board…
          </CardContent>
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <div className="overflow-x-auto pb-4">
            <div className="flex gap-3" style={{ minWidth: "max-content" }}>
              {COLUMNS.map((col) => {
                const colTasks = groups.get(col.status) ?? [];
                return (
                  <DroppableColumn
                    key={col.status}
                    status={col.status}
                    label={col.label}
                    count={colTasks.length}
                    onAdd={() => {
                      setAddStatus(col.status);
                      setAddOpen(true);
                    }}
                  >
                    {colTasks.length === 0 ? (
                      <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                        Drop here
                      </div>
                    ) : (
                      colTasks.map((t) => (
                        <DraggableTaskCard
                          key={t.id}
                          task={t}
                          isNext={t.id === nextUpId}
                          commentCount={commentCounts[t.id] ?? 0}
                          onClick={() => setDetailTask(t)}
                        />
                      ))
                    )}
                  </DroppableColumn>
                );
              })}
            </div>
          </div>
          <DragOverlay>
            {activeDrag ? (
              <TaskCardVisual task={activeDrag} commentCount={0} dragging />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {detailTask && (
        <TaskDetailDialog
          task={tasks.find((t) => t.id === detailTask.id) ?? detailTask}
          knownSections={sections}
          onClose={() => setDetailTask(null)}
        />
      )}
      {projectId && (
        <AddTaskDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          projectId={projectId}
          initialStatus={addStatus}
          knownSections={sections}
          maxPosition={tasks.reduce((m, t) => Math.max(m, t.position), -1)}
        />
      )}
      {project && editProjectOpen && (
        <EditProjectDialog
          open={editProjectOpen}
          onOpenChange={setEditProjectOpen}
          projectId={project.id}
          initialTitle={project.title}
          initialDescription={project.description ?? ""}
        />
      )}
    </div>
  );
}

function DroppableColumn({
  status,
  label,
  count,
  onAdd,
  children,
}: {
  status: AdminTaskStatus;
  label: string;
  count: number;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  return (
    <div className="w-[280px] flex-shrink-0">
      <Card
        ref={setNodeRef}
        className={cn(
          "flex h-full flex-col transition-colors",
          isOver && "border-brand-navy bg-brand-navy/5 ring-2 ring-brand-navy",
        )}
      >
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">{label}</CardTitle>
            <Badge variant="outline" className="font-mono text-xs">
              {count}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onAdd}
            aria-label={`Add task to ${label}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="flex-1 space-y-2 px-3 pb-3">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function DraggableTaskCard({
  task,
  isNext,
  commentCount,
  onClick,
}: {
  task: AdminTaskRow;
  isNext: boolean;
  commentCount: number;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-30")}>
      <div
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={0}
        aria-label={`Open task: ${task.title}`}
        onClick={onClick}
        onKeyDown={(e) => {
          // Enter opens the task; other keys (Space) fall through to the
          // dnd-kit keyboard sensor so drag-to-reorder still works.
          if (e.key === "Enter") {
            e.preventDefault();
            onClick();
          } else {
            listeners?.onKeyDown?.(e);
          }
        }}
        className="cursor-grab rounded-md active:cursor-grabbing"
      >
        <TaskCardVisual
          task={task}
          isNext={isNext}
          commentCount={commentCount}
        />
      </div>
    </div>
  );
}

function TaskCardVisual({
  task,
  isNext = false,
  commentCount,
  dragging = false,
}: {
  task: AdminTaskRow;
  isNext?: boolean;
  commentCount: number;
  dragging?: boolean;
}) {
  const overdue = isOverdue(task);
  const prio = PRIORITY_BADGE[task.priority];
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-2.5 text-left transition-shadow",
        isNext && "border-brand-navy ring-2 ring-brand-navy/40",
        dragging && "shadow-lg ring-2 ring-brand-navy",
      )}
    >
      {isNext && (
        <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-brand-navy dark:text-foreground">
          <Sparkles className="h-3 w-3" />
          Next up
        </div>
      )}
      <div className="line-clamp-3 text-xs font-medium leading-tight">
        {task.title}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.section && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {task.section}
          </Badge>
        )}
        {task.priority !== "medium" && (
          <Badge
            variant="outline"
            className={cn("px-1.5 py-0 text-[10px]", prio.cls)}
          >
            {prio.label}
          </Badge>
        )}
        {task.due_date && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[10px]",
              overdue ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            <CalendarClock className="h-2.5 w-2.5" />
            {fmtDue(task.due_date)}
          </span>
        )}
        {commentCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <MessageSquare className="h-2.5 w-2.5" />
            {commentCount}
          </span>
        )}
      </div>
    </div>
  );
}

function TaskDetailDialog({
  task,
  knownSections,
  onClose,
}: {
  task: AdminTaskRow;
  knownSections: string[];
  onClose: () => void;
}) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const { data: comments = [] } = useTaskComments(task.id);
  const addComment = useAddComment();
  const deleteComment = useDeleteComment();

  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [section, setSection] = useState(task.section ?? "");
  const [priority, setPriority] = useState<AdminTaskPriority>(task.priority);
  const [status, setStatus] = useState<AdminTaskStatus>(task.status);
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [commentText, setCommentText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function save() {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    const completed_at =
      status === "done"
        ? task.completed_at ?? new Date().toISOString()
        : null;
    updateTask.mutate(
      {
        id: task.id,
        patch: {
          title: title.trim(),
          body: body.trim() || null,
          section: section.trim() || null,
          priority,
          status,
          due_date: dueDate || null,
          completed_at,
        },
      },
      {
        onSuccess: () => {
          toast.success("Task saved.");
          onClose();
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  }

  function postComment() {
    const body = commentText.trim();
    if (!body) return;
    addComment.mutate(
      { taskId: task.id, body },
      {
        onSuccess: () => setCommentText(""),
        onError: (e) => toast.error((e as Error).message),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Task details</DialogTitle>
          <DialogDescription>
            Edit the step, change its status, and discuss in comments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="td-title">Title</Label>
            <Input
              id="td-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="td-body">Instructions</Label>
            <Textarea
              id="td-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Markdown / plain text details for this step"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="td-status">Status</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as AdminTaskStatus)}
              >
                <SelectTrigger id="td-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLUMNS.map((c) => (
                    <SelectItem key={c.status} value={c.status}>
                      {STATUS_LABEL[c.status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="td-priority">Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as AdminTaskPriority)}
              >
                <SelectTrigger id="td-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="td-section">Section</Label>
              <Input
                id="td-section"
                list="td-section-options"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                // A datalist option picked by mouse fires only `change`, which a
                // controlled input's onChange (input-event only) misses — the
                // pick would revert on re-render. Commit the DOM value on blur.
                onBlur={(e) => {
                  if (e.currentTarget.value !== section)
                    setSection(e.currentTarget.value);
                }}
                placeholder="e.g. Phase 1"
              />
              <datalist id="td-section-options">
                {knownSections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="td-due">Due date</Label>
              <Input
                id="td-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Comments</Label>
            {comments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No comments yet.</p>
            ) : (
              <ul className="space-y-2">
                {comments.map((c) => (
                  <li
                    key={c.id}
                    className="group flex items-start justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="whitespace-pre-wrap break-words">
                        {c.body}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {new Date(c.created_at).toLocaleString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Delete comment: ${c.body.slice(0, 40)}`}
                      onClick={() =>
                        deleteComment.mutate({ id: c.id, taskId: task.id })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-start gap-2">
              <Textarea
                aria-label="Add a comment"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a comment…"
                rows={2}
                className="flex-1"
              />
              <Button
                onClick={postComment}
                disabled={addComment.isPending || !commentText.trim()}
              >
                Post
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete task
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={updateTask.isPending}>
              Save
            </Button>
          </div>
        </DialogFooter>

        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this task?</AlertDialogTitle>
              <AlertDialogDescription>
                "{task.title}" and its comments will be permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() =>
                  deleteTask.mutate(
                    { id: task.id, projectId: task.project_id },
                    {
                      onSuccess: () => {
                        toast.success("Task deleted.");
                        onClose();
                      },
                      onError: (e) => toast.error((e as Error).message),
                    },
                  )
                }
              >
                Delete task
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function AddTaskDialog({
  open,
  onOpenChange,
  projectId,
  initialStatus,
  knownSections,
  maxPosition,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  initialStatus: AdminTaskStatus;
  knownSections: string[];
  maxPosition: number;
}) {
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [section, setSection] = useState("");
  const [priority, setPriority] = useState<AdminTaskPriority>("medium");
  const [dueDate, setDueDate] = useState("");

  function reset() {
    setTitle("");
    setBody("");
    setSection("");
    setPriority("medium");
    setDueDate("");
  }

  function submit() {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    createTask.mutate(
      {
        project_id: projectId,
        title: title.trim(),
        body: body.trim() || null,
        section: section.trim() || null,
        status: initialStatus,
        priority,
        due_date: dueDate || null,
        position: maxPosition + 1,
        completed_at:
          initialStatus === "done" ? new Date().toISOString() : null,
      },
      {
        onSuccess: () => {
          toast.success("Task added.");
          reset();
          onOpenChange(false);
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
          <DialogDescription>
            New step in “{STATUS_LABEL[initialStatus]}”.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="at-title">Title</Label>
            <Input
              id="at-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="at-body">Instructions</Label>
            <Textarea
              id="at-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Optional"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="at-section">Section</Label>
              <Input
                id="at-section"
                list="at-section-options"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                // Commit a mouse-picked datalist value on blur — see td-section.
                onBlur={(e) => {
                  if (e.currentTarget.value !== section)
                    setSection(e.currentTarget.value);
                }}
                placeholder="Optional"
              />
              <datalist id="at-section-options">
                {knownSections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="at-priority">Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as AdminTaskPriority)}
              >
                <SelectTrigger id="at-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="at-due">Due date</Label>
              <Input
                id="at-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createTask.isPending}>
            Add task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({
  open,
  onOpenChange,
  projectId,
  initialTitle,
  initialDescription,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  initialTitle: string;
  initialDescription: string;
}) {
  const updateProject = useUpdateProject();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);

  function submit() {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    updateProject.mutate(
      {
        id: projectId,
        patch: {
          title: title.trim(),
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast.success("Project updated.");
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
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ep-title">Title</Label>
            <Input
              id="ep-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ep-desc">Description</Label>
            <Textarea
              id="ep-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={updateProject.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
