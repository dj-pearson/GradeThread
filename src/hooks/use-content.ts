import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { supabase } from "@/lib/supabase";
import { track } from "@/lib/analytics";
import type {
  BlogPostListRow,
  BlogPostRow,
  ContentAuthorRow,
  ContentKnowledgeListRow,
  ContentKnowledgeRow,
  ContentProduct,
  ContentSettingsRow,
  ContentSurface,
  ContentTopicRow,
  SocialPlatform,
  SocialPlatformVariantRow,
  SocialPostRow,
  TopicStatus,
} from "@/types/database";

// All content hooks fetch through edgeFetch. US-1634: this mints a FRESH access
// token per request and retries once on a 401 with a force-refreshed token —
// the old authHeader() sent getSession()'s possibly-expired token with no retry,
// so an admin whose tab lapsed past the 1h token boundary got a dead 401.
// Admin-only routes are gated on the edge by adminAuthMiddleware (non-admin → 403).
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

// ───────────────────────────────────────────────────────────────────
// BLOG POSTS
// ───────────────────────────────────────────────────────────────────

interface BlogListFilters {
  status?: string;
  product_focus?: string;
}

export function useBlogPosts(filters: BlogListFilters = {}) {
  return useQuery({
    queryKey: ["blog_posts", filters],
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.product_focus)
        params.set("product_focus", filters.product_focus);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await jfetch<{ posts: BlogPostListRow[] }>(
        `/api/content/blog${qs}`,
      );
      return data.posts;
    },
  });
}

export function useBlogPost(id: string | null) {
  return useQuery({
    queryKey: ["blog_post", id],
    enabled: !!id,
    queryFn: async () => {
      const data = await jfetch<{ post: BlogPostRow & { tags: string[] } }>(
        `/api/content/blog/${id}`,
      );
      return data.post;
    },
  });
}

// US-874: author entities for the blog editor's author picker + admin page.
export function useBlogAuthors() {
  return useQuery({
    queryKey: ["content_authors"],
    staleTime: 60_000,
    queryFn: async () => {
      const data = await jfetch<{ authors: ContentAuthorRow[] }>(
        `/api/content/authors`,
      );
      return data.authors;
    },
  });
}

export interface AuthorInput {
  name?: string;
  slug?: string;
  title?: string | null;
  bio_md?: string | null;
  avatar_url?: string | null;
  credentials?: string[];
  same_as?: string[];
}

export function useCreateAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthorInput) => {
      const data = await jfetch<{ author: ContentAuthorRow }>(
        `/api/content/authors`,
        { method: "POST", json: input },
      );
      return data.author;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["content_authors"] }),
    onError: (e: Error) => toastError(e),
  });
}

export function useUpdateAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: AuthorInput & { id: string }) => {
      const data = await jfetch<{ author: ContentAuthorRow }>(
        `/api/content/authors/${id}`,
        { method: "PATCH", json: patch },
      );
      return data.author;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["content_authors"] }),
    onError: (e: Error) => toastError(e),
  });
}

export function useDeleteAuthor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await jfetch<{ ok: true }>(`/api/content/authors/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["content_authors"] }),
    onError: (e: Error) => toastError(e),
  });
}

export function useCreateBlogPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      product_focus?: ContentProduct;
      topic_id?: string | null;
    }) => {
      const data = await jfetch<{ post: BlogPostRow }>(`/api/content/blog`, {
        method: "POST",
        json: input,
      });
      return data.post;
    },
    onSuccess: (post) => {
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
      // US-255: content telemetry. surface + product_focus on every event.
      track("content.draft.created", {
        surface: "blog",
        product_focus: post.product_focus,
      });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useUpdateBlogPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<BlogPostRow> & { tags?: string[] }) => {
      const data = await jfetch<{ post: BlogPostRow }>(
        `/api/content/blog/${id}`,
        { method: "PATCH", json: patch },
      );
      return data.post;
    },
    onSuccess: () => {
      // US-1633: the PATCH response omits tags (they're returned/stored
      // separately), so caching it directly into ["blog_post", id] wiped the
      // cached post's tags — and the NEXT save then read that tag-less cache and
      // PATCHed with no tags, deleting them. Invalidate so the authoritative
      // full post (with tags) is refetched instead.
      qc.invalidateQueries({ queryKey: ["blog_post", id] });
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useDeleteBlogPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await jfetch<{ ok: true }>(`/api/content/blog/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function usePublishBlogPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const data = await jfetch<{ post: BlogPostRow }>(
        `/api/content/blog/${id}/publish`,
        { method: "POST", json: {} },
      );
      return data.post;
    },
    onSuccess: (post) => {
      qc.setQueryData(["blog_post", id], post);
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
      toast.success("Published.");
      track("content.published", {
        surface: "blog",
        product_focus: post.product_focus,
      });
    },
    onError: (e: Error) => toastError(e),
  });
}

// US-254: one A/B title candidate per slot (question / listicle / contrarian).
export interface TitleSuggestion {
  style: "question" | "listicle" | "contrarian";
  title: string;
}

export function useGenerateBlogPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { topic?: Record<string, unknown> }) => {
      const data = await jfetch<{
        post: BlogPostRow;
        meta: Record<string, unknown>;
        title_suggestions?: TitleSuggestion[];
        flagged?: boolean;
        flag_reason?: string | null;
      }>(`/api/content/blog/${id}/generate`, { method: "POST", json: input ?? {} });
      return data;
    },
    onSuccess: ({ post, flagged, flag_reason }) => {
      qc.setQueryData(["blog_post", id], post);
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
      // Generated articles publish on completion. The content-safety review is
      // advisory (2026-07): a flagged article still publishes, tagged for review.
      if (post.status === "published" && flagged) {
        toast.warning(
          flag_reason
            ? `Published — flagged for review: ${flag_reason}`
            : "Published — flagged by the content safety check; review when you can.",
        );
      } else if (post.status === "published") {
        toast.success("Article generated & published.");
      } else {
        toast.success("Draft generated.");
      }
      track("content.generated", {
        surface: "blog",
        product_focus: post.product_focus,
      });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useCreatePreviewLink(postId: string) {
  return useMutation({
    mutationFn: async (input?: { ttl_seconds?: number }) => {
      const data = await jfetch<{
        url: string;
        token: string;
        expires_at: string;
      }>(`/api/content/blog/${postId}/preview-link`, {
        method: "POST",
        json: input ?? {},
      });
      return data;
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useGenerateHero(postId: string, surface: "blog" | "social" = "blog") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { prompt?: string }) => {
      const data = await jfetch<{ url: string; path: string }>(
        `/api/content/images/hero`,
        { method: "POST", json: { post_id: postId, surface, ...input } },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blog_post", postId] });
      toast.success("Hero generated.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// ───────────────────────────────────────────────────────────────────
// SOCIAL POSTS
// ───────────────────────────────────────────────────────────────────

export function useSocialPosts(filters: BlogListFilters = {}) {
  return useQuery({
    queryKey: ["social_posts", filters],
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.product_focus)
        params.set("product_focus", filters.product_focus);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await jfetch<{ posts: SocialPostRow[] }>(
        `/api/content/social${qs}`,
      );
      return data.posts;
    },
  });
}

export function useSocialPost(id: string | null) {
  return useQuery({
    queryKey: ["social_post", id],
    enabled: !!id,
    queryFn: async () => {
      const data = await jfetch<{ post: SocialPostRow }>(
        `/api/content/social/${id}`,
      );
      return data.post;
    },
  });
}

export function useUpdateSocialPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<SocialPostRow>) => {
      const data = await jfetch<{ post: SocialPostRow }>(
        `/api/content/social/${id}`,
        { method: "PATCH", json: patch },
      );
      return data.post;
    },
    onSuccess: (post) => {
      qc.setQueryData(["social_post", id], post);
      qc.invalidateQueries({ queryKey: ["social_posts"] });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useSuggestHashtags(id: string) {
  return useMutation({
    mutationFn: async () => {
      const data = await jfetch<{ hashtags: string[] }>(
        `/api/content/social/${id}/suggest-hashtags`,
        { method: "POST", json: {} },
      );
      return data.hashtags;
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useGenerateSocialPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: {
      topic?: Record<string, unknown>;
      utm_campaign?: string;
    }) => {
      const data = await jfetch<{
        post: SocialPostRow;
        meta: Record<string, unknown>;
      }>(`/api/content/social/${id}/generate`, {
        method: "POST",
        json: input ?? {},
      });
      return data;
    },
    onSuccess: ({ post }) => {
      qc.setQueryData(["social_post", id], post);
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      qc.invalidateQueries({ queryKey: ["social_variants", id] });
      toast.success("Generated.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// US-871: set or override a social post's branded card. Pass `image_base64` to
// upload a custom override (validated + EXIF-stripped server-side), or omit it
// to (re)generate the auto branded card URL from the post body.
export function useSetSocialCard(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: {
      ratio?: "landscape" | "square" | "portrait" | "pin";
      kind?: "title" | "quote" | "stat";
      text?: string;
      image_base64?: string;
    }) => {
      const data = await jfetch<{ url: string; path: string | null; source: string }>(
        `/api/content/images/social-card`,
        { method: "POST", json: { post_id: id, ...(input ?? {}) } },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social_post", id] });
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      toast.success("Social card updated.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// Video distribution: attach a video clip to a social post. The edge hands back
// a short-lived signed upload URL for the public content-videos bucket; we
// complete the PUT client-side (raw bytes never route through the edge fn) and
// the post flips to a video post pointing at the deterministic public URL.
export function useAttachSocialVideo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const { upload, url } = await jfetch<{
        upload: { path: string; token: string; signedUrl: string };
        url: string;
        path: string;
      }>(`/api/content/images/video`, {
        method: "POST",
        json: { post_id: id, filename: file.name },
      });
      const { error } = await supabase.storage
        .from("content-videos")
        .uploadToSignedUrl(upload.path, upload.token, file);
      if (error) throw new Error(error.message);
      return { url };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social_post", id] });
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      toast.success("Video attached — this post will publish as a video.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// Video distribution: drop the attached clip and revert to a still-image post.
export function useClearSocialVideo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await jfetch<{ ok: boolean }>(`/api/content/images/video/clear`, {
        method: "POST",
        json: { post_id: id },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social_post", id] });
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      toast.success("Video removed.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// US-870: per-platform variants for a social post.
export function useSocialVariants(id: string | null) {
  return useQuery({
    queryKey: ["social_variants", id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await jfetch<{ variants: SocialPlatformVariantRow[] }>(
        `/api/content/social/${id}/variants`,
      );
      return data.variants;
    },
  });
}

export function useUpdateSocialVariant(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      platform: SocialPlatform;
      body?: string;
      hashtags?: string[];
    }) => {
      const { platform, ...patch } = input;
      const data = await jfetch<{ variant: SocialPlatformVariantRow }>(
        `/api/content/social/${id}/variants/${platform}`,
        { method: "PATCH", json: patch },
      );
      return data.variant;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social_variants", id] });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function usePublishSocialPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const data = await jfetch<{ post: SocialPostRow }>(
        `/api/content/social/${id}/publish`,
        { method: "POST", json: {} },
      );
      return data.post;
    },
    onSuccess: (post) => {
      qc.setQueryData(["social_post", id], post);
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      toast.success("Published.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// ───────────────────────────────────────────────────────────────────
// TOPIC BANK
// ───────────────────────────────────────────────────────────────────

interface TopicFilters {
  surface?: ContentSurface;
  product_focus?: ContentProduct;
  status?: TopicStatus;
}

export function useContentTopics(filters: TopicFilters = {}) {
  return useQuery({
    queryKey: ["content_topics", filters],
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.surface) params.set("surface", filters.surface);
      if (filters.product_focus)
        params.set("product_focus", filters.product_focus);
      if (filters.status) params.set("status", filters.status);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await jfetch<{ topics: ContentTopicRow[] }>(
        `/api/content/topics${qs}`,
      );
      return data.topics;
    },
  });
}

export function useTopicCounts() {
  return useQuery({
    queryKey: ["content_topic_counts"],
    staleTime: 30_000,
    queryFn: async () => {
      const data = await jfetch<{ counts: Record<string, number> }>(
        `/api/content/topics/counts`,
      );
      return data.counts;
    },
  });
}

export function useResearchTopics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      surface: ContentSurface;
      product_focus: ContentProduct;
      count?: number;
    }) => {
      const data = await jfetch<{
        inserted: number;
        rejected_duplicates: number;
      }>(`/api/content/topics/research`, { method: "POST", json: input });
      return data;
    },
    onSuccess: ({ inserted, rejected_duplicates }, variables) => {
      qc.invalidateQueries({ queryKey: ["content_topics"] });
      qc.invalidateQueries({ queryKey: ["content_topic_counts"] });
      toast.success(
        `Added ${inserted} topic${inserted === 1 ? "" : "s"}${
          rejected_duplicates ? ` (${rejected_duplicates} dupes rejected)` : ""
        }.`,
      );
      track("topic.researched", {
        surface: variables.surface,
        product_focus: variables.product_focus,
        inserted,
      });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useRejectTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await jfetch<{ topic: ContentTopicRow }>(
        `/api/content/topics/${id}/reject`,
        { method: "POST", json: {} },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["content_topics"] });
      qc.invalidateQueries({ queryKey: ["content_topic_counts"] });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function usePromoteTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await jfetch<{
        post: BlogPostRow | SocialPostRow;
        surface: "blog" | "social";
      }>(`/api/content/topics/${id}/promote`, { method: "POST", json: {} });
      return data;
    },
    onSuccess: ({ surface }) => {
      qc.invalidateQueries({ queryKey: ["content_topics"] });
      qc.invalidateQueries({
        queryKey: surface === "blog" ? ["blog_posts"] : ["social_posts"],
      });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useAddTopics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      surface: ContentSurface;
      product_focus: ContentProduct;
      candidates: Array<{
        title: string;
        angle?: string;
        primary_keyword: string;
        secondary_keywords?: string[];
        search_intent?: string;
      }>;
    }) => {
      const data = await jfetch<{ inserted: number; rejected: number }>(
        `/api/content/topics/bulk`,
        { method: "POST", json: input },
      );
      return data;
    },
    onSuccess: ({ inserted, rejected }) => {
      qc.invalidateQueries({ queryKey: ["content_topics"] });
      qc.invalidateQueries({ queryKey: ["content_topic_counts"] });
      toast.success(
        `Added ${inserted}${rejected ? ` (${rejected} dupes rejected)` : ""}.`,
      );
    },
    onError: (e: Error) => toastError(e),
  });
}

// ───────────────────────────────────────────────────────────────────
// KNOWLEDGE DOCS
// ───────────────────────────────────────────────────────────────────

export function useKnowledgeDocs() {
  return useQuery({
    queryKey: ["content_knowledge"],
    staleTime: 60_000,
    queryFn: async () => {
      const data = await jfetch<{ docs: ContentKnowledgeListRow[] }>(
        `/api/content/knowledge`,
      );
      return data.docs;
    },
  });
}

export function useKnowledgeDoc(key: string | null) {
  return useQuery({
    queryKey: ["content_knowledge", key],
    enabled: !!key,
    queryFn: async () => {
      const data = await jfetch<{ doc: ContentKnowledgeRow }>(
        `/api/content/knowledge/${key}`,
      );
      return data.doc;
    },
  });
}

export function useSaveKnowledgeDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      key: string;
      title?: string;
      body_md: string;
    }) => {
      const data = await jfetch<{ doc: ContentKnowledgeRow }>(
        `/api/content/knowledge/${input.key}`,
        { method: "PUT", json: { title: input.title, body_md: input.body_md } },
      );
      return data.doc;
    },
    onSuccess: (doc) => {
      qc.setQueryData(["content_knowledge", doc.key], doc);
      qc.invalidateQueries({ queryKey: ["content_knowledge"] });
      toast.success("Saved.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// ───────────────────────────────────────────────────────────────────
// SETTINGS
// ───────────────────────────────────────────────────────────────────

export function useContentSettings() {
  return useQuery({
    queryKey: ["content_settings"],
    staleTime: 60_000,
    queryFn: async () => {
      const data = await jfetch<{ settings: ContentSettingsRow }>(
        `/api/content/settings`,
      );
      return data.settings;
    },
  });
}

export function useUpdateContentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<ContentSettingsRow>) => {
      const data = await jfetch<{ settings: ContentSettingsRow }>(
        `/api/content/settings`,
        { method: "PATCH", json: patch },
      );
      return data.settings;
    },
    onSuccess: (settings) => {
      qc.setQueryData(["content_settings"], settings);
      toast.success("Settings saved.");
    },
    onError: (e: Error) => toastError(e),
  });
}

// ───────────────────────────────────────────────────────────────────
// SCHEDULER
// ───────────────────────────────────────────────────────────────────

export function useSchedulerTick() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: {
      force_surface?: ContentSurface;
      force_product?: "gradethread" | "flipdesk";
    }) => {
      const data = await jfetch<{
        skipped?: boolean;
        reason?: string;
        surface?: string;
        product_focus?: string;
        post_id?: string;
        status?: "draft" | "published";
        refilled_topics?: number;
      }>(`/api/content/scheduler/tick`, {
        method: "POST",
        json: input ?? {},
      });
      return data;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["blog_posts"] });
      qc.invalidateQueries({ queryKey: ["social_posts"] });
      qc.invalidateQueries({ queryKey: ["content_topics"] });
      qc.invalidateQueries({ queryKey: ["content_topic_counts"] });
      if (r.skipped) {
        toast.info(r.reason ?? "Nothing to generate.");
      } else {
        toast.success(
          `Generated ${r.surface} post (${r.product_focus}) — status: ${r.status}.`,
        );
      }
    },
    onError: (e: Error) => toastError(e),
  });
}

// US-880: trigger the weekly content digest email on demand (the same endpoint
// the Monday cron hits). Lets the owner verify delivery + recommendations from
// the dashboard without waiting for the schedule.
export function useSendContentDigest() {
  return useMutation({
    mutationFn: async () => {
      const data = await jfetch<{
        ok: boolean;
        delivered: boolean;
        reason?: string;
        window_days: number;
        recommendations: number;
        recommendation_codes?: string[];
      }>(`/api/content/scheduler/digest`, { method: "POST", json: {} });
      return data;
    },
    onSuccess: (r) => {
      if (r.delivered) {
        toast.success(
          `Digest sent — ${r.recommendations} recommendation${
            r.recommendations === 1 ? "" : "s"
          }.`,
        );
      } else if (r.reason === "no_recipient") {
        toast.error(
          "No digest recipient configured (set CONTENT_DIGEST_EMAIL or SMTP_ADMIN_EMAIL).",
        );
      } else {
        toast.error("Digest could not be delivered — check email/SMTP config.");
      }
    },
    onError: (e: Error) => toastError(e),
  });
}

export interface ContentStats {
  bank: Record<string, number>;
  published_7d: {
    blog: Record<string, number>;
    social: Record<string, number>;
  };
  published_30d: {
    blog: Record<string, number>;
    social: Record<string, number>;
  };
  webhooks: {
    success_rate_last_100: number | null;
    total_last_100: number;
    failed_last_7d: number;
  };
  ai_usage_30d: { input_tokens: number; output_tokens: number };
  recent: {
    blog: Array<{
      id: string;
      slug: string;
      title: string;
      product_focus: string;
      published_at: string;
    }>;
    social: Array<{
      id: string;
      short_body: string;
      long_body: string;
      product_focus: string;
      published_at: string;
    }>;
  };
}

export function useContentStats() {
  return useQuery({
    queryKey: ["content_stats"],
    staleTime: 60_000,
    queryFn: async () => {
      const data = await jfetch<ContentStats>(`/api/content/settings/stats`);
      return data;
    },
  });
}

export interface WebhookDelivery {
  id: string;
  event: string;
  format: string | null;
  target_url: string;
  attempt_no: number;
  http_status: number | null;
  succeeded: boolean;
  error: string | null;
  created_at: string;
}

export function useWebhookLog(failedOnly = false) {
  return useQuery({
    queryKey: ["content_webhook_log", failedOnly],
    staleTime: 15_000,
    queryFn: async () => {
      const qs = failedOnly ? "?failed_only=1" : "";
      const data = await jfetch<{ deliveries: WebhookDelivery[] }>(
        `/api/content/settings/webhooks/log${qs}`,
      );
      return data.deliveries;
    },
  });
}

export function useRetryWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (logId: string) => {
      const data = await jfetch<{
        delivered: boolean;
        attempts: number;
        last_status: number | null;
      }>(`/api/content/settings/webhooks/${logId}/retry`, {
        method: "POST",
        json: {},
      });
      return data;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["content_webhook_log"] });
      if (r.delivered) {
        toast.success(`Delivered (status ${r.last_status}).`);
      } else {
        toast.error(
          `Retry failed after ${r.attempts} attempts (last status ${r.last_status ?? "—"}).`,
        );
      }
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useTestWebhook() {
  return useMutation({
    mutationFn: async (
      target: "blog" | "social_long" | "social_short" | "social",
    ) => {
      const data = await jfetch<{
        succeeded: boolean;
        http_status: number;
        latency_ms: number;
        error: string | null;
      }>(`/api/content/settings/webhooks/test`, {
        method: "POST",
        json: { target },
      });
      return data;
    },
    onError: (e: Error) => toastError(e),
  });
}
