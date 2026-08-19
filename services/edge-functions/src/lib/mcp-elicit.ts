// US-9131: asking a HUMAN, through Multi Round-Trip Requests (SEP-2322).
//
// Before 2026-07-28 a server that wanted a person to confirm something had to
// send a JSON-RPC request back down an open stream. MRTR removes that: the
// server answers the tool call with an INCOMPLETE result carrying
// `inputRequests`, and the client re-issues the SAME call with `inputResponses`
// and the `requestState` it was handed back.
//
// ── This does not replace the confirm token ──────────────────────────────
//
// They answer different questions and both are needed:
//
//   • Elicitation asks a PERSON. It is the only thing here that puts a human in
//     front of a publish rather than a model's report of one.
//   • The token proves the PAYLOAD did not change between the question and the
//     action. Elicitation alone lets a model ask "publish at $48?", get a yes,
//     and publish at $95.
//
// A client on an older revision never sees an InputRequiredResult and falls back
// to the two-call preview/confirm flow, which still cannot publish without a
// token. That is why shipping this is an improvement rather than a dependency.
//
// ── requestState ─────────────────────────────────────────────────────────
//
// The spec says it is opaque to the client and the server may encode anything.
// Nothing here needs server-side state — the retry carries the original
// arguments — so it holds only the tool name, and the retry is refused if it
// disagrees. That catches a client pairing a response with the wrong request; it
// is not a security boundary, because the client is the party that asked the
// human in the first place.

/** The single elicitation key this server issues. One question, one key. */
export const CONFIRM_KEY = "gradethread_confirm";

/** SEP-2322: absent means "complete", so only the incomplete case sets it. */
export const RESULT_TYPE_INPUT_REQUIRED = "input_required";

export interface ElicitResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * The InputRequiredResult for one yes/no confirmation.
 *
 * `mode: "form"` with a single required boolean, because a free-text answer
 * would put the model back in the business of interpreting what the human meant.
 */
export function confirmationRequired(
  toolName: string,
  message: string,
): Record<string, unknown> {
  return {
    resultType: RESULT_TYPE_INPUT_REQUIRED,
    inputRequests: {
      [CONFIRM_KEY]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Go ahead",
                description: "Tick this to let GradeThread make this change.",
              },
            },
            required: ["confirm"],
          },
        },
      },
    },
    requestState: toolName,
  };
}

export type ConfirmationVerdict =
  | { state: "not_asked" }
  | { state: "accepted" }
  | { state: "refused"; message: string };

/**
 * Read the human's answer out of a retried `tools/call`.
 *
 * Four outcomes, and the difference between them is what the seller is told:
 *
 *   • no response yet          → ask.
 *   • accept + confirm true    → go.
 *   • accept + confirm false   → they read it and said no. That is a refusal,
 *                                not a failure, and it must not be retried.
 *   • decline / cancel         → they dismissed the prompt. Also a refusal.
 *
 * A mismatched requestState is treated as not-asked rather than as accepted:
 * the failure mode of guessing wrong is doing something nobody confirmed.
 */
export function readConfirmation(
  params: Record<string, unknown> | undefined,
  toolName: string,
): ConfirmationVerdict {
  const responses = params?.inputResponses;
  if (!responses || typeof responses !== "object") return { state: "not_asked" };

  const answer = (responses as Record<string, unknown>)[CONFIRM_KEY];
  if (!answer || typeof answer !== "object") return { state: "not_asked" };

  const state = params?.requestState;
  if (typeof state === "string" && state !== toolName) {
    // A response paired with a different request. Ask again rather than
    // treating someone else's yes as this call's yes.
    return { state: "not_asked" };
  }

  const { action, content } = answer as ElicitResponse;
  if (action === "decline" || action === "cancel") {
    return {
      state: "refused",
      message: "The seller dismissed the confirmation, so nothing was changed. " +
        "Do not try again unless they ask for it.",
    };
  }
  if (action !== "accept") return { state: "not_asked" };

  if (content?.confirm === true) return { state: "accepted" };
  return {
    state: "refused",
    message: "The seller said no, so nothing was changed. " +
      "Do not try again unless they ask for it.",
  };
}
