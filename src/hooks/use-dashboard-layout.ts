import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useInventoryItemCount } from "@/hooks/use-inventory-item-count";
import { useConsignorCount } from "@/hooks/use-consignor-count";
import { layoutDocument, normalize, personaOf } from "@/lib/dashboard-layout";
import { readLayoutMirror, writeLayoutMirror } from "@/lib/dashboard-layout-mirror";
import {
  LAYOUT_VERSION,
  widgetsForSurface,
  type DashboardSurface,
  type LayoutContext,
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
// failing that to the persona default, which is a working board. Any OTHER
// read failure still paints the fallback, but reports isError and never
// isFromServer, so Customize cannot save the fallback over the real layout.
//
// The last known layout is also mirrored to localStorage (per user, see
// src/lib/dashboard-layout-mirror.ts) so the board paints
// its shape on the first frame instead of after the round trip. The mirror is
// normalized on read exactly like the server copy, because it is the same kind
// of stale document: written by an older client, against an older registry.

const TABLE = "dashboard_layouts";

export function dashboardLayoutKey(
  userId: string | undefined,
  surface: DashboardSurface,
) {
  return [TABLE, userId, surface] as const;
}

/** 42P01 (Postgres) or PGRST205 (PostgREST schema cache): the table is absent. */
function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/**
 * The layout to show when the server has not answered (or cannot): the mirror
 * if there is one, else the persona default. Both go through normalize(), so
 * neither can put a retired widget or a disallowed size on the board.
 */
function fallbackLayout(
  userId: string | undefined,
  surface: DashboardSurface,
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
  context: LayoutContext,
): LayoutEntry[] {
  const mirrored = readLayoutMirror(userId, surface);
  if (mirrored) return normalize(mirrored, registry, persona, context);
  return normalize(null, registry, persona, context);
}

/**
 * What normalize() needs to know about the account beyond its persona.
 *
 * Two questions so far: does this account have any inventory (US-3075 AC5) and
 * does it have any consignors (US-3078 AC6). Each count is undefined until it
 * resolves and undefined on failure, and an undefined field omits nothing, so a
 * widget can never flicker off the board and back on while a query is in
 * flight.
 */
function useLayoutContext(): LayoutContext {
  const itemCount = useInventoryItemCount();
  const consignorCount = useConsignorCount();
  return useMemo(
    () => ({
      hasInventory: itemCount === undefined ? undefined : itemCount > 0,
      hasConsignors: consignorCount === undefined ? undefined : consignorCount > 0,
    }),
    [itemCount, consignorCount],
  );
}

export interface DashboardLayoutResult {
  /** The widgets to render, in order. Never empty-by-accident, never an error. */
  layout: LayoutEntry[];
  /** The registry for this surface, so callers do not re-derive it. */
  registry: readonly WidgetDef[];
  persona: WidgetPersona;
  /** The account facts normalize() was given, so callers can reuse them. */
  context: LayoutContext;
  /** True only before the first paint of the fallback; the board still renders. */
  isLoading: boolean;
  /** True once the layout on screen came from the server. */
  isFromServer: boolean;
  /** The server read failed; the board shows the fallback. */
  isError: boolean;
  /** Retry the server read. */
  refetch: () => void;
}

export function useDashboardLayout(surface: DashboardSurface): DashboardLayoutResult {
  const user = useAuthStore((s) => s.user);
  const useCase = useAuthStore((s) => s.profile?.use_case);
  const persona = personaOf(useCase);
  const registry = useMemo(() => widgetsForSurface(surface), [surface]);
  const context = useLayoutContext();

  const query = useQuery({
    queryKey: dashboardLayoutKey(user?.id, surface),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    // Paint the last known shape immediately; the fetch replaces it.
    placeholderData: () => fallbackLayout(user?.id, surface, registry, persona, {}),
    queryFn: async (): Promise<LayoutEntry[]> => {
      const { data, error } = await supabase
        .from(TABLE)
        .select("layout")
        .eq("user_id", user!.id)
        .eq("surface", surface)
        .maybeSingle();

      // The table not existing yet is a known deploy window (00722 is applied
      // by hand), and there the fallback IS the answer. Anything else is a
      // failed read: throw, so the query retries and reports isError, and so
      // isFromServer stays false. Customize is disabled until it is true,
      // because saving over a layout that was never read overwrites it.
      if (error) {
        if (isMissingTable(error)) {
          return fallbackLayout(user?.id, surface, registry, persona, {});
        }
        throw error;
      }

      const document = (data as { layout?: unknown } | null)?.layout ?? null;
      const widgets = normalize(document, registry, persona);
      writeLayoutMirror(user?.id, surface, layoutDocument(widgets));
      return widgets;
    },
  });

  // The cache and the mirror hold the STORED shape, with no account facts
  // applied: the query key stays stable (the save mutation writes to it
  // optimistically), and a widget dropped for this account is not written back
  // as if the seller had hidden it. Applying the context here is the last step
  // before the board reads it, so omitWhen decides what renders and nothing
  // else. US-3075 AC5.
  const stored = query.data ?? fallbackLayout(user?.id, surface, registry, persona, {});
  const layout = normalize(layoutDocument(stored), registry, persona, context);

  return {
    layout,
    registry,
    persona,
    context,
    isLoading: query.isLoading,
    isFromServer: query.isSuccess && !query.isPlaceholderData,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/**
 * Save a layout. Optimistic: the board shows the new order before the write
 * lands, and a failure puts the previous one back. The caller says so.
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
      writeLayoutMirror(user?.id, surface, layoutDocument(next));
      return { previous };
    },
    // No toast here: the caller keeps the seller's draft open on a failure
    // and offers Retry, which only it can do.
    onError: (_error, _widgets, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
        writeLayoutMirror(user?.id, surface, layoutDocument(context.previous));
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
