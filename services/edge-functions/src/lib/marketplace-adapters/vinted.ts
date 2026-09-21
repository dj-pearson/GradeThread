import { makeStubAdapter } from "./stub.ts";

// Stub (US-3447): Vinted lists through the GradeThread Lister browser
// extension, never a server API, so cross-push takes the enqueue branch and
// this adapter is only ever reached by a caller that bypassed it, where a typed
// 501 is the right answer. mapDraftToListing is real (pure), so the sibling row
// is mapped correctly the moment the channel is selected.
export const vintedAdapter = makeStubAdapter("vinted");
