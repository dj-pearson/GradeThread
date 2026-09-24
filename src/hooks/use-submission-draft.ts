import { useCallback } from "react";
import { useAuthStore } from "@/stores/auth-store";
import type { GarmentInfo } from "@/components/submission/garment-info-form";
import type { GradeTierKey } from "@/lib/constants";
import type { ImageType } from "@/types/database";

// US-951: local draft autosave/resume for the web grading wizard. We persist
// only the form fields and a lightweight photo MANIFEST (image type + file
// name) — NEVER the image binaries (see acceptance criteria + US-276). Photos
// are uploaded straight to the edge at submit, so there are no staged storage
// URLs to keep; on resume the seller re-adds the actual images.
const DRAFT_VERSION = 1;
const KEY_PREFIX = "gradethread:submission-draft:";

// A photo reference (metadata only — no bytes) so we can tell the seller how
// many photos they had staged and which slots, without persisting binaries.
export interface SubmissionDraftPhoto {
  imageType: ImageType;
  name: string;
}

export interface SubmissionDraft {
  version: number;
  updatedAt: string;
  currentStep: number;
  garmentInfo: GarmentInfo | null;
  tier: GradeTierKey;
  verifiedCaptureOptIn: boolean;
  authenticityAddonOptIn: boolean;
  linkedItemId: string;
  photos: SubmissionDraftPhoto[];
}

// What the page hands us each autosave (version + timestamp are stamped here).
export type SubmissionDraftInput = Omit<SubmissionDraft, "version" | "updatedAt">;

// A draft is only worth resuming once the seller has entered something —
// otherwise mounting a fresh wizard would prompt to "resume" an empty form.
export function isMeaningfulDraft(draft: SubmissionDraft | null): boolean {
  if (!draft) return false;
  return (
    draft.garmentInfo !== null ||
    draft.photos.length > 0 ||
    draft.currentStep > 0
  );
}

/**
 * SNAP-05: what the autosave effect should do this render.
 *
 * A snap or retake arrival is resolved without reading the saved draft, and its
 * seeded photo is not the seller's edit. Autosaving then either CLEARED an
 * unrelated half-finished draft (no content yet) or overwrote it with the seed.
 * Until the seller changes something themselves, a bridge arrival writes
 * nothing.
 */
export function draftAutosaveAction(input: {
  resolved: boolean;
  ready: boolean;
  bridgeArrival: boolean;
  userTouched: boolean;
  hasContent: boolean;
}): "skip" | "clear" | "save" {
  if (!input.resolved || !input.ready) return "skip";
  if (input.bridgeArrival && !input.userTouched) return "skip";
  return input.hasContent ? "save" : "clear";
}

export function useSubmissionDraft() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const storageKey = userId ? `${KEY_PREFIX}${userId}` : null;

  const read = useCallback((): SubmissionDraft | null => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SubmissionDraft;
      // Ignore drafts from an older schema rather than mis-restoring them.
      if (!parsed || parsed.version !== DRAFT_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }, [storageKey]);

  const save = useCallback(
    (input: SubmissionDraftInput) => {
      if (!storageKey) return;
      try {
        const payload: SubmissionDraft = {
          ...input,
          version: DRAFT_VERSION,
          updatedAt: new Date().toISOString(),
        };
        localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // Best-effort: quota / serialization failures must never break the form.
      }
    },
    [storageKey]
  );

  const clear = useCallback(() => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  return { read, save, clear, ready: storageKey !== null };
}
