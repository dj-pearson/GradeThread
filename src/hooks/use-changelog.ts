import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

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

async function authHeader(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in.");
  return `Bearer ${session.access_token}`;
}

async function jfetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${edgeApiUrl()}${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
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
    onError: (e: Error) => toast.error(e.message),
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
    onError: (e: Error) => toast.error(e.message),
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
    onError: (e: Error) => toast.error(e.message),
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
    onError: (e: Error) => toast.error(e.message),
  });
}
