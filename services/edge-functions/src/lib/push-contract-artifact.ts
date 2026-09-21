/**
 * US-3279: the checked-in push contract, built from the sender table.
 *
 * `contracts/push-contract.json` is what iOS and Android read instead of
 * keeping their own hand-written copy of the category list. Everything in it
 * comes from two places in this service and nothing is typed twice:
 *
 *   - `PUSH_CONTRACT` in transactional-push.ts supplies the categories, each
 *     one's `kind`, and the payload keys it may carry.
 *   - The source text of that same file supplies which exported sender ships
 *     each category, which is how a category declared but never sent (or sent
 *     but never declared) is caught rather than shipped.
 *
 * ⚠ THE SOURCE READ IS THE POINT, NOT AN OPTIMISATION. Importing the table
 * alone would prove the table is well formed and nothing about whether it
 * describes what this service actually sends. US-3268's three dead toggles
 * were exactly that shape: a list that agreed with itself.
 */

import {
  PUSH_CONTRACT,
  type PushCategoryId,
  payloadKeysFor,
} from "./transactional-push.ts";

export interface PushContractCategory {
  /** The APNs/FCM category identifier, the string clients route on. */
  id: string;
  /** The `kind` value stamped into `data`, or null when the payload has none. */
  kind: string | null;
  /** The exported sender in transactional-push.ts, or the path that sends it. */
  sender: string;
  /** Every `data` key this category's payload can carry, `kind` included. */
  payloadKeys: string[];
}

export interface PushContractArtifact {
  generatedBy: string;
  source: string;
  note: string;
  categories: PushContractCategory[];
}

const SOURCE_URL = new URL("./transactional-push.ts", import.meta.url);

/**
 * Sender name -> category, read out of the source.
 *
 * Comments are stripped first, so a sentence naming a category is not a send.
 */
export function sendersFromSource(src: string): Map<string, string> {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  const out = new Map<string, string>();
  const fnRe = /export function (push[A-Za-z0-9_]*)\s*\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  for (const m of code.matchAll(fnRe)) {
    starts.push({ name: m[1]!, at: m.index! });
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.at;
    const to = i + 1 < starts.length ? starts[i + 1]!.at : code.length;
    const body = code.slice(from, to);
    const call = /\.\.\.describe\(\s*"([a-z_.]+)"/.exec(body);
    if (!call) continue;
    const category = call[1]!;
    const existing = out.get(category);
    if (existing) {
      throw new Error(
        `two senders ship "${category}": ${existing} and ${starts[i]!.name}. ` +
          "One category, one sender, or the artefact cannot name it.",
      );
    }
    out.set(category, starts[i]!.name);
  }
  return out;
}

/** Build the artefact, refusing to build a wrong one. */
export function buildPushContractArtifact(
  src: string = Deno.readTextFileSync(SOURCE_URL),
  readExternal: (path: string) => string = (path) =>
    Deno.readTextFileSync(new URL(`../../${path}`, import.meta.url)),
): PushContractArtifact {
  const senders = sendersFromSource(src);
  const declared = Object.keys(PUSH_CONTRACT) as PushCategoryId[];

  for (const id of declared) {
    const entry = PUSH_CONTRACT[id] as { sentBy?: string };
    if (!entry.sentBy) continue;
    // A category declared as sent from elsewhere has to actually be sent from
    // there. Otherwise the escape hatch becomes the way a dead category gets
    // into the artefact.
    const external = readExternal(entry.sentBy);
    if (!external.includes(`category: "${id}"`)) {
      throw new Error(
        `PUSH_CONTRACT says ${entry.sentBy} sends "${id}" and it does not`,
      );
    }
    senders.set(id, entry.sentBy);
  }

  // A category nothing sends would put a toggle in front of a user for a push
  // that can never arrive, which is US-3268 word for word.
  const unsent = declared.filter((id) => !senders.has(id));
  if (unsent.length > 0) {
    throw new Error(
      `PUSH_CONTRACT declares ${unsent.join(", ")} and no sender ships them`,
    );
  }
  // And the other direction: a send the table does not describe would reach a
  // client with no entry in the artefact, which is US-3266.
  const undeclared = [...senders.keys()].filter(
    (id) => !(id in PUSH_CONTRACT),
  );
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.join(", ")} is sent and PUSH_CONTRACT does not declare it`,
    );
  }

  const categories: PushContractCategory[] = declared
    .map((id) => ({
      id,
      kind: PUSH_CONTRACT[id].kind as string | null,
      sender: senders.get(id)!,
      payloadKeys: payloadKeysFor(id).slice().sort(),
    }))
    // Sorted so a diff shows what changed rather than where it moved.
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedBy: "services/edge-functions/scripts/generate-push-contract.ts",
    source: "services/edge-functions/src/lib/transactional-push.ts",
    note:
      "GENERATED - do not hand-edit. iOS (PushCategoryCoverageTests, " +
      "NotificationActionAvailabilityTests) and Android read this file, so a " +
      "hand edit here re-enables exactly the dead buttons and dead toggles it " +
      "exists to prevent. Regenerate with the script named in generatedBy.",
    categories,
  };
}

/** One serializer, so the writer and the staleness check cannot disagree. */
export function serializePushContractArtifact(
  artifact: PushContractArtifact,
): string {
  return JSON.stringify(artifact, null, 2) + "\n";
}
