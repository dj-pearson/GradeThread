// US-539: Web Worker pool for image compression/thumbnailing.
//
// processStagedImage() is the single entry point: it decodes + resizes +
// thumbnails + dHashes a photo OFF the main thread (OffscreenCanvas in a small
// worker pool sized to the device's cores), so staging a 100-photo batch never
// freezes the UI. One worker round-trip produces BOTH the full image and the
// thumbnail from a single decode — the old main-thread path decoded the file
// twice. Environments without Worker/OffscreenCanvas (or a worker that fails
// to boot) fall back transparently to the main-thread compressImage path.
// Workers are spawned lazily on first use and reused across batches.

import { compressImage, loadImage } from "@/lib/image-utils";
import type {
  WorkerCompressRequest,
  WorkerCompressResponse,
} from "@/workers/image-compress.worker";

export interface ProcessedImage {
  blob: Blob;
  width: number;
  height: number;
  phash: string;
  thumbBlob: Blob | null;
  /** Dimensions of the ORIGINAL (pre-resize) image, for quality gating. null
   * only on exotic fallback paths where the source couldn't be measured. */
  srcWidth: number | null;
  srcHeight: number | null;
}

export interface ProcessOptions {
  maxWidth?: number;
  quality?: number;
  /** Pass null to skip thumbnail generation. */
  thumbWidth?: number | null;
  thumbQuality?: number;
}

/** The image could not be decoded at all (corrupt/truncated/non-image file).
 * Retrying won't help — callers should reject the file with a clear reason. */
export class ImageDecodeError extends Error {
  constructor() {
    super("Couldn't read this image — the file may be corrupted.");
    this.name = "ImageDecodeError";
  }
}

interface PoolWorker {
  worker: Worker;
  taskId: number | null;
}

interface QueuedTask {
  req: WorkerCompressRequest;
  resolve: (out: ProcessedImage) => void;
  reject: (err: Error) => void;
  /** Watchdog armed when the task is posted to a worker. */
  timer?: ReturnType<typeof setTimeout>;
}

// Watchdog: a worker that never replies (silently killed by the browser under
// memory pressure, or an unhandled rejection inside the worker — neither fires
// `onerror`) would otherwise hold its task in-flight FOREVER, permanently
// eating a pool slot until the whole staging batch deadlocks. On expiry the
// wedged worker is recycled and the task rejects, which sends that one photo
// down the main-thread fallback instead of freezing the queue.
const WORKER_TASK_TIMEOUT_MS = 60_000;

const workers: PoolWorker[] = [];
const queue: QueuedTask[] = [];
const inFlight = new Map<number, QueuedTask>();
let nextTaskId = 1;
let poolBroken = false;

function poolSize(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  // Leave a core for the main thread + uploads; 2–4 workers covers phones
  // through desktops without thrashing mobile memory.
  return Math.max(2, Math.min(4, cores - 1));
}

function workerSupported(): boolean {
  return (
    !poolBroken &&
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

function handleMessage(pw: PoolWorker, msg: WorkerCompressResponse): void {
  const task = inFlight.get(msg.id);
  inFlight.delete(msg.id);
  pw.taskId = null;
  if (task) {
    clearTimeout(task.timer);
    if (msg.ok) {
      task.resolve({
        blob: msg.blob,
        width: msg.width,
        height: msg.height,
        phash: msg.phash,
        thumbBlob: msg.thumbBlob,
        srcWidth: msg.srcWidth,
        srcHeight: msg.srcHeight,
      });
    } else if (msg.decodeFailed) {
      task.reject(new ImageDecodeError());
    } else {
      task.reject(new Error(msg.error));
    }
  }
  pump(pw);
}

// A worker erroring at the script level (load/parse failure) is unrecoverable
// — mark the pool broken so every queued and future task uses the main-thread
// fallback instead of hanging.
function handleWorkerFailure(): void {
  poolBroken = true;
  for (const t of inFlight.values()) {
    clearTimeout(t.timer);
    t.reject(new Error("worker crashed"));
  }
  inFlight.clear();
  for (const t of queue.splice(0)) t.reject(new Error("worker unavailable"));
  for (const w of workers.splice(0)) w.worker.terminate();
}

// Recycle ONE wedged/undeliverable worker: fail its in-flight task (the caller
// falls back to the main thread), drop it from the pool, and pump so queued
// tasks respawn a fresh worker. Unlike handleWorkerFailure this doesn't mark
// the pool broken — the worker script itself is fine.
function recycleWorker(pw: PoolWorker, reason: string): void {
  const idx = workers.indexOf(pw);
  if (idx !== -1) workers.splice(idx, 1);
  pw.worker.terminate();
  if (pw.taskId !== null) {
    const task = inFlight.get(pw.taskId);
    inFlight.delete(pw.taskId);
    pw.taskId = null;
    if (task) {
      clearTimeout(task.timer);
      task.reject(new Error(reason));
    }
  }
  pump();
}

function spawnWorker(): PoolWorker {
  const worker = new Worker(
    new URL("../workers/image-compress.worker.ts", import.meta.url),
    { type: "module" },
  );
  const pw: PoolWorker = { worker, taskId: null };
  worker.onmessage = (e: MessageEvent<WorkerCompressResponse>) =>
    handleMessage(pw, e.data);
  // A response that fails structured clone never reaches onmessage — without
  // this the task would hang in-flight forever.
  worker.onmessageerror = () => recycleWorker(pw, "worker reply undeliverable");
  worker.onerror = () => handleWorkerFailure();
  workers.push(pw);
  return pw;
}

function pump(idle?: PoolWorker): void {
  if (poolBroken) return;
  while (queue.length > 0) {
    let pw =
      idle && idle.taskId === null
        ? idle
        : workers.find((w) => w.taskId === null);
    if (!pw && workers.length < poolSize()) pw = spawnWorker();
    if (!pw) return; // every worker busy — handleMessage pumps again
    idle = undefined;
    const task = queue.shift()!;
    const owner = pw;
    pw.taskId = task.req.id;
    inFlight.set(task.req.id, task);
    task.timer = setTimeout(() => {
      if (inFlight.get(task.req.id) === task) {
        recycleWorker(owner, "Image processing timed out.");
      }
    }, WORKER_TASK_TIMEOUT_MS);
    pw.worker.postMessage(task.req);
  }
}

function runInWorker(
  req: Omit<WorkerCompressRequest, "id">,
): Promise<ProcessedImage> {
  return new Promise((resolve, reject) => {
    queue.push({ req: { ...req, id: nextTaskId++ }, resolve, reject });
    pump();
  });
}

export async function processStagedImage(
  file: File,
  opts: ProcessOptions = {},
): Promise<ProcessedImage> {
  const {
    maxWidth = 2400,
    quality = 0.85,
    thumbWidth = 320,
    thumbQuality = 0.7,
  } = opts;

  if (workerSupported()) {
    try {
      return await runInWorker({ file, maxWidth, quality, thumbWidth, thumbQuality });
    } catch (err) {
      if (err instanceof ImageDecodeError) throw err;
      // Worker crashed or couldn't boot — fall through to the main thread.
    }
  }

  // Main-thread fallback (the pre-US-539 path). loadImage doubles as the
  // decodability check so callers get the same ImageDecodeError contract.
  let srcWidth: number | null = null;
  let srcHeight: number | null = null;
  try {
    const img = await loadImage(file);
    srcWidth = img.naturalWidth;
    srcHeight = img.naturalHeight;
  } catch {
    throw new ImageDecodeError();
  }
  const main = await compressImage(file, maxWidth, quality);
  const thumbBlob =
    thumbWidth != null
      ? (await compressImage(file, thumbWidth, thumbQuality)).blob
      : null;
  return {
    blob: main.blob,
    width: main.width,
    height: main.height,
    phash: main.phash,
    thumbBlob,
    srcWidth,
    srcHeight,
  };
}
