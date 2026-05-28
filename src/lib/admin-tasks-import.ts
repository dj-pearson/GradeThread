import type { AdminTaskPriority, AdminTaskStatus } from "@/types/database";

// Parses a defined-but-forgiving Markdown format into a project + task list
// for the admin task board's "Import from Markdown" flow.
//
//   # Project Title
//   > Optional description (one or more > lines)
//
//   ## Phase / Section name
//   - [ ] Task title !high @2026-06-01
//     Indented lines become the task body / instructions.
//   - [x] An already-done task
//
// Rules:
//   #   → project title (first one wins)
//   >   → appended to project description
//   ##  → current section label for following tasks
//   - [ ] / - [x] → a task (`[x]` ⇒ status "done", else "todo")
//   indented non-list lines → appended to the current task's body
//   in-title tokens (stripped + parsed): !high|!medium|!low → priority,
//   @YYYY-MM-DD → due_date. Both optional.

export interface ParsedTask {
  title: string;
  body: string | null;
  section: string | null;
  status: AdminTaskStatus;
  priority: AdminTaskPriority;
  due_date: string | null;
}

export interface ParsedImport {
  title: string;
  description: string | null;
  tasks: ParsedTask[];
}

const TASK_RE = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/;
const PRIORITY_RE = /(?:^|\s)!(high|medium|med|low)\b/i;
const DUE_RE = /(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/;

function normalizePriority(raw: string): AdminTaskPriority {
  const v = raw.toLowerCase();
  if (v === "high") return "high";
  if (v === "low") return "low";
  return "medium";
}

// Pull optional !priority / @due tokens out of a task title, returning the
// cleaned title plus whatever was found.
function extractTokens(title: string): {
  title: string;
  priority: AdminTaskPriority;
  due_date: string | null;
} {
  let priority: AdminTaskPriority = "medium";
  let due_date: string | null = null;
  let text = title;

  const p = text.match(PRIORITY_RE);
  if (p) {
    priority = normalizePriority(p[1] === "med" ? "medium" : p[1]!);
    text = text.replace(PRIORITY_RE, " ");
  }

  const d = text.match(DUE_RE);
  if (d) {
    due_date = d[1]!;
    text = text.replace(DUE_RE, " ");
  }

  return { title: text.replace(/\s+/g, " ").trim(), priority, due_date };
}

export function parseTaskMarkdown(md: string): ParsedImport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let title = "";
  const descLines: string[] = [];
  let currentSection: string | null = null;
  const tasks: ParsedTask[] = [];
  let current: ParsedTask | null = null;

  const flushBodyLine = (raw: string) => {
    if (!current) return;
    const text = raw.trim();
    current.body = current.body ? `${current.body}\n${text}` : text;
  };

  for (const line of lines) {
    const taskMatch = line.match(TASK_RE);
    if (taskMatch) {
      const checked = taskMatch[2]!.toLowerCase() === "x";
      const { title: cleanTitle, priority, due_date } = extractTokens(
        taskMatch[3]!,
      );
      if (!cleanTitle) continue; // skip empty checkbox lines
      current = {
        title: cleanTitle,
        body: null,
        section: currentSection,
        status: checked ? "done" : "todo",
        priority,
        due_date,
      };
      tasks.push(current);
      continue;
    }

    // Headings / description only outside of a task's indented body.
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      if (!title) title = h1[1]!.trim();
      current = null;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      currentSection = h2[1]!.trim() || null;
      current = null;
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      descLines.push(quote[1]!.trim());
      current = null;
      continue;
    }

    // Indented continuation → task body. Blank lines inside a task are kept
    // as paragraph breaks; a blank line with no active task is ignored.
    if (current) {
      if (line.trim() === "") {
        // A blank line ends the body capture for this task.
        current = null;
        continue;
      }
      if (/^\s+\S/.test(line)) {
        flushBodyLine(line);
        continue;
      }
      // A non-indented, non-recognized line ends the current task context.
      current = null;
    }
  }

  return {
    title: title || "Untitled project",
    description: descLines.join("\n").trim() || null,
    tasks,
  };
}

// Convenience summary for the import dialog preview.
export function summarizeImport(parsed: ParsedImport): {
  taskCount: number;
  sectionCount: number;
  sections: string[];
} {
  const sections: string[] = [];
  for (const t of parsed.tasks) {
    const key = t.section ?? "(no section)";
    if (!sections.includes(key)) sections.push(key);
  }
  return {
    taskCount: parsed.tasks.length,
    sectionCount: sections.length,
    sections,
  };
}
