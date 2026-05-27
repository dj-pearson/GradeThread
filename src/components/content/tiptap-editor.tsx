import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import { useEffect, useRef } from "react";

interface TiptapEditorProps {
  // The initial HTML to populate the editor with. The editor is uncontrolled
  // after mount — callers track state via onUpdate, not by re-passing this.
  initialHtml?: string;
  placeholder?: string;
  // Called with HTML on every transaction, debounced by `debounceMs`.
  // Pair with use-debounced-autosave on the page-level hook.
  onChange?: (html: string) => void;
  // Read-only mode for previews.
  editable?: boolean;
  // Expose the Editor instance to the parent (e.g. for toolbar buttons).
  onReady?: (editor: Editor) => void;
  className?: string;
}

// Tiptap WYSIWYG shell. Reusable across the blog editor and the
// knowledge-doc editor. StarterKit covers most of what we need
// (paragraphs, headings, lists, link, bold/italic, blockquote, code,
// code block, horizontal rule, undo/redo). We add Image and a full
// Table set plus a Placeholder hint and Typography niceties.
export function TiptapEditor({
  initialHtml,
  placeholder = "Start writing — or click Generate to draft from the topic…",
  onChange,
  editable = true,
  onReady,
  className,
}: TiptapEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer" },
        },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
      Typography,
    ],
    content: initialHtml ?? "",
    editable,
    onUpdate: ({ editor }) => {
      onChangeRef.current?.(editor.getHTML());
    },
  });

  // Notify the parent once the editor is mounted so it can drive the toolbar.
  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  // If the parent switches a post (id changes), they remount the component
  // via key={id} so this effect only fires on true initial mounts. We still
  // sync `editable` for the rare case it toggles.
  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  return (
    <div
      className={
        className ??
        "tiptap-editor min-h-[60vh] rounded-md border border-input bg-background p-6 prose prose-slate max-w-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
      }
    >
      <EditorContent editor={editor} />
    </div>
  );
}
