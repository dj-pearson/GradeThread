import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import { useEbayConnection } from "@/hooks/use-ebay";
import { track } from "@/lib/analytics";
import {
  activationProgress,
  activationStepsFor,
  notificationsSupported,
  EMPTY_ACTIVATION_STATE,
  type ActivationState,
  type ActivationStep,
} from "@/lib/activation-steps";
import type { UserUpdate } from "@/types/database";

// US-2859. One hook, one set of queries, one dismissal — so every surface that
// shows the activation checklist is looking at the same answer.
//
// It replaces three independent implementations: activation-checklist.tsx ran
// its own counts and kept a localStorage dismissal, flipdesk-onboarding.tsx ran
// different counts and wrote users.flipdesk_onboarded, and dashboard.tsx's
// persona first-run card derived "is this account empty" a third way.

/**
 * WHERE THE DISMISSAL LIVES, and the one thing to know before changing it.
 *
 * `users.flipdesk_onboarded` is the flag. It is a column that already exists,
 * which matters: US-2398's neighbour (migration 00526) made public.users
 * self-updates deny-by-default, so a NEW column is not a column, it is a
 * migration plus an allowlist restatement plus a held push.
 *
 * Reusing it has one consequence, stated here rather than discovered later: an
 * account that previously dismissed the FlipDesk-only checklist already has
 * this set to true, and will therefore not see the merged checklist either.
 * That is the right answer — they told us they were set up — but it is a
 * behaviour change for that cohort, not a no-op.
 *
 * The localStorage mirror exists only so the card does not flash on load. The
 * column is the truth.
 */
function dismissKey(userId: string | undefined): string {
  return `gt.activation.dismissed:${userId ?? "anon"}`;
}

export interface UseActivationResult {
  /** The persona's ordered steps. Empty when there is nothing to show. */
  steps: ActivationStep[];
  state: ActivationState;
  done: number;
  total: number;
  /** Index of the step the user should do next; -1 when all are done. */
  firstIncomplete: number;
  /** True when the checklist should render at all. */
  active: boolean;
  /** Run a step: navigates, or asks for notification permission in place. */
  complete: (step: ActivationStep, navigate: (to: string) => void) => void;
  dismiss: () => void;
  /** Bring the checklist back. Wired to Settings > Replay. */
  undismiss: () => void;
}

export function useActivation(): UseActivationResult {
  const { profile, refreshProfile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const useCase = profile?.use_case ?? null;

  // Seeded synchronously so a dismissed card never flashes on a reload.
  const [locallyDismissed, setLocallyDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(dismissKey(user?.id)) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setLocallyDismissed(
      window.localStorage.getItem(dismissKey(user?.id)) === "1",
    );
  }, [user?.id]);

  const [notifPermission, setNotifPermission] = useState<
    NotificationPermission | "unsupported"
  >(notificationsSupported() ? Notification.permission : "unsupported");

  const steps = useMemo(() => activationStepsFor(useCase), [useCase]);
  const stepKeys = useMemo(() => new Set(steps.map((s) => s.key)), [steps]);

  // Wait for the first-run modal to finish capturing the use case before
  // showing anything — otherwise the checklist is built from a persona the
  // user has not chosen yet (US-742).
  const active =
    !!profile &&
    !!profile.onboarded_at &&
    !profile.flipdesk_onboarded &&
    !locallyDismissed &&
    steps.length > 0;

  const { data: counts } = useQuery({
    queryKey: ["activation-counts", user?.id, [...stepKeys].sort().join(",")],
    enabled: active && !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // Only the counts this persona's steps actually read. A head-count is
      // cheap, but four of them on every dashboard load for a developer who
      // will never see an inventory step is four too many.
      const head = (table: string) =>
        supabase.from(table).select("id", { count: "exact", head: true });
      const zero = Promise.resolve({ count: 0 });
      const [grade, item, source, apiKey] = await Promise.all([
        stepKeys.has("grade") ? head("submissions") : zero,
        stepKeys.has("item") ? head("inventory_items") : zero,
        stepKeys.has("source") ? head("sources") : zero,
        stepKeys.has("apikey") ? head("api_keys") : zero,
      ]);
      return {
        gradeCount: grade.count ?? 0,
        itemCount: item.count ?? 0,
        sourceCount: source.count ?? 0,
        apiKeyCount: apiKey.count ?? 0,
      };
    },
  });

  const { data: ebayConnection } = useEbayConnection();

  const state = useMemo<ActivationState>(
    () => ({
      ...EMPTY_ACTIVATION_STATE,
      ...(counts ?? {}),
      ebayConnected: !!ebayConnection,
      notificationsGranted: notifPermission === "granted",
    }),
    [counts, ebayConnection, notifPermission],
  );

  const { done, total, firstIncomplete } = activationProgress(steps, state);

  const dismiss = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(user?.id), "1");
    }
    setLocallyDismissed(true);
    track("onboarding.activation_checklist_dismissed", { use_case: useCase });
    if (!user) return;
    // Best effort. The local flag already hid the card, so a failure here costs
    // the user nothing today; it only means the card returns on another device.
    const update: UserUpdate = { flipdesk_onboarded: true };
    void supabase
      .from("users")
      .update(update as never)
      .eq("id", user.id)
      .then(() => refreshProfile());
  }, [refreshProfile, useCase, user]);

  const undismiss = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(dismissKey(user?.id));
    }
    setLocallyDismissed(false);
    if (!user) return;
    const update: UserUpdate = { flipdesk_onboarded: false };
    void supabase
      .from("users")
      .update(update as never)
      .eq("id", user.id)
      .then(() => refreshProfile());
  }, [refreshProfile, user]);

  const complete = useCallback(
    (step: ActivationStep, navigate: (to: string) => void) => {
      track("onboarding.activation_step_started", {
        step: step.key,
        use_case: useCase,
      });
      if (step.key !== "notifications") {
        if (step.to) navigate(step.to);
        return;
      }
      if (!notificationsSupported()) return;
      if (Notification.permission === "denied") {
        toast.error(
          "Notifications are blocked. Turn them on for this site in your browser settings.",
        );
        return;
      }
      void Notification.requestPermission()
        .then((result) => {
          setNotifPermission(result);
          if (result === "granted") {
            track("onboarding.notifications_enabled", {
              surface: "activation_checklist",
            });
            toast.success("Notifications are on.");
          }
        })
        .catch(() => toast.error("Couldn't turn notifications on."));
    },
    [useCase],
  );

  return {
    steps,
    state,
    done,
    total,
    firstIncomplete,
    // All done is the same as nothing to show. The card congratulating itself
    // is the fifth thing on a dashboard that already had four too many.
    active: active && firstIncomplete !== -1,
    complete,
    dismiss,
    undismiss,
  };
}
