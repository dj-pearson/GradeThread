import type { Editor } from "@tiptap/react";
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  Undo,
  Redo,
  Code,
  Minus,
  Sparkles,
  RefreshCw,
  Expand,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RegenMode } from "@/hooks/use-content-ai-stream";

interface TiptapToolbarProps {
  editor: Editor | null;
  // Optional: image upload handler. Receives a File, returns a public URL.
  onImageUpload?: (file: File) => Promise<string>;
  // US-252: when provided, renders the AI submenu (Regenerate selection / Expand
  // / Rewrite for keyword). Omit it for generic uses (e.g. knowledge-doc editor).
  ai?: {
    regenerate: (mode: RegenMode, keyword?: string) => void;
    isStreaming: boolean;
  };
}

// Compact formatting toolbar used above the Tiptap editor. The AI submenu
// (US-252) appears only when an `ai` handler is wired in.
export function TiptapToolbar({ editor, onImageUpload, ai }: TiptapToolbarProps) {
  if (!editor) return null;

  const rewriteForKeyword = () => {
    const keyword = window.prompt("Target keyword for this passage:");
    if (!keyword?.trim()) return;
    ai?.regenerate("rewrite-for-keyword", keyword.trim());
  };

  const btnClass = (active: boolean) =>
    active
      ? "h-8 w-8 bg-accent text-accent-foreground"
      : "h-8 w-8";

  const addLink = () => {
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL", previousUrl ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const addImage = async () => {
    if (onImageUpload) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const url = await onImageUpload(file);
          editor.chain().focus().setImage({ src: url }).run();
        } catch (e) {
          window.alert(
            `Image upload failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      };
      input.click();
    } else {
      const url = window.prompt("Image URL");
      if (!url) return;
      editor.chain().focus().setImage({ src: url }).run();
    }
  };

  const addTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-muted/40 p-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("bold"))}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (⌘B)"
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("italic"))}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (⌘I)"
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("heading", { level: 2 }))}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 2 }).run()
        }
        title="Heading 2"
      >
        <Heading2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("heading", { level: 3 }))}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 3 }).run()
        }
        title="Heading 3"
      >
        <Heading3 className="h-4 w-4" />
      </Button>
      <div className="mx-1 h-6 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("bulletList"))}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("orderedList"))}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        <ListOrdered className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("blockquote"))}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Blockquote"
      >
        <Quote className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("codeBlock"))}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code block"
      >
        <Code className="h-4 w-4" />
      </Button>
      <div className="mx-1 h-6 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={btnClass(editor.isActive("link"))}
        onClick={addLink}
        title="Link"
      >
        <LinkIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={addImage}
        title="Insert image"
      >
        <ImageIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={addTable}
        title="Insert table"
      >
        <TableIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal rule"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <div className="mx-1 h-6 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="Undo (⌘Z)"
      >
        <Undo className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="Redo (⌘⇧Z)"
      >
        <Redo className="h-4 w-4" />
      </Button>
      {ai && (
        <>
          <div className="mx-1 h-6 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2"
                disabled={ai.isStreaming}
                title="AI actions on the selected text"
              >
                <Sparkles className="h-4 w-4" />
                <span className="text-xs">AI</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>On the selected text</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => ai.regenerate("regenerate")}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Regenerate selection
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => ai.regenerate("expand")}>
                <Expand className="mr-2 h-4 w-4" />
                Expand selection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={rewriteForKeyword}>
                <Target className="mr-2 h-4 w-4" />
                Rewrite for keyword…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
