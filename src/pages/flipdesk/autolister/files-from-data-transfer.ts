/**
 * US-530: every File in a drag-and-drop, recursing into dropped FOLDERS.
 *
 * A seller shooting a session drops the folder, not forty files. `dt.files` is
 * flat and would hand back nothing for a folder drop, so the entries API is used
 * where it exists and the flat list is the fallback for browsers without it.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG AND BOTH LOSE PHOTOS SILENTLY.
 *
 * `readEntries` PAGES. It returns a batch and must be called again until it
 * answers empty; a single call reads roughly the first hundred entries in
 * Chrome and stops. One call looks correct on a test folder of six photos and
 * drops the tail of a real shoot.
 *
 * `webkitGetAsEntry` must be read BEFORE the first await. The DataTransferItem
 * list is only valid during the drop event, so the roots are collected up front
 * and walked afterwards.
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (roots.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = () =>
        new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const e of batch) await walk(e);
        batch = await readBatch(); // readEntries pages; loop until empty
      }
    }
  }
  for (const e of roots) await walk(e);
  return out;
}
