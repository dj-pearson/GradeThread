import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import { useEbayConnection } from "@/hooks/use-ebay";
import {
  extensionWebStoreUrl,
  isExtensionInstalled,
} from "@/lib/lister-extension";
import { track } from "@/lib/analytics";
import { trackActivation } from "@/lib/activation-analytics";
import {
  activationProgress,
  activationStepsFor,
  notificationsSupported,
  EMPTY_ACTIVATION_STATE,
  type ActivationState,
  type ActivationStep,
} from "@/lib/activation-steps";
import type { UserUpdate, UserUseCase } from "@/types/database";

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
/**
 * US-2883: KEYED BY PERSONA, and the column is written only for the personas
 * it is named after.
 *
 * `users.flipdesk_onboarded` is a SELLER flag. Writing it when a buyer
 * dismisses the buyer checklist would hide the seller checklist too -- and
 * every seller can shop (US-1887), so that is not a hypothetical account. The
 * buyer dismissal is therefore local-only: it is a preference about a card,
 * not a claim that the account is set up for selling.
 *
 * The seller key keeps its original spelling so an account that has already
 * dismissed the merged checklist stays dismissed. Renaming it would have
 * un-dismissed every existing seller at once.
 */
function dismissKey(
  userId: string | undefined,
  useCase: UserUseCase | null,
): string {
  const who = userId ?? "anon";
  return useCase === "buyer"
    ? `gt.activation.dismissed.buyer:${who}`
    : `gt.activation.dismissed:${who}`;
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

/**
 * US-2883: THE SHELL DECIDES THE PERSONA, not the profile alone.
 *
 * Every seller can shop (US-1887), so a dual-role account has one `use_case`
 * and meets two shells. Reading the profile alone would show a seller their
 * grade/item/eBay list on the BUYER home, which is the wrong list on the wrong
 * page. The buyer shell passes "buyer"; the seller shell passes nothing and
 * gets the profile's own persona.
 *
 * This is also why AC4 holds: switching shells changes which list is shown,
 * not whether onboarding has happened. Nothing here writes a completion flag.
 */
export function useActivation(
  personaOverride?: UserUseCase,
): UseActivationResult {
  const { profile, refreshProfile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const useCase = personaOverride ?? profile?.use_case ?? null;

  // Seeded synchronously so a dismissed card never flashes on a reload.
  const [locallyDismissed, setLocallyDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(dismissKey(user?.id, useCase)) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setLocallyDismissed(
      window.localStorage.getItem(dismissKey(user?.id, useCase)) === "1",
    );
  }, [user?.id, useCase]);

  const [notifPermission, setNotifPermission] = useState<
    NotificationPermission | "unsupported"
  >(notificationsSupported() ? Notification.permission : "unsupported");

  const steps = useMemo(() => activationStepsFor(useCase), [useCase]);
  const stepKeys = useMemo(() => new Set(steps.map((s) => s.key)), [steps]);

  // Wait for the first-run modal to finish capturing the use case before
  // showing anything — otherwise the checklist is built from a persona the
  // user has not chosen yet (US-742).
  // US-2883: `flipdesk_onboarded` gates the SELLER list only. A dual-role
  // account that dismissed the seller checklist has said nothing about the
  // buyer one, and gating both on one column would have meant most sellers
  // never saw the buyer steps at all.
  const active =
    !!profile &&
    !!profile.onboarded_at &&
    (useCase === "buyer" || !profile.flipdesk_onboarded) &&
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
      const [grade, item, source, apiKey, alert, closet] = await Promise.all([
        stepKeys.has("grade") ? head("submissions") : zero,
        stepKeys.has("item") ? head("inventory_items") : zero,
        stepKeys.has("source") ? head("sources") : zero,
        stepKeys.has("apikey") ? head("api_keys") : zero,
        // US-2883: the buyer's two. Both owner-scoped by RLS, so this cannot
        // see anyone else's, and both are skipped entirely for a seller.
        stepKeys.has("alert") ? head("saved_searches") : zero,
        stepKeys.has("closet") ? head("closet_items") : zero,
      ]);
      return {
        gradeCount: grade.count ?? 0,
        itemCount: item.count ?? 0,
        sourceCount: source.count ?? 0,
        apiKeyCount: apiKey.count ?? 0,
        alertCount: alert.count ?? 0,
        closetCount: closet.count ?? 0,
      };
    },
  });

  const { data: ebayConnection } = useEbayConnection();

  // US-2883: the extension marker is dropped by a content script, which may
  // land AFTER first paint -- so this is state re-read on a delay, not a
  // render-time call. Carried over from buyer-first-steps.tsx, where it was
  // load-bearing: without the second read, a buyer who has the extension is
  // told to install it every time they open the page.
  const [extensionInstalled, setExtensionInstalled] = useState(false);
  useEffect(() => {
    if (!stepKeys.has("extension")) return;
    setExtensionInstalled(isExtensionInstalled());
    const t = setTimeout(() => setExtensionInstalled(isExtensionInstalled()), 1500);
    return () => clearTimeout(t);
  }, [stepKeys]);

  const state = useMemo<ActivationState>(
    () => ({
      ...EMPTY_ACTIVATION_STATE,
      ...(counts ?? {}),
      ebayConnected: !!ebayConnection,
      notificationsGranted: notifPermission === "granted",
      extensionInstalled,
    }),
    [counts, ebayConnection, notifPermission, extensionInstalled],
  );

  const { done, total, firstIncomplete } = activationProgress(steps, state);

  // US-2884: each step's FIRST completion, once per account.
  //
  // ON COMPLETION, NOT ON THE BUTTON PRESS. US-2859's
  // `activation_step_started` records a press, and a seller who opens the
  // submission form and abandons it has pressed the button and activated
  // nothing. `isDone` reads the real signal -- a grade row exists, eBay is
  // connected -- so this fires when the thing actually happened.
  //
  // Guarded by a per-account marker rather than by a ref, because a ref is per
  // MOUNT: the checklist renders on the dashboard and on FlipDesk, so a ref
  // would emit twice for one account in one session.
  useEffect(() => {
    // Nothing is known yet while the counts are loading, and
    // EMPTY_ACTIVATION_STATE reads as "nothing done" -- so waiting avoids
    // burning the once-only marker on an answer we do not have.
    if (!counts) return;
    for (const step of steps) {
      if (!step.isDone(state)) continue;
      trackActivation("step_completed", user?.id, {
        persona: useCase,
        platform: "web",
        step: step.key,
      });
    }
  }, [counts, state, steps, useCase, user?.id]);

  const dismiss = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(user?.id, useCase), "1");
    }
    setLocallyDismissed(true);
    track("onboarding.activation_checklist_dismissed", { use_case: useCase });
    if (!user) return;
    // US-2883: a buyer dismissal never touches the seller column. See
    // dismissKey above for why.
    if (useCase === "buyer") return;
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
      window.localStorage.removeItem(dismissKey(user?.id, useCase));
    }
    setLocallyDismissed(false);
    if (!user) return;
    if (useCase === "buyer") return;
    const update: UserUpdate = { flipdesk_onboarded: false };
    void supabase
      .from("users")
      .update(update as never)
      .eq("id", user.id)
      .then(() => refreshProfile());
  }, [refreshProfile, user, useCase]);

  const complete = useCallback(
    (step: ActivationStep, navigate: (to: string) => void) => {
      track("onboarding.activation_step_started", {
        step: step.key,
        use_case: useCase,
      });
      // US-2883: the extension lives in a web store, not in this app. Without
      // this branch its CTA would be a button that does nothing -- the step
      // has no `to`, and the only other no-`to` step is notifications.
      if (step.key === "extension") {
        const url = extensionWebStoreUrl();
        if (url && typeof window !== "undefined") {
          window.open(url, "_blank", "noopener,noreferrer");
        } else {
          // US-2553 AC4: only when no store id is configured. /buyer/settings
          // is not where anyone gets an extension, so it is the fallback and
          // never the first answer.
          navigate("/buyer/settings");
        }
        return;
      }
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
