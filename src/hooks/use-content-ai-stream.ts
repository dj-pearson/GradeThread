import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { streamContentSSE } from "@/lib/content-stream";

// Shared streaming-AI actions for the blog editor (US-251 compose, US-252
// section regen). Both stream HTML deltas from the edge over SSE and flush
// complete tags into the Tiptap editor as they arrive. A single AbortController
// backs the Stop button and guarantees we never run two streams at once.

export type RegenMode = "regenerate" | "expand" | "rewrite-for-keyword";

// Flushes streamed HTML into the editor at the cursor, but only up to the last
// complete tag (`>`), so insertContent never has to parse a half-open element.
// Honors the US-251 AC: wires the stream to editor.commands.insertContent.
function createHtmlFlusher(editor: Editor) {
  let buffer = "";
  return {
    push(text: string) {
      buffer += text;
      const idx = buffer.lastIndexOf(">");
      if (idx === -1) return;
      const ready = buffer.slice(0, idx + 1);
      buffer = buffer.slice(idx + 1);
      if (ready) editor.commands.insertContent(ready);
    },
    flush() {
      if (buffer.trim()) editor.commands.insertContent(buffer);
      buffer = "";
    },
  };
}

// Serialize the current selection to an HTML string for the regen prompt.
function selectionHtml(editor: Editor): string {
  const slice = editor.state.selection.content();
  const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(
    slice.content,
  );
  const div = document.createElement("div");
  div.appendChild(fragment);
  return div.innerHTML;
}

export function useContentAiStream(editor: Editor | null, postId: string) {
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream if the component unmounts.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsStreaming(false);
  }, []);

  // US-251: compose a fresh article body, streaming into the editor at the end.
  const compose = useCallback(
    async (instruction?: string) => {
      if (!editor || isStreaming) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsStreaming(true);
      editor.commands.focus("end");
      const flusher = createHtmlFlusher(editor);
      try {
        await streamContentSSE(
          `/api/content/blog/${postId}/compose-stream`,
          { instruction },
          controller.signal,
          {
            onDelta: flusher.push,
            onDone: flusher.flush,
            onError: (m) => toast.error(m),
          },
        );
      } catch (e) {
        toastError(e);
      } finally {
        controllerRef.current = null;
        setIsStreaming(false);
      }
    },
    [editor, isStreaming, postId],
  );

  // US-252: rewrite/expand/keyword-target the current selection in place.
  const regenerate = useCallback(
    async (mode: RegenMode, keyword?: string) => {
      if (!editor || isStreaming) return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        toast.error("Select some text first.");
        return;
      }
      const html = selectionHtml(editor);
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsStreaming(true);

      // US-1932: delete the selection LAZILY — only once the first delta
      // actually arrives — so an immediate stream failure (network / 401 /
      // edge 500, before any content) leaves the user's highlighted text
      // untouched instead of silently losing it. On success the first delta
      // clears the original range, then streamed HTML lands exactly where it
      // was. Delete the captured range (not the live selection) in case the
      // cursor moved during the async gap.
      let selectionCleared = false;
      const clearSelectionOnce = () => {
        if (selectionCleared) return;
        selectionCleared = true;
        editor.chain().focus().deleteRange({ from, to }).run();
      };
      const flusher = createHtmlFlusher(editor);
      try {
        await streamContentSSE(
          `/api/content/blog/${postId}/regenerate-section`,
          { mode, selectionHtml: html, keyword },
          controller.signal,
          {
            onDelta: (text) => {
              clearSelectionOnce();
              flusher.push(text);
            },
            onDone: flusher.flush,
            onError: (m) => toast.error(m),
          },
        );
      } catch (e) {
        toastError(e);
      } finally {
        controllerRef.current = null;
        setIsStreaming(false);
      }
    },
    [editor, isStreaming, postId],
  );

  return { isStreaming, compose, regenerate, stop };
}
