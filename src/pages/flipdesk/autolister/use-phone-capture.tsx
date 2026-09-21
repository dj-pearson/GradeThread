// US-3185: AutoLister's half of phone-as-camera, kept out of the page.
//
// One scanned code carries the seller through a whole bin. The phone marks the
// boundary between garments and each shot arrives stamped with the item it was
// taken on, so what lands here is already grouped.
//
// Extracted rather than written inline because autolister.tsx sits on the
// US-2520 line ceiling, and because all of this is one thing: the open state,
// the index -> group map that has to survive between polls, and the dialog
// that produces both.

import { type ReactNode, useCallback, useRef, useState } from "react";
import { PhoneCaptureDialog } from "@/components/flipdesk/phone-capture-dialog";
import type { StagedPhoto } from "@/stores/autolister-upload-store";
import {
  type StageableGroup,
  stageCapturedPhotos,
} from "./phone-capture-staging";

export interface AutolisterPhoneCapture {
  /** What UploadDropzone renders as its button. Null when there is no owner. */
  active: boolean;
  onStart: () => void;
  /** Rendered by the dropzone so the page needs no second line for it. */
  dialog: ReactNode;
}

/**
 * @param ownerId Null until the workspace resolves; there is nowhere for the
 *   photos to land before then, which is why Google Photos gates on it too.
 * @param sessionId The AutoLister session the photos are already filed under.
 *   This is the capture's `staging` target: no `listing_generation_batches`
 *   row exists yet, because one is created when generation STARTS.
 */
export function useAutolisterPhoneCapture<G extends StageableGroup>(
  ownerId: string | null,
  sessionId: string,
  groups: readonly G[],
  onStage: (staged: StagedPhoto[], groups: G[]) => void,
): AutolisterPhoneCapture | null {
  const [open, setOpen] = useState(false);
  // Capture group index -> the Group id it was staged into. A ref rather than
  // state because the dialog's poll callback reads it between renders, and a
  // stale copy here would start a new group for the same item on every poll.
  const groupIds = useRef<Map<number, string>>(new Map());

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    // A new code is a new bin. Keeping the map would fold the next session's
    // "Item 1" into the last session's first group.
    if (!next) groupIds.current = new Map();
  }, []);

  if (!ownerId) return null;
  return {
    active: open,
    onStart: () => setOpen(true),
    dialog: (
      <PhoneCaptureDialog
        open={open}
        onOpenChange={onOpenChange}
        targetKind="staging"
        targetId={sessionId}
        onPhotos={(photos) => {
          const next = stageCapturedPhotos(photos, groups, groupIds.current);
          onStage(next.staged, next.groups);
        }}
      />
    ),
  };
}
