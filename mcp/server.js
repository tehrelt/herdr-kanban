import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  pinBacklogRoot,
  resolvePinnedBacklogDir,
  getBoardSummary,
  listEpics,
  getEpic,
  listTasks,
  createEpic,
  updateEpic,
  addTask,
  updateTask,
  buildPrompt,
} from "./backlog.js";

const StatusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
const SINGLE_LINE_RE = /^[^\r\n]*$/;
const singleLineSchema = (field) =>
  z.string().regex(SINGLE_LINE_RE, `${field} must be a single line (cannot contain CR or LF)`);
const BacklogDirSchema = z
  .string()
  .optional()
  .describe("Path to backlog directory or project root (auto-detected from cwd or HERDR_KANBAN_DIR if omitted)");

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function textResult(text) {
  return {
    content: [{ type: "text", text: String(text) }],
  };
}

function errorResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function withErrorHandling(fn) {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function createKanbanMcpServer({ defaultBacklogDir = null } = {}) {
  const server = new McpServer({
    name: "herdr-kanban",
    version: "0.1.0",
  });

  const pinnedRoot = defaultBacklogDir ? pinBacklogRoot(defaultBacklogDir) : null;
  const pinnedStat = pinnedRoot ? fs.lstatSync(pinnedRoot) : null;
  const resolveDir = (backlogDir) =>
    resolvePinnedBacklogDir(pinnedRoot, backlogDir, { expectedStat: pinnedStat, strictCanonical: true });

  server.registerTool(
    "kanban_board_summary",
    {
      title: "Board Summary",
      description: "Get Kanban board summary: epic and task counts by status/priority, blocked and in-progress epics.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir }) => jsonResult(getBoardSummary(resolveDir(backlogDir)))),
  );

  server.registerTool(
    "kanban_list_epics",
    {
      title: "List Epics",
      description: "List Markdown backlog epics with optional status, priority, and text search filters.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        status: StatusSchema.optional().describe("Filter by epic status"),
        priority: PrioritySchema.optional().describe("Filter by priority (P0-P3)"),
        query: z.string().optional().describe("Case-insensitive search across epic ID, title, goal, and tasks"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, status, priority, query }) =>
      jsonResult(listEpics(resolveDir(backlogDir), { status, priority, query })),
    ),
  );

  server.registerTool(
    "kanban_get_epic",
    {
      title: "Get Epic",
      description: "Get full details of an epic (goal, DoD, summary, and all tasks) by ID (e.g. EPIC-006), number, or filename.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        epic: z.string().min(1).describe("Epic ID (EPIC-006), number (6), or filename (006-observability.md)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, epic }) => jsonResult(getEpic(resolveDir(backlogDir), epic))),
  );

  server.registerTool(
    "kanban_list_tasks",
    {
      title: "List Tasks",
      description: "List tasks across all epics or a single epic with status, priority, search, and pagination.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        epic: z.string().optional().describe("Optional epic ID, number, or filename to scope tasks"),
        status: StatusSchema.optional().describe("Filter by task status"),
        priority: PrioritySchema.optional().describe("Filter by parent epic priority"),
        query: z.string().optional().describe("Case-insensitive search across task ID, title, and subitems"),
        limit: z.number().int().min(1).max(500).optional().describe("Max items to return (default 100)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, epic, status, priority, query, limit, offset }) =>
      jsonResult(listTasks(resolveDir(backlogDir), { epic, status, priority, query, limit, offset })),
    ),
  );

  server.registerTool(
    "kanban_create_epic",
    {
      title: "Create Epic",
      description: "Create a new numbered Markdown epic file in the backlog directory.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        title: singleLineSchema("title").trim().min(1).describe("Epic title"),
        priority: PrioritySchema.optional().describe("Priority P0-P3 (default P1)"),
        goal: z.string().optional().describe("Epic goal section text"),
        project: singleLineSchema("project").optional().describe("Project name (inherits from existing epics if omitted)"),
        firstTask: singleLineSchema("firstTask").optional().describe("Optional first task title (creates TASK-NNN.1)"),
        number: z.number().int().positive().optional().describe("Optional explicit epic number (auto-increments if omitted)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(({ backlogDir, title, priority, goal, project, firstTask, number }) =>
      jsonResult(createEpic(resolveDir(backlogDir), { title, priority, goal, project, firstTask, number })),
    ),
  );

  server.registerTool(
    "kanban_update_epic",
    {
      title: "Update Epic",
      description: "Update an epic's status and/or priority in its Markdown file.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        epic: z.string().min(1).describe("Epic ID, number, or filename"),
        status: StatusSchema.optional().describe("New epic status"),
        priority: PrioritySchema.optional().describe("New epic priority (P0-P3)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, epic, status, priority }) =>
      jsonResult(updateEpic(resolveDir(backlogDir), epic, { status, priority })),
    ),
  );

  server.registerTool(
    "kanban_add_task",
    {
      title: "Add Task",
      description: "Append a new task to an epic with auto-generated TASK-NNN.K ID and sync epic status if needed.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        epic: z.string().min(1).describe("Epic ID, number, or filename"),
        title: singleLineSchema("title").trim().min(1).describe("Task title (or explicit ID + title)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(({ backlogDir, epic, title }) =>
      jsonResult(addTask(resolveDir(backlogDir), { epic, title })),
    ),
  );

  server.registerTool(
    "kanban_update_task",
    {
      title: "Update Task",
      description: "Update a task's status ([ ], [-], [!], [x]) and optionally sync its parent epic status.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        task: z.string().min(1).describe("Task ID (e.g. TASK-006.2) or lineIndex when epic is specified"),
        epic: z.string().optional().describe("Optional epic ID/filename (required only if task ID is ambiguous)"),
        status: StatusSchema.describe("New task status"),
        syncEpicStatus: z.boolean().optional().describe("Sync parent epic status automatically (default true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, epic, task, status, syncEpicStatus }) =>
      jsonResult(updateTask(resolveDir(backlogDir), { epic, task, status, syncEpicStatus })),
    ),
  );

  server.registerTool(
    "kanban_build_prompt",
    {
      title: "Build Agent Prompt",
      description: "Generate a structured execution prompt for an epic or a specific task.",
      inputSchema: {
        backlogDir: BacklogDirSchema,
        epic: z.string().min(1).describe("Epic ID, number, or filename"),
        task: z.string().optional().describe("Optional task ID (e.g. TASK-006.2)"),
        projectRoot: z.string().optional().describe("Optional project root path to include in prompt"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withErrorHandling(({ backlogDir, epic, task, projectRoot }) =>
      textResult(buildPrompt(resolveDir(backlogDir), { epic, task, projectRoot })),
    ),
  );

  return server;
}
