import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// Client for the content module's Server-Sent-Events endpoints (US-251 compose,
// US-252 section regen). The standard jfetch in use-content.ts buffers the whole
// JSON response, which defeats streaming — this reads the body incrementally and
// surfaces each `delta` as it lands.
//
// The edge emits frames like:
//   event: delta\n data: {"text":"<h2>…"}\n\n
//   event: done\n  data: {"ok":true}\n\n
//   event: error\n data: {"message":"…"}\n\n
//
// Pass an AbortSignal to wire a "Stop" button — aborting the fetch closes the
// connection, which the edge observes (c.req.raw.signal) and stops the upstream
// model call.

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export async function streamContentSSE(
  path: string,
  body: unknown,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in.");

  const res = await fetch(`${edgeApiUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse one complete SSE frame (already split on the blank-line boundary).
  const handleFrame = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: { text?: string; message?: string } = {};
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "delta" && typeof payload.text === "string") {
      handlers.onDelta(payload.text);
    } else if (event === "done") {
      handlers.onDone?.();
    } else if (event === "error") {
      handlers.onError?.(payload.message ?? "Generation failed");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // Frames are separated by a blank line (\n\n).
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) handleFrame(frame);
      }
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return; // Stop button — silent
    throw err;
  }
}
