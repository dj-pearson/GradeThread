import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { UserRow } from "@/types/database";

export function useAuth() {
  const { user, session, profile, isLoading, setUser, setSession, setProfile, setIsLoading, reset } =
    useAuthStore();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      if (currentSession?.user) {
        fetchProfile(currentSession.user.id);
      } else {
        setIsLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        fetchProfile(newSession.user.id);
      } else {
        reset();
      }
    });

    return () => subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchProfile(userId: string) {
    try {
      const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

      if (error) throw error;
      setProfile(data as UserRow);
    } catch {
      setProfile(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshProfile() {
    const userId = user?.id;
    if (userId) {
      await fetchProfile(userId);
    }
  }

  return { user, session, profile, isLoading, refreshProfile };
}
