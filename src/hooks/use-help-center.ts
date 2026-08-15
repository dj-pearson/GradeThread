import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import type {
  HelpArticle,
  HelpArticleInput,
  HelpCategory,
} from "@/types/help-center";

// Help Center hooks (US-2574). Two audiences, two base paths:
//   /api/content/help  admin authoring (this file's mutations + the full list)
//   /api/help          the members-only reader (US-2583)
// Both go through edgeFetch, which mints a fresh access token per request and
// retries once on a 401 with a force-refreshed token (US-1634) — the reason the
// content hooks stopped dying when an admin's tab lapsed past the 1h boundary.

async function jfetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const res = await edgeFetch(path, { ...init, json: init?.json, silentGate: true });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

const ARTICLES_KEY = ["help_articles"];
const CATEGORIES_KEY = ["help_categories"];

export function useHelpCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const data = await jfetch<{ categories: HelpCategory[] }>(
        "/api/content/help/categories",
      );
      return data.categories;
    },
  });
}

/** Every article including drafts and internals. Admin only, by the mount. */
export function useHelpArticles() {
  return useQuery({
    queryKey: ARTICLES_KEY,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await jfetch<{ articles: HelpArticle[] }>("/api/content/help");
      return data.articles;
    },
  });
}

export function useHelpArticle(id: string | undefined) {
  return useQuery({
    queryKey: [...ARTICLES_KEY, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const data = await jfetch<{ article: HelpArticle }>(`/api/content/help/${id}`);
      return data.article;
    },
  });
}

export function useCreateHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: HelpArticleInput) => {
      const data = await jfetch<{ article: HelpArticle }>("/api/content/help", {
        method: "POST",
        json: input,
      });
      return data.article;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: HelpArticleInput & { id: string }) => {
      const data = await jfetch<{ article: HelpArticle }>(`/api/content/help/${id}`, {
        method: "PATCH",
        json: input,
      });
      return data.article;
    },
    onSuccess: (article) => {
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
      void qc.setQueryData([...ARTICLES_KEY, article.id], article);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await jfetch<{ ok: true }>(`/api/content/help/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: () => {
      toast.success("Article deleted.");
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
