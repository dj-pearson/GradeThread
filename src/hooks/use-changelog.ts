import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";

// US-916: admin hooks for the product "What's New" changelog. All routes are
// gated on the edge by adminAuthMiddleware (admin JWT + AAL2); a non-admin
// session 403s.

export type ChangelogCategory = "feature" | "improvement" | "fix" | "announcement";
export type ChangelogAudience = "all" | "grading" | "flipdesk" | "verified";
export type ChangelogStatus = "draft" | "published";
export type ChangelogSource = "manual" | "auto";

export interface ChangelogEntryRow {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  category: ChangelogCategory;
  audience: ChangelogAudience;
  image_url: string | null;
  status: ChangelogStatus;
  published_at: string | null;
  source: ChangelogSource;
  source_ref: string | null;
  featured_at: string | null;
  featured_issue_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangelogInput {
  title?: string;
  summary?: string | null;
  body?: string | null;
  category?: ChangelogCategory;
  audience?: ChangelogAudience;
  image_url?: string | null;
  status?: ChangelogStatus;
}

// US-1634: fetch through edgeFetch — a fresh token per request + a 401-refresh
// retry, instead of getSession()'s possibly-expired token with no retry.
async function jfetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const res = await edgeFetch(path, {
    ...init,
    json: init?.json,
    silentGate: true,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

export function useChangelogEntries() {
  return useQuery({
    queryKey: ["changelog_entries"],
    staleTime: 15_000,
    queryFn: async () => {
      const data = await jfetch<{ entries: ChangelogEntryRow[] }>(
        `/api/admin/changelog`,
      );
      return data.entries;
    },
  });
}

export function useCreateChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangelogInput) =>
      jfetch<{ entry: ChangelogEntryRow }>(`/api/admin/changelog`, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["changelog_entries"] });
      toast.success("Entry created");
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useUpdateChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ChangelogInput }) =>
      jfetch<{ entry: ChangelogEntryRow }>(`/api/admin/changelog/${id}`, {
        method: "PATCH",
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["changelog_entries"] });
      toast.success("Entry saved");
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useDeleteChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      jfetch<{ ok: boolean }>(`/api/admin/changelog/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["changelog_entries"] });
      toast.success("Entry deleted");
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useAutoCaptureChangelog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      jfetch<{ ok: boolean; created: number }>(
        `/api/admin/changelog/auto-capture`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["changelog_entries"] });
      toast.success(
        data.created > 0
          ? `Drafted ${data.created} new ${data.created === 1 ? "entry" : "entries"}`
          : "No new blog posts to capture",
      );
    },
    onError: (e: Error) => toastError(e),
  });
}
