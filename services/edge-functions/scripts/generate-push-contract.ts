/**
 * US-3279: emit `contracts/push-contract.json` from the edge's own sender table.
 *
 * The clients used to keep their own copy of this list by hand. Three bugs in
 * one session came out of that: US-3266 (the edge sent seven categories iOS
 * had never heard of), US-3268 (three Settings toggles nothing could fill) and
 * US-3274 (five inline buttons the payload could not serve). The artefact this
 * writes is what iOS and Android read instead.
 *
 * Run: deno task push-contract
 * Check: add --check to fail instead of writing when the file is stale. That is
 * what `push-contract_test.ts` and CI use.
 */

import {
  buildPushContractArtifact,
  serializePushContractArtifact,
} from "../src/lib/push-contract-artifact.ts";

const ARTIFACT = new URL("../../../contracts/push-contract.json", import.meta.url);

const wanted = serializePushContractArtifact(buildPushContractArtifact());
const check = Deno.args.includes("--check");

let current: string | null = null;
try {
  current = await Deno.readTextFile(ARTIFACT);
} catch {
  current = null;
}

if (current === wanted) {
  console.log("push-contract.json is current");
  Deno.exit(0);
}

if (check) {
  console.error(
    "contracts/push-contract.json is stale. Run:\n" +
      "  cd services/edge-functions && deno task push-contract",
  );
  Deno.exit(1);
}

await Deno.writeTextFile(ARTIFACT, wanted);
console.log(`wrote ${ARTIFACT.pathname}`);
