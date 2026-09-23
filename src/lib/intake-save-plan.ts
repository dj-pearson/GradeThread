// How the FlipDesk intake form saves an item, decided before any network call.
//
// Intake is the thrift-store floor surface, which is where the signal drops, so
// the offline path has to cover the same ground as the online one. It used to
// miss two cases: a NEW source (a server-side RPC) was resolved before the
// offline check, so the save threw 'Save failed'; and staged photos were
// cleared while the seller was told the item had been saved. The queue now
// carries the new source's NAME and the photo bytes, and flushIntakeQueue
// (src/lib/offline-queue.ts) resolves and uploads them on reconnect.

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
