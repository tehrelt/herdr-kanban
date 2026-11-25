import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import * as zMini from "zod/v4-mini";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ALLOWED_DETAIL_KEYS,
  ERROR_CATALOG,
  BacklogError,
  sanitizeErrorDetails,
  normalizeError,
  toErrorPayload,
  toToolErrorResult,
  toJsonRpcErrorInfo,
  mapFsError,
} from "../mcp/backlog-server/errors.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createBacklogServer,
} from "../mcp/backlog-server/server.js";
import { runCli } from "../mcp/backlog-server/cli.js";

const tempDirs = [];

async function makeTempDir(prefix = "herdr-mcp-stdio-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createPassThroughClientTransport(clientToServer, serverToClient) {
  const readBuffer = new ReadBuffer();
  const transport = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    async start() {
      serverToClient.on("data", (chunk) => {
        readBuffer.append(chunk);
        while (true) {
          try {
            const msg = readBuffer.readMessage();
            if (msg === null) break;
            transport.onmessage?.(msg);
          } catch (err) {
            transport.onerror?.(err);
            break;
          }
        }
      });
      serverToClient.on("error", (err) => transport.onerror?.(err));
      clientToServer.on("error", (err) => transport.onerror?.(err));
    },
    async send(message) {
      clientToServer.write(serializeMessage(message));
    },
    async close() {
      clientToServer.end();
      readBuffer.clear();
      transport.onclose?.();
    },
  };
  return transport;
}

function collectStreamText(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("errors.js", () => {
  test("ERROR_CATALOG defines all 16 error codes with expected retryable and jsonRpcCode metadata", () => {
    const expectedCodes = [
      "INVALID_ARGUMENT",
      "INVALID_ID",
      "BACKLOG_NOT_FOUND",
      "NOT_DIRECTORY",
      "PERMISSION_DENIED",
      "UNSAFE_PATH",
      "EPIC_NOT_FOUND",
      "TASK_NOT_FOUND",
      "AMBIGUOUS_ID",
      "UNSUPPORTED_FORMAT",
      "UNSUPPORTED_FILESYSTEM",
      "WRITE_CONFLICT",
      "BACKLOG_BUSY",
      "NUMBER_EXHAUSTED",
      "IO_ERROR",
      "INTERNAL_ERROR",
    ];
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...expectedCodes].sort());
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(16);

    const retryableCodes = expectedCodes.filter((c) => ERROR_CATALOG[c].retryable);
    expect(retryableCodes.sort()).toEqual(["BACKLOG_BUSY", "IO_ERROR", "WRITE_CONFLICT"]);

    expect(ERROR_CATALOG.INVALID_ARGUMENT.jsonRpcCode).toBe(-32602);
    expect(ERROR_CATALOG.INVALID_ID.jsonRpcCode).toBe(-32602);
    expect(ERROR_CATALOG.BACKLOG_NOT_FOUND.jsonRpcCode).toBe(-32002);
    expect(ERROR_CATALOG.EPIC_NOT_FOUND.jsonRpcCode).toBe(-32002);
    expect(ERROR_CATALOG.TASK_NOT_FOUND.jsonRpcCode).toBe(-32002);
    expect(ERROR_CATALOG.INTERNAL_ERROR.jsonRpcCode).toBe(-32603);
    expect(ERROR_CATALOG.WRITE_CONFLICT.jsonRpcCode).toBe(-32000);
  });

  test("sanitizeErrorDetails keeps only allowed non-empty string keys and strips paths/stack/unknown keys", () => {
    expect(ALLOWED_DETAIL_KEYS).toEqual([
      "epicId",
      "taskId",
      "field",
      "expectedRevision",
      "currentRevision",
      "filename",
    ]);

    expect(sanitizeErrorDetails(null)).toEqual({});
    expect(sanitizeErrorDetails("bad")).toEqual({});

    const clean = sanitizeErrorDetails({
      epicId: "EPIC-001",
      taskId: "TASK-001.1",
      field: "status",
      expectedRevision: "a".repeat(64),
      currentRevision: "b".repeat(64),
      filename: "001-init.md",
      path: "/secret/abs/path",
      filePath: "C:\\Users\\secret\\001.md",
      backlogDir: "/secret/backlog",
      stack: "Error: stack",
      extra: "ignored",
      empty: "",
      nonString: 42,
    });

    expect(clean).toEqual({
      epicId: "EPIC-001",
      taskId: "TASK-001.1",
      field: "status",
      expectedRevision: "a".repeat(64),
      currentRevision: "b".repeat(64),
      filename: "001-init.md",
    });
    expect(Object.isFrozen(clean)).toBe(true);
  });

  test("normalizeError handles BacklogError, ZodError, $ZodError, and masks unexpected errors", () => {
    const existing = new BacklogError("WRITE_CONFLICT", "Conflict", {
      epicId: "EPIC-002",
      path: "/secret",
    });
    expect(normalizeError(existing)).toBe(existing);
    expect(existing.details).toEqual({ epicId: "EPIC-002" });

    const zodEpicRes = z.object({ epicId: z.string().regex(/^EPIC-\d+$/) }).safeParse({ epicId: "bad" });
    expect(zodEpicRes.success).toBe(false);
    expect(zodEpicRes.error.name).toBe("ZodError");
    const normZodEpic = normalizeError(zodEpicRes.error);
    expect(normZodEpic.code).toBe("INVALID_ID");
    expect(normZodEpic.details).toEqual({ field: "epicId" });

    const zodNestedTaskRes = z
      .object({ nested: z.object({ taskId: z.string().min(5) }) })
      .safeParse({ nested: { taskId: "x" } });
    expect(zodNestedTaskRes.success).toBe(false);
    const normNestedTask = normalizeError(zodNestedTaskRes.error);
    expect(normNestedTask.code).toBe("INVALID_ID");
    expect(normNestedTask.details).toEqual({ field: "nested.taskId" });

    const zodOtherRes = z.object({ title: z.string().min(3) }).safeParse({ title: "" });
    expect(zodOtherRes.success).toBe(false);
    const normOther = normalizeError(zodOtherRes.error);
    expect(normOther.code).toBe("INVALID_ARGUMENT");
    expect(normOther.details).toEqual({ field: "title" });

    const miniTaskRes = zMini.object({ taskId: zMini.string() }).safeParse({ taskId: 123 });
    expect(miniTaskRes.success).toBe(false);
    expect(miniTaskRes.error.name).toBe("$ZodError");
    const normMiniTask = normalizeError(miniTaskRes.error);
    expect(normMiniTask.code).toBe("INVALID_ID");
    expect(normMiniTask.details).toEqual({ field: "taskId" });

    const miniOtherRes = zMini.object({ count: zMini.number() }).safeParse({ count: "nope" });
    expect(miniOtherRes.success).toBe(false);
    const normMiniOther = normalizeError(miniOtherRes.error);
    expect(normMiniOther.code).toBe("INVALID_ARGUMENT");
    expect(normMiniOther.details).toEqual({ field: "count" });

    const masked = normalizeError(new Error("Sensitive /home/user/secret failure"));
    expect(masked.code).toBe("INTERNAL_ERROR");
    expect(masked.message).toBe("Internal server error");
    expect(masked.retryable).toBe(false);
    expect(masked.details).toEqual({});

    const plainDomain = normalizeError({
      code: "AMBIGUOUS_ID",
      message: "Duplicate epic",
      details: { epicId: "EPIC-001", path: "/secret" },
    });
    expect(plainDomain).toBeInstanceOf(BacklogError);
    expect(plainDomain.code).toBe("AMBIGUOUS_ID");
    expect(plainDomain.details).toEqual({ epicId: "EPIC-001" });
  });

  test("toToolErrorResult omits structuredContent and toJsonRpcErrorInfo maps JSON-RPC codes", () => {
    const err = new BacklogError("EPIC_NOT_FOUND", "Missing epic", {
      epicId: "EPIC-404",
      path: "/hidden",
    });
    const toolRes = toToolErrorResult(err);
    expect(toolRes.isError).toBe(true);
    expect("structuredContent" in toolRes).toBe(false);
    expect(toolRes.content).toHaveLength(1);
    expect(JSON.parse(toolRes.content[0].text)).toEqual(toErrorPayload(err));
    expect(JSON.parse(toolRes.content[0].text)).toEqual({
      ok: false,
      error: {
        code: "EPIC_NOT_FOUND",
        message: "Missing epic",
        retryable: false,
        details: { epicId: "EPIC-404" },
      },
    });

    expect(toJsonRpcErrorInfo(new BacklogError("INVALID_ARGUMENT", "Bad arg"))).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT", retryable: false },
    });
    expect(toJsonRpcErrorInfo(new BacklogError("INVALID_ID", "Bad id"))).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ID", retryable: false },
    });
    expect(toJsonRpcErrorInfo(new BacklogError("EPIC_NOT_FOUND", "No epic"))).toMatchObject({
      code: -32002,
      data: { code: "EPIC_NOT_FOUND", retryable: false },
    });
    expect(toJsonRpcErrorInfo(new BacklogError("WRITE_CONFLICT", "Conflict"))).toMatchObject({
      code: -32000,
      data: { code: "WRITE_CONFLICT", retryable: true },
    });
    expect(toJsonRpcErrorInfo(new Error("boom"))).toMatchObject({
      code: -32603,
      message: "Internal server error",
      data: { code: "INTERNAL_ERROR", retryable: false, details: {} },
    });
  });

  test("mapFsError maps POSIX/Windows filesystem error codes accurately", () => {
    const makeErr = (code) => Object.assign(new Error(code), { code });

    expect(mapFsError(makeErr("EACCES")).code).toBe("PERMISSION_DENIED");
    expect(mapFsError(makeErr("EPERM")).code).toBe("PERMISSION_DENIED");
    expect(mapFsError(makeErr("ENOENT")).code).toBe("BACKLOG_NOT_FOUND");
    expect(mapFsError(makeErr("ENOENT"), "EPIC_NOT_FOUND", { filename: "001.md" }).code).toBe(
      "EPIC_NOT_FOUND",
    );
    expect(mapFsError(makeErr("ENOTDIR")).code).toBe("NOT_DIRECTORY");
    expect(mapFsError(makeErr("ELOOP")).code).toBe("UNSAFE_PATH");
    expect(mapFsError(makeErr("EISDIR")).code).toBe("UNSAFE_PATH");
    expect(mapFsError(makeErr("EEXIST")).code).toBe("WRITE_CONFLICT");
    expect(mapFsError(makeErr("ENAMETOOLONG")).code).toBe("INVALID_ARGUMENT");
    expect(mapFsError(makeErr("ENOTSUP")).code).toBe("UNSUPPORTED_FILESYSTEM");
    expect(mapFsError(makeErr("EOPNOTSUPP")).code).toBe("UNSUPPORTED_FILESYSTEM");
    expect(mapFsError(makeErr("ENOSYS")).code).toBe("UNSUPPORTED_FILESYSTEM");
    expect(mapFsError(makeErr("EXDEV")).code).toBe("UNSUPPORTED_FILESYSTEM");
    expect(mapFsError(makeErr("EIO")).code).toBe("IO_ERROR");
    expect(mapFsError(makeErr("ENOENT"), "IO_ERROR", {}, { ENOENT: "WRITE_CONFLICT" }).code).toBe(
      "WRITE_CONFLICT",
    );
  });
});

describe("server.js via InMemoryTransport + Client", () => {
  test("empty server advertises capabilities, lists empty primitives, and rejects unknown calls with JSON-RPC errors", async () => {
    const server = createBacklogServer({
      argv: [],
      env: {},
      gitTopLevelFn: async () => null,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerVersion()).toEqual({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });
      const caps = client.getServerCapabilities();
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();

      expect(await client.listTools()).toEqual({ tools: [] });
      expect(await client.listResources()).toEqual({ resources: [] });
      expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] });
      expect(await client.listPrompts()).toEqual({ prompts: [] });

      await expect(client.callTool({ name: "unknown_tool", arguments: {} })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
      });

      await expect(client.readResource({ uri: "backlog://unknown" })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: {
          code: "INVALID_ID",
          retryable: false,
        },
      });

      await expect(client.readResource({ uri: "not a valid uri" })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: {
          code: "INVALID_ID",
          retryable: false,
        },
      });

      await expect(client.getPrompt({ name: "unknown_prompt", arguments: {} })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: {
          code: "INVALID_ARGUMENT",
          retryable: false,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("handles registered tools, resources, templates, prompts, validation, and error mapping", async () => {
    const server = createBacklogServer({
      argv: [],
      env: {},
      gitTopLevelFn: async () => null,
      setup({ registerTool, registerResource, registerPrompt }) {
        registerTool(
          "demo_tool",
          {
            description: "Demo tool",
            inputSchema: z
              .object({
                epicId: z.string().regex(/^EPIC-\d+$/),
                mode: z.enum(["ok", "conflict", "crash", "bad_output"]).default("ok"),
              })
              .strict(),
            outputSchema: z.object({
              ok: z.literal(true),
              data: z.object({ epicId: z.string() }),
            }),
          },
          async ({ epicId, mode }) => {
            if (mode === "conflict") {
              throw new BacklogError("WRITE_CONFLICT", "Revision mismatch", {
                epicId,
                expectedRevision: "a".repeat(64),
                currentRevision: "b".repeat(64),
                path: "/secret/path",
              });
            }
            if (mode === "crash") {
              throw new Error("Secret internal crash /abs/path");
            }
            if (mode === "bad_output") {
              const bad = { ok: true, data: { wrongField: 123 } };
              return {
                isError: false,
                structuredContent: bad,
                content: [{ type: "text", text: JSON.stringify(bad) }],
              };
            }
            const payload = { ok: true, data: { epicId } };
            return {
              isError: false,
              structuredContent: payload,
              content: [{ type: "text", text: JSON.stringify(payload) }],
            };
          },
        );

        registerResource(
          "guide",
          "backlog://guide",
          { mimeType: "text/markdown" },
          async (uri) => ({
            contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: "# Guide" }],
          }),
        );

        registerResource(
          "epic",
          new ResourceTemplate("backlog://epic/{id}", { list: undefined }),
          { mimeType: "text/markdown" },
          async (uri, variables) => {
            if (variables.id === "EPIC-999") {
              throw new BacklogError("EPIC_NOT_FOUND", "Epic not found", { epicId: "EPIC-999" });
            }
            return {
              contents: [
                {
                  uri: uri.toString(),
                  mimeType: "text/markdown",
                  text: `# ${variables.id}`,
                },
              ],
            };
          },
        );

        registerPrompt(
          "demo_prompt",
          {
            description: "Demo prompt",
            argsSchema: {
              topic: z.string().min(2),
              missingBacklog: z.string().optional(),
            },
          },
          async ({ topic, missingBacklog }) => {
            if (missingBacklog === "yes") {
              throw new BacklogError("BACKLOG_NOT_FOUND", "No backlog directory");
            }
            return {
              description: "Demo prompt",
              messages: [{ role: "user", content: { type: "text", text: `Topic: ${topic}` } }],
            };
          },
        );
      },
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const okRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "EPIC-001", mode: "ok" },
      });
      expect(okRes.isError).toBe(false);
      expect(okRes.structuredContent).toEqual({ ok: true, data: { epicId: "EPIC-001" } });
      expect(JSON.parse(okRes.content[0].text)).toEqual(okRes.structuredContent);

      const badIdRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "bad-id" },
      });
      expect(badIdRes.isError).toBe(true);
      expect(badIdRes.structuredContent).toBeUndefined();
      expect(JSON.parse(badIdRes.content[0].text)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_ID",
          retryable: false,
          details: { field: "epicId" },
        },
      });

      const strictRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "EPIC-001", extraKey: "nope" },
      });
      expect(strictRes.isError).toBe(true);
      expect(strictRes.structuredContent).toBeUndefined();
      expect(JSON.parse(strictRes.content[0].text)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          retryable: false,
        },
      });

      const conflictRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "EPIC-001", mode: "conflict" },
      });
      expect(conflictRes.isError).toBe(true);
      expect(conflictRes.structuredContent).toBeUndefined();
      expect(JSON.parse(conflictRes.content[0].text)).toEqual({
        ok: false,
        error: {
          code: "WRITE_CONFLICT",
          message: "Revision mismatch",
          retryable: true,
          details: {
            epicId: "EPIC-001",
            expectedRevision: "a".repeat(64),
            currentRevision: "b".repeat(64),
          },
        },
      });

      const crashRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "EPIC-001", mode: "crash" },
      });
      expect(crashRes.isError).toBe(true);
      expect(crashRes.structuredContent).toBeUndefined();
      expect(JSON.parse(crashRes.content[0].text)).toEqual({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          retryable: false,
          details: {},
        },
      });

      const badOutRes = await client.callTool({
        name: "demo_tool",
        arguments: { epicId: "EPIC-001", mode: "bad_output" },
      });
      expect(badOutRes.isError).toBe(true);
      expect(badOutRes.structuredContent).toBeUndefined();
      expect(JSON.parse(badOutRes.content[0].text)).toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          retryable: false,
        },
      });

      const staticRead = await client.readResource({ uri: "backlog://guide" });
      expect(staticRead.contents).toEqual([
        { uri: "backlog://guide", mimeType: "text/markdown", text: "# Guide" },
      ]);

      const tplRead = await client.readResource({ uri: "backlog://epic/EPIC-007" });
      expect(tplRead.contents).toEqual([
        { uri: "backlog://epic/EPIC-007", mimeType: "text/markdown", text: "# EPIC-007" },
      ]);

      await expect(client.readResource({ uri: "backlog://epic/EPIC-999" })).rejects.toMatchObject({
        name: "McpError",
        code: -32002,
        data: {
          code: "EPIC_NOT_FOUND",
          message: "Epic not found",
          retryable: false,
          details: { epicId: "EPIC-999" },
        },
      });

      const promptOk = await client.getPrompt({
        name: "demo_prompt",
        arguments: { topic: "testing" },
      });
      expect(promptOk).toEqual({
        description: "Demo prompt",
        messages: [{ role: "user", content: { type: "text", text: "Topic: testing" } }],
      });

      await expect(
        client.getPrompt({ name: "demo_prompt", arguments: { topic: "x" } }),
      ).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: {
          code: "INVALID_ARGUMENT",
          retryable: false,
          details: { field: "topic" },
        },
      });

      await expect(
        client.getPrompt({
          name: "demo_prompt",
          arguments: { topic: "testing", missingBacklog: "yes" },
        }),
      ).rejects.toMatchObject({
        name: "McpError",
        code: -32002,
        data: {
          code: "BACKLOG_NOT_FOUND",
          message: "No backlog directory",
          retryable: false,
          details: {},
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("supports tools without inputSchema and rejects disabled tools, resources, templates, and prompts", async () => {
    let disabledTool;
    let disabledResource;
    let disabledTemplate;
    let disabledPrompt;

    const server = createBacklogServer({
      argv: [],
      env: {},
      gitTopLevelFn: async () => null,
      setup({ registerTool, registerResource, registerPrompt }) {
        registerTool("ping", { description: "Ping without schema" }, async () => ({
          isError: false,
          content: [{ type: "text", text: "pong" }],
        }));
        disabledTool = registerTool("off_tool", { description: "Disabled" }, async () => ({
          content: [{ type: "text", text: "never" }],
        }));
        disabledTool.disable();

        disabledResource = registerResource(
          "off_res",
          "backlog://off",
          { mimeType: "text/plain" },
          async () => ({ contents: [] }),
        );
        disabledResource.disable();

        disabledTemplate = registerResource(
          "off_tpl",
          new ResourceTemplate("backlog://off/{id}", { list: undefined }),
          { mimeType: "text/plain" },
          async () => ({ contents: [] }),
        );
        disabledTemplate.disable();

        disabledPrompt = registerPrompt("off_prompt", { description: "Disabled" }, async () => ({
          messages: [],
        }));
        disabledPrompt.disable();
      },
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const pingRes = await client.callTool({ name: "ping", arguments: {} });
      expect(pingRes.content).toEqual([{ type: "text", text: "pong" }]);

      await expect(client.callTool({ name: "off_tool", arguments: {} })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
      });
      await expect(client.readResource({ uri: "backlog://off" })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: { code: "INVALID_ID" },
      });
      await expect(client.readResource({ uri: "backlog://off/123" })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: { code: "INVALID_ID" },
      });
      await expect(client.getPrompt({ name: "off_prompt", arguments: {} })).rejects.toMatchObject({
        name: "McpError",
        code: -32602,
        data: { code: "INVALID_ARGUMENT" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("cli.js", () => {
  test("runCli returns exit code 2, writes to stderr, and writes nothing to stdout on invalid config", async () => {
    const cases = [
      { argv: ["--unknown-flag"], env: {} },
      { argv: ["--backlog-dir", "a", "--backlog-dir", "b"], env: {} },
      { argv: [], env: { HERDR_BACKLOG_DIR: "   " } },
    ];

    for (const c of cases) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStdout = collectStreamText(stdout);
      const getStderr = collectStreamText(stderr);

      const code = await runCli({
        argv: c.argv,
        env: c.env,
        stdin,
        stdout,
        stderr,
        attachSignals: false,
      });

      expect(code).toBe(2);
      expect(getStdout()).toBe("");
      expect(getStderr()).toContain("[herdr-kanban-mcp]");
    }
  });

  test("runCli connects over PassThrough streams even with missing backlog dir and exits 0 on stdin.end()", async () => {
    const root = await makeTempDir();
    const missingDir = path.join(root, "missing-backlog");
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const stderr = new PassThrough();
    const getStderr = collectStreamText(stderr);

    const cliPromise = runCli({
      argv: ["--backlog-dir", missingDir],
      env: {},
      cwd: root,
      stdin: clientToServer,
      stdout: serverToClient,
      stderr,
      attachSignals: false,
      gitTopLevelFn: async () => null,
    });

    const client = new Client({ name: "passthrough-client", version: "1.0.0" });
    const transport = createPassThroughClientTransport(clientToServer, serverToClient);
    await client.connect(transport);

    expect(client.getServerVersion()).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.listResources()).toEqual({ resources: [] });
    expect(await client.listPrompts()).toEqual({ prompts: [] });

    await client.close();
    const exitCode = await cliPromise;
    expect(exitCode).toBe(0);
    expect(getStderr()).toBe("");
  });

  test("real subprocess E2E via StdioClientTransport spawns bun on cli.js and closes cleanly", async () => {
    const tmpDir = await makeTempDir();
    const cliPath = path.resolve(import.meta.dir, "..", "mcp", "backlog-server", "cli.js");
    const transport = new StdioClientTransport({
      command: "bun",
      args: [cliPath, "--backlog-dir", tmpDir],
      stderr: "pipe",
    });
    const stderrChunks = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const client = new Client({ name: "e2e-stdio-client", version: "1.0.0" });
    await client.connect(transport);

    const child = transport._process;
    const exitPromise = child
      ? new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
      : Promise.resolve({ code: 0, signal: null });

    try {
      expect(client.getServerVersion()).toEqual({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });
      const caps = client.getServerCapabilities();
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();

      expect(await client.listTools()).toEqual({ tools: [] });
      expect(await client.listResources()).toEqual({ resources: [] });
      expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] });
      expect(await client.listPrompts()).toEqual({ prompts: [] });
    } finally {
      await client.close();
    }

    const exitInfo = await exitPromise;
    expect(exitInfo).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
  });

  test("runCli handles pre-ended stdin, signal listener cleanup, connect failure, and subprocess exit code 2", async () => {
    const root = await makeTempDir();
    const endedStdin = new PassThrough();
    endedStdin.end();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const beforeSigint = process.listenerCount("SIGINT");

    const code = await runCli({
      argv: ["--backlog-dir", root],
      env: {},
      cwd: root,
      stdin: endedStdin,
      stdout,
      stderr,
      attachSignals: true,
      gitTopLevelFn: async () => null,
    });
    expect(code).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);

    let closedOnConnectError = false;
    await expect(
      runCli({
        argv: ["--backlog-dir", root],
        env: {},
        cwd: root,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        attachSignals: false,
        createServerFn: () => ({
          async connect() {
            throw new Error("connect failed");
          },
          async close() {
            closedOnConnectError = true;
          },
        }),
      }),
    ).rejects.toThrow("connect failed");
    expect(closedOnConnectError).toBe(true);

    const cliPath = path.resolve(import.meta.dir, "..", "mcp", "backlog-server", "cli.js");
    const subResult = await new Promise((resolve, reject) => {
      const child = spawn("bun", [cliPath, "--bad-flag"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (c) => out.push(Buffer.from(c)));
      child.stderr.on("data", (c) => err.push(Buffer.from(c)));
      child.on("error", reject);
      child.on("exit", (exitCode) =>
        resolve({
          exitCode,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
    });
    expect(subResult.exitCode).toBe(2);
    expect(subResult.stdout).toBe("");
    expect(subResult.stderr).toContain("[herdr-kanban-mcp]");
  });
});
