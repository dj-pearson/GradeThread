import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-3201: how this seller wants their listing copy to sound.
//
// Same shape as useAgedThreshold: RLS on flipdesk_settings scopes the row to the
// signed-in user (00134), so this reads Supabase directly rather than through an
// edge route. The edge reads the same column with the service-role client when
// it generates a listing (ai-listing.ts, loadListingVoice).
//
// NULL IS THE MEANINGFUL DEFAULT, not an empty string. A null column means "use
// the prompt as shipped", and every account that never opens this setting keeps
// byte-identical output to before the feature existed. Blank input is written
// back as null rather than as "", so clearing the box genuinely turns it off —
// the CHECK constraint refuses an all-whitespace value for the same reason.

const KEY = "listing_voice";

/** Mirrors the CHECK on flipdesk_settings.listing_voice_prompt. */
export const LISTING_VOICE_MAX_LEN = 2000;

export function useListingVoice() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    // Config, not data. The mutation below invalidates it.
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("listing_voice_prompt")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      const stored = (data as { listing_voice_prompt?: string | null } | null)
        ?.listing_voice_prompt;
      const text = (stored ?? "").trim();
      return text === "" ? null : text;
    },
  });
}

export function useSetListingVoice() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (raw: string) => {
      const text = raw.trim();
      if (text.length > LISTING_VOICE_MAX_LEN) {
        // Refused here rather than left to the database CHECK, so the seller
        // gets a sentence instead of a Postgres constraint name.
        throw new Error(
          `Keep it under ${LISTING_VOICE_MAX_LEN.toLocaleString()} characters — that is ${(
            text.length - LISTING_VOICE_MAX_LEN
          ).toLocaleString()} too many.`,
        );
      }
      const value = text === "" ? null : text;
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user!.id, listing_voice_prompt: value } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      return value;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY, user?.id] });
    },
  });
}
