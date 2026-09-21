// US-3185: the three one-line delegations to the upload store, lifted out of
// autolister.tsx to pay for the phone-capture wiring the same commit adds.
//
// They are delegations and nothing else — the pipeline itself has lived in the
// store since US-1542 — so the page was carrying seventeen lines that said
// only "the store does this". What is worth keeping is the reason each one
// exists, and those comments travel with them.

import { useAutolisterUploadStore } from "@/stores/autolister-upload-store";

export interface UploadActions {
  handleFiles: (files: FileList | File[] | null) => Promise<void>;
  retryUploadTasks: (taskIds: string[]) => Promise<void>;
  dismissUploadTask: (id: string) => void;
}

export function uploadActions(ownerId: string | null, sessionId: string): UploadActions {
  return {
    async handleFiles(files) {
      if (!files || !ownerId) return;
      const list = Array.from(files);
      if (list.length === 0) return;
      await useAutolisterUploadStore.getState().enqueueFiles(list, sessionId);
    },
    // US-539: re-run failed pipelines without re-picking files.
    async retryUploadTasks(taskIds) {
      await useAutolisterUploadStore.getState().retryTasks(taskIds);
    },
    dismissUploadTask(id) {
      useAutolisterUploadStore.getState().dismissTask(id);
    },
  };
}
