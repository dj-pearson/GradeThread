// US-3139: the AutoLister page's side of automatic group naming.
//
// The rules live in src/lib/autolister-tag-ocr.ts (pure) and the pass loop in
// src/hooks/use-autolister-tag-ocr.ts (engine + network). What is left — the
// staged-photo projection, the setGroups write, the toast, the busy badge — is
// page wiring, and it lives here rather than in autolister.tsx because that file
// is under a line ceiling that exists to stop exactly this kind of accretion.

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  type TagOcrGroup,
  type TagOcrRename,
  useAutolisterTagOcr,
} from "@/hooks/use-autolister-tag-ocr";
import type { StagedPhoto } from "@/stores/autolister-upload-store";

export interface TagOcrWiringOptions {
  staged: StagedPhoto[];
  groups: TagOcrGroup[];
  /** The seller's AutoLister entitlement. No entitlement, no pass. */
  entitled: boolean;
  setGroups: React.Dispatch<React.SetStateAction<TagOcrGroup[]>>;
}

/**
 * Run the namer against this session and apply what it finds.
 *
 * Deliberately NOT routed through the page's applyGroupEdit: that is the
 * seller's undo stack, and a machine rename nobody asked for should not consume
 * the one slot their next drag-merge wants. A name the seller typed is never
 * overwritten — the hook gates every write on isDefaultGroupName.
 */
export function useTagOcrWiring<G extends TagOcrGroup>({
  staged,
  groups,
  entitled,
  setGroups,
}: {
  staged: StagedPhoto[];
  groups: G[];
  entitled: boolean;
  setGroups: React.Dispatch<React.SetStateAction<G[]>>;
}): { busy: boolean } {
  const photoById = useMemo(
    () =>
      new Map(
        staged.map((p) => [
          p.id,
          { id: p.id, url: p.url, sourceName: p.sourceName },
        ]),
      ),
    [staged],
  );

  const onRenamed = useCallback(
    (renames: TagOcrRename[]) => {
      const byId = new Map(renames.map((r) => [r.id, r.name]));
      setGroups((prev) =>
        prev.map((g) => {
          const name = byId.get(g.id);
          return name ? { ...g, name } : g;
        }),
      );
      toast.success(
        renames.length === 1
          ? `Named "${renames[0]!.name}" from its tag.`
          : `Named ${renames.length} items from their tags.`,
      );
    },
    [setGroups],
  );

  return useAutolisterTagOcr({ groups, photoById, enabled: entitled, onRenamed });
}
