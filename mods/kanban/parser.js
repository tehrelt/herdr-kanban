// Pure Markdown parser and serializer for project backlog epics and tasks.
// Zero host/UI imports so it can run both inside Herdr mods and in unit tests.

export const COLUMNS = [
  { id: "todo", label: "TODO", mark: " ", statusLine: "[ ] TODO" },
  { id: "in_progress", label: "IN PROGRESS", mark: "-", statusLine: "[-] IN PROGRESS" },
  { id: "blocked", label: "BLOCKED", mark: "!", statusLine: "[!] BLOCKED" },
  { id: "done", label: "DONE", mark: "x", statusLine: "[x] DONE" },
];

export const PRIORITIES = ["P0", "P1", "P2", "P3"];

const IGNORED_FILES = new Set([
  "readme.md",
  "current.md",
  "changelog.md",
  "agents.md",
  "recipe.md",
  "contributing.md",
  "claude.md",
  "license.md",
  "security.md",
  "code_of_conduct.md",
  "architecture.md",
]);

const MARK_TO_STATUS = {
  " ": "todo",
  "-": "in_progress",
  "!": "blocked",
  x: "done",
  X: "done",
};

const STATUS_TO_META = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

export function isEpicFilename(filename) {
  if (!filename || typeof filename !== "string") return false;
  const base = filename.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  return lower.endsWith(".md") && !IGNORED_FILES.has(lower);
}

export function isNumberedEpicFilename(filename) {
  if (!isEpicFilename(filename)) return false;
  const base = filename.split(/[\\/]/).pop() ?? "";
  return /^(?:\d+|epic[-_]?\d+)\b.*\.md$/i.test(base);
}

export function markToStatus(mark) {
  return MARK_TO_STATUS[mark] ?? "todo";
}

export function statusToMark(status) {
  return STATUS_TO_META[status]?.mark ?? " ";
}

export function statusToLine(status) {
  return STATUS_TO_META[status]?.statusLine ?? "[ ] TODO";
}

export function parseStatusValue(raw) {
  if (!raw) return null;
  const bracket = raw.match(/\[([ xX!-])\]/);
  if (bracket) return markToStatus(bracket[1]);
  const upper = raw.trim().toUpperCase();
  if (upper.includes("BLOCKED")) return "blocked";
  if (upper.includes("PROGRESS")) return "in_progress";
  if (upper.includes("DONE")) return "done";
  if (upper.includes("TODO")) return "todo";
  return null;
}

export function inferEpicStatus(tasks) {
  if (!tasks || tasks.length === 0) return "todo";
  if (tasks.some((t) => t.status === "blocked")) return "blocked";
  if (tasks.some((t) => t.status === "in_progress")) return "in_progress";
  if (tasks.every((t) => t.status === "done")) return "done";
  if (tasks.some((t) => t.status === "done") && tasks.some((t) => t.status === "todo")) {
    return "in_progress";
  }
  return "todo";
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function joinLines(lines, eol, endsWithNewline) {
  const body = lines.join(eol);
  return endsWithNewline && !body.endsWith(eol) ? body + eol : body;
}

function deriveIdFromFilename(filename) {
  const base = (filename.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "");
  const numMatch = base.match(/^(\d+)/);
  if (numMatch) {
    const num = Number(numMatch[1]);
    return { id: `EPIC-${String(num).padStart(3, "0")}`, number: num };
  }
  return { id: base.toUpperCase() || "EPIC", number: 9999 };
}

function classifySection(heading) {
  const h = heading.trim().toLowerCase();
  if (h === "цель" || h === "goal" || h === "описание" || h === "overview") return "goal";
  if (h === "задачи" || h === "tasks" || h === "checklist") return "tasks";
  if (h === "definition of done" || h === "dod" || h === "критерии готовности") return "dod";
  if (h === "итог реализации" || h === "прогресс" || h === "summary" || h === "notes" || h === "результат") {
    return "summary";
  }
  return "other";
}

export function parseEpicFile(filename, rawText, filePath = filename) {
  const text = typeof rawText === "string" ? rawText : "";
  const eol = detectEol(text);
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (endsWithNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const fallback = deriveIdFromFilename(filename);
  let id = fallback.id;
  let number = fallback.number;
  let title = filename.replace(/\.md$/i, "");
  let project = null;
  let explicitStatus = null;
  let statusLineIndex = -1;
  let priority = null;
  let priorityLineIndex = -1;
  let h1LineIndex = -1;

  const sections = {
    goal: [],
    dod: [],
    summary: [],
    other: [],
  };
  const tasks = [];

  let currentSection = null;
  let currentTask = null;
  let stoppedAtExtraH1 = false;
  let sawSeparator = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (h1LineIndex === -1 && /^#\s+/.test(line)) {
      h1LineIndex = i;
      const h1Body = line.replace(/^#\s+/, "").trim();
      const epicMatch = h1Body.match(/^(EPIC-(\d+))\s*[—–-]\s*(.+)$/i);
      if (epicMatch) {
        id = epicMatch[1].toUpperCase();
        number = Number(epicMatch[2]);
        title = epicMatch[3].trim();
      } else {
        title = h1Body;
      }
      continue;
    }

    // Stop parsing epic sections if a post-epic reference section starts after `---` (e.g. EPIC-040).
    if (sawSeparator && /^#\s+/.test(line)) {
      stoppedAtExtraH1 = true;
      break;
    }

    if (trimmed === "---") {
      sawSeparator = true;
      currentTask = null;
      continue;
    }

    if (currentSection === null) {
      if (!project && /^>\s*Проект:\s*/i.test(trimmed)) {
        project = trimmed.replace(/^>\s*Проект:\s*/i, "").replace(/\*\*/g, "").trim();
        continue;
      }
      const statusMatch = trimmed.match(/^\*\*Status:\*\*\s*(.*)$/i);
      if (statusMatch) {
        statusLineIndex = i;
        explicitStatus = parseStatusValue(statusMatch[1]);
        continue;
      }
      const priorityMatch = trimmed.match(/^\*\*Priority:\*\*\s*(P[0-3])\b/i);
      if (priorityMatch) {
        priorityLineIndex = i;
        priority = priorityMatch[1].toUpperCase();
        continue;
      }
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      currentTask = null;
      currentSection = classifySection(h2Match[1]);
      if (currentSection === "other") {
        sections.other.push(`### ${h2Match[1].trim()}`);
      }
      continue;
    }

    // Parse tasks inside `## Задачи` (or before any section if a file omits `## Задачи`).
    if (currentSection === "tasks" || currentSection === null) {
      const taskMatch = line.match(/^-\s+\[([ xX!-])\]\s+(.*)$/);
      if (taskMatch) {
        const mark = taskMatch[1];
        const body = taskMatch[2].trim();
        const idMatch = body.match(/^([A-Z]+-\d+(?:\.\d+)*)\s+(.+)$/);
        const taskId = idMatch ? idMatch[1] : null;
        const taskTitle = idMatch ? idMatch[2].trim() : body;
        currentTask = {
          index: tasks.length,
          id: taskId ?? `#${tasks.length + 1}`,
          hasExplicitId: Boolean(taskId),
          title: taskTitle,
          rawTitle: body,
          status: markToStatus(mark),
          mark,
          lineIndex: i,
          subitems: [],
        };
        tasks.push(currentTask);
        continue;
      }

      if (currentTask && /^\s+\S/.test(line)) {
        const sub = trimmed.replace(/^-\s+/, "");
        currentTask.subitems.push(sub);
        continue;
      }

      if (trimmed !== "") {
        currentTask = null;
      }
    }

    if (currentSection && currentSection !== "tasks") {
      sections[currentSection].push(line);
    }
  }

  const counts = {
    total: tasks.length,
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }

  const status = explicitStatus ?? inferEpicStatus(tasks);
  const cleanSection = (arr) => arr.join("\n").trim();

  return {
    filename,
    filePath,
    id,
    number,
    title,
    project,
    status,
    explicitStatus,
    statusLineIndex,
    priority,
    priorityLineIndex,
    h1LineIndex,
    goal: cleanSection(sections.goal),
    dod: cleanSection(sections.dod),
    summary: cleanSection(sections.summary),
    other: cleanSection(sections.other),
    tasks,
    counts,
    eol,
    endsWithNewline,
    stoppedAtExtraH1,
    rawText: text,
  };
}

function splitForEdit(rawText) {
  const eol = detectEol(rawText);
  const endsWithNewline = rawText.endsWith("\n");
  const lines = rawText.split(/\r?\n/);
  if (endsWithNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { lines, eol, endsWithNewline };
}

function findMetadataInsertIndex(lines) {
  const priorityIdx = lines.findIndex((l) => /^\*\*Priority:\*\*/i.test(l.trim()));
  if (priorityIdx !== -1) return { index: priorityIdx, beforePriority: true };

  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1Idx === -1) return { index: 0, beforePriority: false };

  let idx = h1Idx + 1;
  while (idx < lines.length && (lines[idx].trim() === "" || lines[idx].trim().startsWith(">"))) {
    idx++;
  }
  return { index: idx, beforePriority: false };
}

export function updateEpicStatus(rawText, nextStatus) {
  const { lines, eol, endsWithNewline } = splitForEdit(rawText);
  const nextLine = `**Status:** ${statusToLine(nextStatus)}`;
  const statusIdx = lines.findIndex((l) => /^\*\*Status:\*\*/i.test(l.trim()));

  if (statusIdx !== -1) {
    lines[statusIdx] = nextLine;
    return joinLines(lines, eol, endsWithNewline);
  }

  const { index, beforePriority } = findMetadataInsertIndex(lines);
  if (beforePriority) {
    lines.splice(index, 0, nextLine, "");
  } else {
    const needsLeadingBlank = index > 0 && lines[index - 1].trim() !== "";
    const insert = needsLeadingBlank ? ["", nextLine] : [nextLine, ""];
    lines.splice(index, 0, ...insert);
  }
  return joinLines(lines, eol, endsWithNewline);
}

export function updateEpicPriority(rawText, nextPriority) {
  const normalized = String(nextPriority).toUpperCase();
  if (!PRIORITIES.includes(normalized)) return rawText;

  const { lines, eol, endsWithNewline } = splitForEdit(rawText);
  const nextLine = `**Priority:** ${normalized}`;
  const priorityIdx = lines.findIndex((l) => /^\*\*Priority:\*\*/i.test(l.trim()));

  if (priorityIdx !== -1) {
    lines[priorityIdx] = nextLine;
    return joinLines(lines, eol, endsWithNewline);
  }

  const statusIdx = lines.findIndex((l) => /^\*\*Status:\*\*/i.test(l.trim()));
  if (statusIdx !== -1) {
    lines.splice(statusIdx + 1, 0, "", nextLine);
    return joinLines(lines, eol, endsWithNewline);
  }

  const { index } = findMetadataInsertIndex(lines);
  const needsLeadingBlank = index > 0 && lines[index - 1].trim() !== "";
  lines.splice(index, 0, ...(needsLeadingBlank ? ["", nextLine] : [nextLine, ""]));
  return joinLines(lines, eol, endsWithNewline);
}

export function updateTaskStatus(rawText, taskLineIndex, nextStatus, options = {}) {
  const syncEpicStatus = options.syncEpicStatus !== false;
  const { lines, eol, endsWithNewline } = splitForEdit(rawText);
  if (taskLineIndex < 0 || taskLineIndex >= lines.length) return rawText;

  const line = lines[taskLineIndex];
  const match = line.match(/^(\s*-\s+\[)([ xX!-])(\]\s+.*)$/);
  if (!match) return rawText;

  const prevStatus = markToStatus(match[2]);
  const nextMark = statusToMark(nextStatus);
  lines[taskLineIndex] = `${match[1]}${nextMark}${match[3]}`;
  let updated = joinLines(lines, eol, endsWithNewline);

  if (!syncEpicStatus) return updated;

  const parsed = parseEpicFile("epic.md", updated);
  const tasks = parsed.tasks;
  if (tasks.length === 0) return updated;

  const allDone = tasks.every((t) => t.status === "done");
  const allTodo = tasks.every((t) => t.status === "todo");
  const anyBlocked = tasks.some((t) => t.status === "blocked");

  if (nextStatus === "blocked") {
    if (parsed.explicitStatus && parsed.explicitStatus !== "blocked") {
      updated = updateEpicStatus(updated, "blocked");
    }
    return updated;
  }

  if (!parsed.explicitStatus) {
    return updated;
  }

  if (parsed.explicitStatus === "blocked" && prevStatus !== "blocked" && !allDone) {
    return updated;
  }

  if (anyBlocked) {
    if (parsed.explicitStatus !== "blocked") updated = updateEpicStatus(updated, "blocked");
  } else if (allDone) {
    if (parsed.explicitStatus !== "done") updated = updateEpicStatus(updated, "done");
  } else if (allTodo) {
    if (parsed.explicitStatus !== "todo") updated = updateEpicStatus(updated, "todo");
  } else if (parsed.explicitStatus !== "in_progress") {
    updated = updateEpicStatus(updated, "in_progress");
  }

  return updated;
}

export function nextTaskId(epic) {
  const epicNumMatch = epic?.id?.match(/EPIC-(\d+)/i);
  if (!epicNumMatch) return null;
  const epicNum = epicNumMatch[1];
  let maxSub = 0;
  for (const t of epic.tasks ?? []) {
    const m = t.rawTitle?.match(/^TASK-\d+\.(\d+)\b/i);
    if (m) maxSub = Math.max(maxSub, Number(m[1]));
  }
  return `TASK-${epicNum}.${maxSub + 1}`;
}

export function addTaskToEpic(rawText, title, epicId = null) {
  const clean = String(title ?? "").trim();
  if (!clean) return rawText;

  const parsed = parseEpicFile("epic.md", rawText);
  const hasExplicitTaskId = /^[A-Z]+-\d+(?:\.\d+)*\b/.test(clean);
  const generatedId = !hasExplicitTaskId && epicId ? nextTaskId({ ...parsed, id: epicId }) : null;
  const taskLine = `- [ ] ${generatedId ? `${generatedId} ${clean}` : clean}`;

  const { lines, eol, endsWithNewline } = splitForEdit(rawText);

  // Find `## Задачи` section bounds.
  const tasksHeadingIdx = lines.findIndex((l) => /^##\s+(Задачи|Tasks|Checklist)\s*$/i.test(l.trim()));
  if (tasksHeadingIdx !== -1) {
    let sectionEnd = lines.length;
    for (let i = tasksHeadingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]) || lines[i].trim() === "---") {
        sectionEnd = i;
        break;
      }
    }

    // Find last non-empty line inside the tasks section.
    let lastContentIdx = tasksHeadingIdx;
    for (let i = sectionEnd - 1; i > tasksHeadingIdx; i--) {
      if (lines[i].trim() !== "") {
        lastContentIdx = i;
        break;
      }
    }

    // Detect whether existing tasks are separated by blank lines.
    const spacedTasks = parsed.tasks.length >= 2
      ? parsed.tasks[1].lineIndex - parsed.tasks[0].lineIndex > 1
      : true;

    const insertAt = lastContentIdx + 1;
    const toInsert = lastContentIdx === tasksHeadingIdx
      ? ["", taskLine]
      : spacedTasks
        ? ["", taskLine]
        : [taskLine];

    lines.splice(insertAt, 0, ...toInsert);
    return joinLines(lines, eol, endsWithNewline);
  }

  // No `## Задачи` section yet: insert before DoD / Summary / `---` / EOF.
  let insertSectionAt = lines.findIndex((l) => /^##\s+/.test(l) && !/^##\s+(Цель|Goal|Описание|Overview)\s*$/i.test(l.trim()));
  if (insertSectionAt === -1) {
    insertSectionAt = lines.findIndex((l) => l.trim() === "---");
  }
  if (insertSectionAt === -1) insertSectionAt = lines.length;

  const block = ["## Задачи", "", taskLine, ""];
  if (insertSectionAt > 0 && lines[insertSectionAt - 1].trim() !== "") {
    block.unshift("");
  }
  lines.splice(insertSectionAt, 0, ...block);
  return joinLines(lines, eol, endsWithNewline);
}

export function addTaskAndSyncEpic(rawText, title, epicId = null) {
  let updated = addTaskToEpic(rawText, title, epicId);
  if (updated === rawText) return updated;
  const parsed = parseEpicFile("epic.md", updated);
  if (parsed.explicitStatus === "done") {
    const hasDone = parsed.tasks.some((t) => t.status === "done");
    updated = updateEpicStatus(updated, hasDone ? "in_progress" : "todo");
  }
  return updated;
}

export function slugifyEpicFilename(number, title) {
  const prefix = String(number).padStart(3, "0");
  const slug = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${slug || "epic"}.md`;
}

export function createEpicMarkdown({ number, title, priority = "P1", goal = "", project = "", firstTask = "" }) {
  const id = `EPIC-${String(number).padStart(3, "0")}`;
  const lines = [`# ${id} — ${title.trim()}`, ""];
  if (project && project.trim()) {
    lines.push(`> Проект: **${project.trim()}**`, "");
  }
  lines.push("**Status:** [ ] TODO", "", `**Priority:** ${priority}`, "");
  if (goal && goal.trim()) {
    lines.push("## Цель", "", goal.trim(), "");
  }
  lines.push("## Задачи", "");
  if (firstTask && firstTask.trim()) {
    lines.push(`- [ ] TASK-${String(number).padStart(3, "0")}.1 ${firstTask.trim()}`, "");
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function buildAgentPrompt(epic, task = null, projectRoot = null) {
  const lines = [];
  if (task) {
    lines.push(`Выполни задачу ${task.id} из ${epic.id} (${epic.title}).`);
    lines.push("");
    lines.push(`Задача: ${task.title}`);
    if (task.subitems?.length) {
      lines.push("Подпункты:");
      for (const sub of task.subitems) lines.push(`- ${sub}`);
    }
  } else {
    lines.push(`Реализуй ${epic.id} — ${epic.title}.`);
    const openTasks = (epic.tasks ?? []).filter((t) => t.status !== "done");
    if (openTasks.length) {
      lines.push("");
      lines.push("Незавершённые задачи:");
      for (const t of openTasks) {
        const mark = statusToMark(t.status);
        lines.push(`- [${mark}] ${t.rawTitle}`);
        for (const sub of t.subitems ?? []) lines.push(`  - ${sub}`);
      }
    }
  }

  if (epic.goal) {
    lines.push("");
    lines.push(`Цель эпика: ${epic.goal}`);
  }
  if (epic.dod) {
    lines.push("");
    lines.push(`Definition of Done:\n${epic.dod}`);
  }
  lines.push("");
  lines.push(`Файл бэклога: ${epic.filePath}`);
  if (projectRoot) {
    lines.push(`Корень проекта: ${projectRoot}`);
  }
  lines.push("После выполнения обнови статус задачи/эпика в файле бэклога.");
  return lines.join("\n");
}
