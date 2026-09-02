import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { layoutDocument, normalize, personaOf } from "@/lib/dashboard-layout";
import {
  LAYOUT_VERSION,
  widgetsForSurface,
  type DashboardSurface,
  type LayoutEntry,
  type WidgetDef,
  type WidgetPersona,
} from "@/lib/dashboard-widgets";

// US-3073: reading and saving the widget board's layout.
//
// TOLERANT BY DESIGN, the src/hooks/use-review-flow.ts pattern. The frontend
// auto-deploys on push while migration 00722 is applied to prod by hand, so
// this read WILL hit a table that does not exist yet. A `42P01` must not take
// the overview down: any read failure resolves to the last known layout, and
// failing that to the persona default, which is a working board. There is no
// error state on this query and nothing to retry.
//
// The last known layout is also mirrored to localStorage so the board paints
// its shape on the first frame instead of after the round trip. The mirror is
// normalized on read exactly like the server copy, because it is the same kind
// of stale document: written by an older client, against an older registry.

const TABLE = "dashboard_layouts";
const MIRROR_PREFIX = "gt:dashboard-layout:";

export function dashboardLayoutKey(
  userId: string | undefined,
  surface: DashboardSurface,
) {
  return [TABLE, userId, surface] as const;
}

function mirrorKey(surface: DashboardSurface): string {
  return `${MIRROR_PREFIX}${surface}`;
}

/** The mirrored document, or null when there is none / storage is unavailable. */
function readMirrorDocument(surface: DashboardSurface): unknown {
  try {
    const raw = localStorage.getItem(mirrorKey(surface));
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeMirror(surface: DashboardSurface, widgets: readonly LayoutEntry[]): void {
  try {
    localStorage.setItem(mirrorKey(surface), JSON.stringify(layoutDocument(widgets)));
  } catch {
    /* private mode, quota, or no window; the server copy is the record */
  }
}

/**
 * The layout to show when the server has not answered (or cannot): the mirror
 * if there is one, else the persona default. Both go through normalize(), so
 * neither can put a retired widget or a disallowed size on the board.
 */
function fallbackLayout(
  surface: DashboardSurface,
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
): LayoutEntry[] {
  const mirrored = readMirrorDocument(surface);
  if (mirrored) return normalize(mirrored, registry, persona);
  return normalize(null, registry, persona);
}

export interface DashboardLayoutResult {
  /** The widgets to render, in order. Never empty-by-accident, never an error. */
  layout: LayoutEntry[];
  /** The registry for this surface, so callers do not re-derive it. */
  registry: readonly WidgetDef[];
  persona: WidgetPersona;
  /** True only before the first paint of the fallback; the board still renders. */
  isLoading: boolean;
  /** True once the layout on screen came from the server. */
  isFromServer: boolean;
}

export function useDashboardLayout(surface: DashboardSurface): DashboardLayoutResult {
  const user = useAuthStore((s) => s.user);
  const useCase = useAuthStore((s) => s.profile?.use_case);
  const persona = personaOf(useCase);
  const registry = useMemo(() => widgetsForSurface(surface), [surface]);

  const query = useQuery({
    queryKey: dashboardLayoutKey(user?.id, surface),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    // Paint the last known shape immediately; the fetch replaces it.
    placeholderData: () => fallbackLayout(surface, registry, persona),
    queryFn: async (): Promise<LayoutEntry[]> => {
      const { data, error } = await supabase
        .from(TABLE)
        .select("layout")
        .eq("user_id", user!.id)
        .eq("surface", surface)
        .maybeSingle();

      // Table absent, RLS surprise, offline: all the same answer here.
      if (error) return fallbackLayout(surface, registry, persona);

      const document = (data as { layout?: unknown } | null)?.layout ?? null;
      const widgets = normalize(document, registry, persona);
      writeMirror(surface, widgets);
      return widgets;
    },
  });

  return {
    layout: query.data ?? fallbackLayout(surface, registry, persona),
    registry,
    persona,
    isLoading: query.isLoading,
    isFromServer: query.isSuccess && !query.isPlaceholderData,
  };
}

/**
 * Save a layout. Optimistic: the board shows the new order before the write
 * lands, and a failure puts the previous one back and says so.
 */
export function useSaveDashboardLayout(surface: DashboardSurface) {
  const user = useAuthStore((s) => s.user);
  const useCase = useAuthStore((s) => s.profile?.use_case);
  const persona = personaOf(useCase);
  const registry = useMemo(() => widgetsForSurface(surface), [surface]);
  const queryClient = useQueryClient();
  const key = dashboardLayoutKey(user?.id, surface);

  return useMutation<
    LayoutEntry[],
    Error,
    readonly LayoutEntry[],
    { previous: LayoutEntry[] | undefined }
  >({
    mutationFn: async (widgets) => {
      if (!user) throw new Error("You must be signed in.");
      const normalized = normalize(layoutDocument(widgets), registry, persona);
      const { error } = await supabase.from(TABLE).upsert(
        {
          user_id: user.id,
          surface,
          layout: layoutDocument(normalized),
          version: LAYOUT_VERSION,
        } as never,
        { onConflict: "user_id,surface" },
      );
      if (error) throw error;
      return normalized;
    },
    onMutate: async (widgets) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LayoutEntry[]>(key);
      const next = normalize(layoutDocument(widgets), registry, persona);
      queryClient.setQueryData(key, next);
      writeMirror(surface, next);
      return { previous };
    },
    onError: (_error, _widgets, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
        writeMirror(surface, context.previous);
      }
      toast.error("Could not save your layout. Your last saved one is back.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
