// How the FlipDesk intake form saves an item, decided before any network call.
//
// Intake is the thrift-store floor surface, which is where the signal drops, so
// the offline path has to cover the same ground as the online one. It used to
// miss two cases: a NEW source (a server-side RPC) was resolved before the
// offline check, so the save threw 'Save failed'; and staged photos were
// cleared while the seller was told the item had been saved. The queue now
// carries the new source's NAME and the photo bytes, and flushIntakeQueue
// (src/lib/offline-queue.ts) resolves and uploads them on reconnect.

import { isOffline } from "@/lib/friendly-error";

export type IntakeSourceChoice =
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string }
  | { kind: "none" };

/** The source picker's value ("__new", "__none", "" or a source id) as a choice. */
export function resolveIntakeSourceChoice(
  sourceId: string,
  sourceNewName: string,
): IntakeSourceChoice {
  if (sourceId === "__new") {
    const name = sourceNewName.trim();
    return name ? { kind: "new", name } : { kind: "none" };
  }
  if (sourceId && sourceId !== "__none") return { kind: "existing", id: sourceId };
  return { kind: "none" };
}

export type IntakeSavePlan =
  | {
      route: "insert";
      /** Known now; null when there is none or it must be created first. */
      sourceId: string | null;
      /** Create (or find) this source by name before the insert. */
      newSourceName: string | null;
    }
  | {
      route: "queue";
      sourceId: string | null;
      /** Resolved at flush time, when the device is back online. */
      newSourceName: string | null;
      /** Staged photos travel with the queued item; none are dropped. */
      photoCount: number;
    };

export function planIntakeSave(input: {
  online: boolean;
  source: IntakeSourceChoice;
  photoCount: number;
}): IntakeSavePlan {
  const sourceId = input.source.kind === "existing" ? input.source.id : null;
  const newSourceName = input.source.kind === "new" ? input.source.name : null;
  if (input.online) return { route: "insert", sourceId, newSourceName };
  return { route: "queue", sourceId, newSourceName, photoCount: input.photoCount };
}

/** The toast after an offline save, naming what will happen on reconnect. */
export function offlineSavedMessage(
  title: string,
  plan: Extract<IntakeSavePlan, { route: "queue" }>,
): string {
  const extras: string[] = [];
  if (plan.photoCount > 0) {
    extras.push(`${plan.photoCount} photo${plan.photoCount === 1 ? "" : "s"}`);
  }
  if (plan.newSourceName) extras.push(`the new source "${plan.newSourceName}"`);
  const withExtras = extras.length > 0 ? `, with ${extras.join(" and ")},` : "";
  return `Saved "${title}"${withExtras} offline. It will sync when you reconnect.`;
}

/**
 * The online save failed: should it fall back to the queue? navigator.onLine
 * says true on captive-portal and weak store wifi, and then the RPC or insert
 * rejects with 'Failed to fetch'. A request we aborted on a timer is the same
 * dead zone. A real refusal (RLS, a constraint) is not, and must surface.
 */
export function shouldQueueAfterError(err: unknown): boolean {
  if (isOffline(err)) return true;
  const name = readString(err, "name");
  if (name === "AbortError" || name === "TimeoutError") return true;
  // postgrest-js folds a rejected fetch into { message: "<Name>: <message>" }.
  const message = readString(err, "message") ?? "";
  return /^(AbortError|TimeoutError)\b/.test(message);
}

/**
 * A 23505 on the PRIMARY KEY means an earlier try with this same draft id
 * already landed (its response was lost), so the item is saved. A 23505 on the
 * SKU index is a real clash and is not this.
 */
export function isDraftAlreadySaved(err: unknown): boolean {
  if (readString(err, "code") !== "23505") return false;
  const text = `${readString(err, "message") ?? ""} ${readString(err, "details") ?? ""}`;
  return text.includes("inventory_items_pkey") || /Key \(id\)=/.test(text);
}

function readString(err: unknown, key: string): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}
