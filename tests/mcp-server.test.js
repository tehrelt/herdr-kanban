import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKanbanMcpServer } from "../mcp/server.js";
import { parseCliArgs } from "../mcp/index.js";

function makeTempBacklog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-kanban-srv-"));
  const backlog = path.join(root, "backlog");
  fs.mkdirSync(backlog, { recursive: true });
  fs.writeFileSync(
    path.join(backlog, "001-init.md"),
    [
      "# EPIC-001 — Init",
      "",
      "**Status:** [ ] TODO",
      "",
      "**Priority:** P1",
      "",
      "## Цель",
      "",
      "Bootstrap project.",
      "",
      "## Задачи",
      "",
      "- [ ] TASK-001.1 Setup repo",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, backlog };
}

function parseToolJson(result) {
  const text = result.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

describe("mcp/server integration", () => {
  let tmp;
  let client;
  let server;

  beforeEach(async () => {
    tmp = makeTempBacklog();
    server = createKanbanMcpServer({ defaultBacklogDir: tmp.backlog });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(tmp.root, { recursive: true, force: true });
  });

  test("lists all kanban tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("kanban_board_summary");
    expect(names).toContain("kanban_list_epics");
    expect(names).toContain("kanban_get_epic");
    expect(names).toContain("kanban_list_tasks");
    expect(names).toContain("kanban_create_epic");
    expect(names).toContain("kanban_update_epic");
    expect(names).toContain("kanban_add_task");
    expect(names).toContain("kanban_update_task");
    expect(names).toContain("kanban_build_prompt");
  });

  test("executes full epic and task lifecycle via MCP tools", async () => {
    const summaryRes = await client.callTool({ name: "kanban_board_summary", arguments: {} });
    expect(summaryRes.isError).toBeFalsy();
    expect(parseToolJson(summaryRes).epics.total).toBe(1);

    const createRes = await client.callTool({
      name: "kanban_create_epic",
      arguments: {
        title: "API Gateway",
        priority: "P0",
        goal: "Route traffic",
        firstTask: "Add healthcheck",
      },
    });
    expect(createRes.isError).toBeFalsy();
    const created = parseToolJson(createRes);
    expect(created.id).toBe("EPIC-002");

    const addRes = await client.callTool({
      name: "kanban_add_task",
      arguments: { epic: "EPIC-002", title: "Add rate limit" },
    });
    expect(addRes.isError).toBeFalsy();
    expect(parseToolJson(addRes).task.id).toBe("TASK-002.2");

    const updateTaskRes = await client.callTool({
      name: "kanban_update_task",
      arguments: { task: "TASK-002.1", status: "done" },
    });
    expect(updateTaskRes.isError).toBeFalsy();
    const updatedTask = parseToolJson(updateTaskRes);
    expect(updatedTask.task.status).toBe("done");
    expect(updatedTask.epic.status).toBe("in_progress");

    const listTasksRes = await client.callTool({
      name: "kanban_list_tasks",
      arguments: { epic: "EPIC-002", status: "todo" },
    });
    expect(parseToolJson(listTasksRes).items.map((t) => t.id)).toEqual(["TASK-002.2"]);

    const promptRes = await client.callTool({
      name: "kanban_build_prompt",
      arguments: { epic: "EPIC-002", task: "TASK-002.2" },
    });
    expect(promptRes.isError).toBeFalsy();
    expect(promptRes.content[0].text).toContain("TASK-002.2");
  });

  test("returns isError: true on invalid epic or task", async () => {
    const res = await client.callTool({
      name: "kanban_get_epic",
      arguments: { epic: "EPIC-404" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("EPIC-404");
  });

  test("enforces pinned defaultBacklogDir boundary for backlogDir argument", async () => {
    const outside = makeTempBacklog();
    try {
      const outsideRes = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: outside.backlog },
      });
      expect(outsideRes.isError).toBe(true);
      expect(outsideRes.content[0].text).toContain("outside configured root");

      const parentRes = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: tmp.root },
      });
      expect(parentRes.isError).toBe(true);
      expect(parentRes.content[0].text).toContain("outside configured root");

      const equalRes = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: tmp.backlog },
      });
      expect(equalRes.isError).toBeFalsy();

      const subDir = path.join(tmp.backlog, "nested");
      fs.mkdirSync(subDir);
      const subRes = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: subDir },
      });
      expect(subRes.isError).toBeFalsy();

      const linkDir = path.join(tmp.backlog, "escape-link");
      fs.symlinkSync(outside.backlog, linkDir, process.platform === "win32" ? "junction" : "dir");
      const linkRes = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: linkDir },
      });
      expect(linkRes.isError).toBe(true);
      expect(linkRes.content[0].text).toContain("outside configured root");
    } finally {
      fs.rmSync(outside.root, { recursive: true, force: true });
    }
  });

  test("captures canonical pinned root at startup even if original symlink/junction is retargeted", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-pin-retarget-"));
    const dirA = path.join(base, "dirA");
    const dirB = path.join(base, "dirB");
    const linkRoot = path.join(base, "linkRoot");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "001-alpha.md"), "# EPIC-001 — Alpha\n\n**Status:** [ ] TODO\n", "utf8");
    fs.writeFileSync(path.join(dirB, "002-beta.md"), "# EPIC-002 — Beta\n\n**Status:** [ ] TODO\n", "utf8");

    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(dirA, linkRoot, linkType);

    const pinnedServer = createKanbanMcpServer({ defaultBacklogDir: linkRoot });
    const pinnedClient = new Client({ name: "pinned-retarget-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([pinnedServer.connect(serverTransport), pinnedClient.connect(clientTransport)]);

    try {
      // Retarget linkRoot -> dirB after server startup
      fs.rmSync(linkRoot, { recursive: true, force: true });
      fs.symlinkSync(dirB, linkRoot, linkType);

      const listRes = await pinnedClient.callTool({ name: "kanban_list_epics", arguments: {} });
      expect(listRes.isError).toBeFalsy();
      expect(parseToolJson(listRes).map((e) => e.id)).toEqual(["EPIC-001"]);

      const dirBRes = await pinnedClient.callTool({
        name: "kanban_list_epics",
        arguments: { backlogDir: dirB },
      });
      expect(dirBRes.isError).toBe(true);
      expect(dirBRes.content[0].text).toContain("outside configured root");

      const retargetedLinkRes = await pinnedClient.callTool({
        name: "kanban_list_epics",
        arguments: { backlogDir: linkRoot },
      });
      expect(retargetedLinkRes.isError).toBe(true);
      expect(retargetedLinkRes.content[0].text).toContain("outside configured root");
    } finally {
      await pinnedClient.close();
      await pinnedServer.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("fails closed if canonical pinnedRoot itself is replaced by a junction/symlink after startup", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-pin-identity-"));
    const dirA = path.join(base, "dirA");
    const dirB = path.join(base, "dirB");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "001-alpha.md"), "# EPIC-001 — Alpha\n\n**Status:** [ ] TODO\n", "utf8");
    fs.writeFileSync(path.join(dirB, "002-beta.md"), "# EPIC-002 — Beta\n\n**Status:** [ ] TODO\n", "utf8");

    const pinnedServer = createKanbanMcpServer({ defaultBacklogDir: dirA });
    const pinnedClient = new Client({ name: "pinned-identity-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([pinnedServer.connect(serverTransport), pinnedClient.connect(clientTransport)]);

    try {
      const initialRes = await pinnedClient.callTool({ name: "kanban_list_epics", arguments: {} });
      expect(initialRes.isError).toBeFalsy();
      expect(parseToolJson(initialRes).map((e) => e.id)).toEqual(["EPIC-001"]);

      // Replace canonical dirA with a junction/symlink pointing to dirB
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.symlinkSync(dirB, dirA, process.platform === "win32" ? "junction" : "dir");

      const defaultRes = await pinnedClient.callTool({ name: "kanban_list_epics", arguments: {} });
      expect(defaultRes.isError).toBe(true);
      expect(defaultRes.content[0].text).toContain("changed identity");

      const explicitRes = await pinnedClient.callTool({
        name: "kanban_list_epics",
        arguments: { backlogDir: dirA },
      });
      expect(explicitRes.isError).toBe(true);
      expect(explicitRes.content[0].text).toContain("changed identity");
    } finally {
      await pinnedClient.close();
      await pinnedServer.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects CR/LF in single-line tool inputs while allowing multiline goal", async () => {
    const badTitle = await client.callTool({
      name: "kanban_create_epic",
      arguments: { title: "Bad\nTitle" },
    });
    expect(badTitle.isError).toBe(true);

    const badProject = await client.callTool({
      name: "kanban_create_epic",
      arguments: { title: "Good", project: "Proj\r\nBad" },
    });
    expect(badProject.isError).toBe(true);

    const badFirstTask = await client.callTool({
      name: "kanban_create_epic",
      arguments: { title: "Good", firstTask: "Task\nBad" },
    });
    expect(badFirstTask.isError).toBe(true);

    const badAddTask = await client.callTool({
      name: "kanban_add_task",
      arguments: { epic: "EPIC-001", title: "Task\nBad" },
    });
    expect(badAddTask.isError).toBe(true);

    const goodMultilineGoal = await client.callTool({
      name: "kanban_create_epic",
      arguments: { title: "Good Epic", goal: "Line 1\nLine 2" },
    });
    expect(goodMultilineGoal.isError).toBeFalsy();
    expect(parseToolJson(goodMultilineGoal).goal).toContain("Line 1\nLine 2");
  });
});

describe("mcp/server unpinned mode", () => {
  test("allows explicit backlogDir when defaultBacklogDir is not set", async () => {
    const tmp = makeTempBacklog();
    const server = createKanbanMcpServer();
    const client = new Client({ name: "unpinned-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const res = await client.callTool({
        name: "kanban_board_summary",
        arguments: { backlogDir: tmp.backlog },
      });
      expect(res.isError).toBeFalsy();
      expect(parseToolJson(res).epics.total).toBe(1);
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(tmp.root, { recursive: true, force: true });
    }
  });
});

describe("mcp/index parseCliArgs", () => {
  test("parses valid --dir forms and empty argv", () => {
    expect(parseCliArgs([])).toEqual({ dir: null });
    expect(parseCliArgs(["--dir", "/tmp/backlog"])).toEqual({ dir: "/tmp/backlog" });
    expect(parseCliArgs(["--dir=/tmp/backlog"])).toEqual({ dir: "/tmp/backlog" });
  });

  test("rejects missing --dir value and unknown flags", () => {
    expect(() => parseCliArgs(["--dir"])).toThrow(/Missing value for --dir/);
    expect(() => parseCliArgs(["--dir", "--other"])).toThrow(/Missing value for --dir/);
    expect(() => parseCliArgs(["--dir="])).toThrow(/Missing value for --dir/);
    expect(() => parseCliArgs(["--dir", "   "])).toThrow(/Missing value for --dir/);
    expect(() => parseCliArgs(["--unknown"])).toThrow(/Unknown flag/);
    expect(() => parseCliArgs(["-x"])).toThrow(/Unknown flag/);
  });
});

describe("mcp/index stdio entrypoint", () => {
  test("connects over stdio and serves board summary", async () => {
    const tmp = makeTempBacklog();
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", path.resolve("mcp/index.js"), "--dir", tmp.backlog],
      stderr: "pipe",
    });
    const stdioClient = new Client({ name: "stdio-test-client", version: "1.0.0" });

    try {
      await stdioClient.connect(transport);
      const { tools } = await stdioClient.listTools();
      expect(tools.length).toBe(9);

      const summaryRes = await stdioClient.callTool({
        name: "kanban_board_summary",
        arguments: {},
      });
      expect(summaryRes.isError).toBeFalsy();
      expect(parseToolJson(summaryRes).epics.total).toBe(1);
    } finally {
      await stdioClient.close();
      fs.rmSync(tmp.root, { recursive: true, force: true });
    }
  });
});
