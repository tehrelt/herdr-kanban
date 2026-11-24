import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COLUMNS,
  isEpicFilename,
  isNumberedEpicFilename,
  parseEpicFile,
  updateEpicStatus,
  updateEpicPriority,
  updateTaskStatus,
  addTaskToEpic,
  addTaskAndSyncEpic,
  createEpicMarkdown,
  slugifyEpicFilename,
  buildAgentPrompt,
  nextEpicNumber,
  buildCreateEpicsPrompt,
} from "../mods/kanban/parser.js";

describe("isEpicFilename", () => {
  test("accepts epic markdown files and ignores README/CURRENT/RECIPE", () => {
    expect(isEpicFilename("001-bootstrap.md")).toBe(true);
    expect(isEpicFilename("040-исследовательская-часть.md")).toBe(true);
    expect(isEpicFilename("README.md")).toBe(false);
    expect(isEpicFilename("CURRENT.md")).toBe(false);
    expect(isEpicFilename("RECIPE.md")).toBe(false);
    expect(isEpicFilename("notes.txt")).toBe(false);
  });

  test("isNumberedEpicFilename matches numbered or EPIC-prefixed files only", () => {
    expect(isNumberedEpicFilename("001-bootstrap.md")).toBe(true);
    expect(isNumberedEpicFilename("EPIC-012.md")).toBe(true);
    expect(isNumberedEpicFilename("notes.md")).toBe(false);
    expect(isNumberedEpicFilename("RECIPE.md")).toBe(false);
  });
});

describe("parseEpicFile", () => {
  test("parses standard epic with CRLF, goal, tasks, subitems, DoD, summary", () => {
    const raw = [
      "# EPIC-006 — Observability foundation",
      "",
      "> Проект: **ICYRE**",
      "",
      "**Status:** [-] IN PROGRESS",
      "",
      "**Priority:** P1",
      "",
      "## Цель",
      "",
      "Сделать сервисы наблюдаемыми.",
      "",
      "## Задачи",
      "",
      "- [x] TASK-006.1 Подключить OpenTelemetry SDK.",
      "  - HTTP propagation",
      "  - Kafka headers",
      "",
      "- [ ] TASK-006.2 Подготовить propagation для gRPC.",
      "",
      "## Definition of Done",
      "",
      "- HTTP request виден в trace.",
      "",
      "## Итог реализации",
      "",
      "Готово почти всё.",
      "",
      "---",
      "",
    ].join("\r\n");

    const epic = parseEpicFile("006-observability-foundation.md", raw, "C:/repo/backlog/006-observability-foundation.md");
    expect(epic.id).toBe("EPIC-006");
    expect(epic.number).toBe(6);
    expect(epic.title).toBe("Observability foundation");
    expect(epic.status).toBe("in_progress");
    expect(epic.explicitStatus).toBe("in_progress");
    expect(epic.priority).toBe("P1");
    expect(epic.goal).toBe("Сделать сервисы наблюдаемыми.");
    expect(epic.dod).toBe("- HTTP request виден в trace.");
    expect(epic.summary).toBe("Готово почти всё.");
    expect(epic.eol).toBe("\r\n");
    expect(epic.tasks).toHaveLength(2);
    expect(epic.tasks[0]).toMatchObject({
      id: "TASK-006.1",
      title: "Подключить OpenTelemetry SDK.",
      status: "done",
      subitems: ["HTTP propagation", "Kafka headers"],
    });
    expect(epic.tasks[1]).toMatchObject({
      id: "TASK-006.2",
      status: "todo",
    });
    expect(epic.counts).toEqual({ total: 2, todo: 1, in_progress: 0, blocked: 0, done: 1 });
  });

  test("infers status when **Status:** line is omitted", () => {
    const allDone = "# EPIC-015 — Social\n\n**Priority:** P2\n\n## Задачи\n\n- [x] TASK-015.1 A\n- [x] TASK-015.2 B\n";
    expect(parseEpicFile("015.md", allDone).status).toBe("done");

    const mixed = "# EPIC-035 — Security\n\n**Priority:** P1\n\n## Задачи\n\n- [x] TASK-035.1 A\n- [ ] TASK-035.2 B\n";
    expect(parseEpicFile("035.md", mixed).status).toBe("in_progress");

    const blocked = "# EPIC-099 — Blocked\n\n## Задачи\n\n- [!] TASK-099.1 Wait\n- [ ] TASK-099.2 Next\n";
    expect(parseEpicFile("099.md", blocked).status).toBe("blocked");

    const allTodo = "# EPIC-030 — Notif\n\n**Priority:** P3\n\n## Задачи\n\n- [ ] TASK-030.1 A\n";
    expect(parseEpicFile("030.md", allTodo).status).toBe("todo");
  });

  test("stops before post-separator extra H1 sections (like EPIC-040)", () => {
    const raw = [
      "# EPIC-040 — Исследовательская часть",
      "",
      "**Priority:** P1",
      "",
      "## Задачи",
      "",
      "- [ ] TASK-040.1 Baseline",
      "",
      "---",
      "",
      "# MVP milestone",
      "",
      "1. Зарегистрироваться",
    ].join("\n");

    const epic = parseEpicFile("040.md", raw);
    expect(epic.tasks).toHaveLength(1);
    expect(epic.status).toBe("todo");
  });
});

describe("mutations preserve formatting and update markdown safely", () => {
  test("updateEpicStatus updates existing status and preserves CRLF", () => {
    const raw = "# EPIC-001 — Test\r\n\r\n**Status:** [ ] TODO\r\n\r\n**Priority:** P0\r\n";
    const next = updateEpicStatus(raw, "in_progress");
    expect(next).toBe("# EPIC-001 — Test\r\n\r\n**Status:** [-] IN PROGRESS\r\n\r\n**Priority:** P0\r\n");
  });

  test("updateEpicStatus inserts **Status:** before **Priority:** when missing", () => {
    const raw = "# EPIC-015 — Social\n\n> Проект: **Test**\n\n**Priority:** P2\n\n## Задачи\n\n- [ ] TASK-015.1 A\n";
    const next = updateEpicStatus(raw, "blocked");
    expect(next).toContain("**Status:** [!] BLOCKED\n\n**Priority:** P2");
    expect(parseEpicFile("015.md", next).status).toBe("blocked");
  });

  test("updateEpicPriority updates or inserts priority", () => {
    const raw = "# EPIC-001 — Test\n\n**Status:** [ ] TODO\n\n**Priority:** P2\n";
    expect(updateEpicPriority(raw, "P0")).toContain("**Priority:** P0");

    const noPrio = "# EPIC-001 — Test\n\n**Status:** [ ] TODO\n\n## Задачи\n";
    expect(updateEpicPriority(noPrio, "P1")).toContain("**Status:** [ ] TODO\n\n**Priority:** P1");
  });

  test("updateTaskStatus toggles task mark and syncs explicit epic status", () => {
    const raw = [
      "# EPIC-006 — Obs",
      "",
      "**Status:** [-] IN PROGRESS",
      "",
      "**Priority:** P1",
      "",
      "## Задачи",
      "",
      "- [x] TASK-006.1 One",
      "",
      "- [ ] TASK-006.2 Two",
      "",
    ].join("\n");

    const parsed = parseEpicFile("006.md", raw);
    const doneAll = updateTaskStatus(raw, parsed.tasks[1].lineIndex, "done");
    const parsedDone = parseEpicFile("006.md", doneAll);
    expect(parsedDone.tasks[1].status).toBe("done");
    expect(parsedDone.status).toBe("done");
    expect(doneAll).toContain("**Status:** [x] DONE");

    const reopened = updateTaskStatus(doneAll, parsedDone.tasks[0].lineIndex, "todo");
    const parsedReopened = parseEpicFile("006.md", reopened);
    expect(parsedReopened.status).toBe("in_progress");
    expect(reopened).toContain("**Status:** [-] IN PROGRESS");
  });

  test("updateTaskStatus preserves epic-level BLOCKED until all tasks done or blocked task unblocked", () => {
    const raw = [
      "# EPIC-050 — Playlist",
      "",
      "**Status:** [!] BLOCKED",
      "",
      "## Задачи",
      "",
      "- [ ] TASK-050.1 Design",
      "- [ ] TASK-050.2 Implement",
      "",
    ].join("\n");

    const parsed = parseEpicFile("050.md", raw);
    const step1 = updateTaskStatus(raw, parsed.tasks[0].lineIndex, "in_progress");
    expect(parseEpicFile("050.md", step1).status).toBe("blocked");

    const step2 = updateTaskStatus(step1, parsed.tasks[0].lineIndex, "done");
    expect(parseEpicFile("050.md", step2).status).toBe("blocked");

    const step3 = updateTaskStatus(step2, parsed.tasks[1].lineIndex, "done");
    expect(parseEpicFile("050.md", step3).status).toBe("done");
  });

  test("addTaskToEpic generates next TASK-NNN.K id and preserves spacing", () => {
    const raw = [
      "# EPIC-006 — Obs",
      "",
      "**Status:** [x] DONE",
      "",
      "## Задачи",
      "",
      "- [x] TASK-006.1 First",
      "",
      "- [x] TASK-006.2 Second",
      "",
      "## Definition of Done",
      "",
      "- Done",
      "",
    ].join("\n");

    const next = addTaskAndSyncEpic(raw, "Third task", "EPIC-006");
    const parsed = parseEpicFile("006.md", next);
    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[2].id).toBe("TASK-006.3");
    expect(parsed.tasks[2].title).toBe("Third task");
    expect(parsed.status).toBe("in_progress");
    expect(next).toContain("- [ ] TASK-006.3 Third task\n\n## Definition of Done");
  });

  test("createEpicMarkdown and slugifyEpicFilename produce valid epic", () => {
    const filename = slugifyEpicFilename(54, "Kanban доска");
    expect(filename).toBe("054-kanban-доска.md");
    const md = createEpicMarkdown({
      number: 54,
      title: "Kanban доска",
      priority: "P1",
      goal: "Видеть задачи",
      firstTask: "Сделать парсер",
    });
    const parsed = parseEpicFile(filename, md);
    expect(parsed.id).toBe("EPIC-054");
    expect(parsed.status).toBe("todo");
    expect(parsed.priority).toBe("P1");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe("TASK-054.1");
  });

  test("buildAgentPrompt includes epic, task, and file path", () => {
    const epic = parseEpicFile(
      "006.md",
      "# EPIC-006 — Obs\n\n**Status:** [-] IN PROGRESS\n\n## Цель\n\nTraces\n\n## Задачи\n\n- [ ] TASK-006.3 gRPC\n",
      "C:/repo/backlog/006.md",
    );
    const prompt = buildAgentPrompt(epic, epic.tasks[0], "C:/repo");
    expect(prompt).toContain("TASK-006.3");
    expect(prompt).toContain("EPIC-006");
    expect(prompt).toContain("C:/repo/backlog/006.md");
    expect(prompt).toContain("C:/repo");
  });

  test("nextEpicNumber returns max number < 9000 plus 1, or 1 when empty", () => {
    expect(nextEpicNumber([])).toBe(1);
    expect(nextEpicNumber([{ number: 9999 }])).toBe(1);
    expect(nextEpicNumber([{ number: 1 }, { number: 5 }, { number: 9999 }])).toBe(6);
  });

  test("buildCreateEpicsPrompt includes description, backlogDir, next EPIC id, project, and format rules", () => {
    const prompt = buildCreateEpicsPrompt({
      description: "Добавить OAuth и страницу профиля",
      backlogDir: "C:/repo/backlog",
      nextNumber: 7,
      projectRoot: "C:/repo",
      project: "Herdr",
    });
    expect(prompt).toContain("Добавить OAuth и страницу профиля");
    expect(prompt).toContain("C:/repo/backlog");
    expect(prompt).toContain("EPIC-007");
    expect(prompt).toContain("007-");
    expect(prompt).toContain("C:/repo");
    expect(prompt).toContain("Herdr");
    expect(prompt).toContain("**Status:** [ ] TODO");
    expect(prompt).toContain("**Priority:**");
    expect(prompt).toContain("## Задачи");
  });
});

describe("real icyre/backlog compatibility", () => {
  const icyreBacklog = process.env.ICYRE_BACKLOG || path.join(os.homedir(), "repos", "icyre", "backlog");
  const exists = fs.existsSync(icyreBacklog);

  test("parses all 53 epic files in icyre/backlog without errors", () => {
    if (!exists) return;
    const files = fs.readdirSync(icyreBacklog).filter(isEpicFilename);
    expect(files.length).toBe(53);

    const epics = files.map((f) => {
      const full = path.join(icyreBacklog, f);
      return parseEpicFile(f, fs.readFileSync(full, "utf8"), full);
    });

    const validStatuses = new Set(COLUMNS.map((c) => c.id));
    for (const epic of epics) {
      expect(epic.id).toMatch(/^EPIC-\d{3}$/);
      expect(epic.title.length).toBeGreaterThan(0);
      expect(validStatuses.has(epic.status)).toBe(true);
      expect(epic.tasks.length).toBeGreaterThan(0);
    }

    const epic006 = epics.find((e) => e.id === "EPIC-006");
    expect(epic006.status).toBe("in_progress");
    expect(epic006.counts.done).toBe(10);
    expect(epic006.counts.todo).toBe(1);

    const epic050 = epics.find((e) => e.id === "EPIC-050");
    expect(epic050.status).toBe("blocked");

    const epic015 = epics.find((e) => e.id === "EPIC-015");
    expect(epic015.status).toBe("done");

    const epic035 = epics.find((e) => e.id === "EPIC-035");
    expect(epic035.status).toBe("in_progress");
  });
});
