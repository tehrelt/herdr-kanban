import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema, safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  McpError,
  ErrorCode,
  CallToolRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createBacklogResolver } from "./resolve-backlog.js";
import {
  BacklogError,
  normalizeError,
  toToolErrorResult,
  toJsonRpcErrorInfo,
} from "./errors.js";

export const SERVER_NAME = "herdr-kanban";

function readServerVersion() {
  try {
    const raw = fs.readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export const SERVER_VERSION = readServerVersion();

async function validateToolArgs(tool, rawArgs) {
  if (!tool.inputSchema) {
    return { ok: true, data: undefined };
  }
  try {
    const schema = normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
    const parseResult = await safeParseAsync(schema, rawArgs ?? {});
    if (!parseResult.success) {
      return { ok: false, result: toToolErrorResult(normalizeError(parseResult.error)) };
    }
    return { ok: true, data: parseResult.data };
  } catch (err) {
    return { ok: false, result: toToolErrorResult(err) };
  }
}

async function handleCallTool(mcpServer, request, extra) {
  const toolName = request.params.name;
  const tool = mcpServer._registeredTools?.[toolName];
  if (!tool) {
    throw new McpError(ErrorCode.InvalidParams, `Tool ${toolName} not found`);
  }
  if (!tool.enabled) {
    throw new McpError(ErrorCode.InvalidParams, `Tool ${toolName} disabled`);
  }

  const validated = await validateToolArgs(tool, request.params.arguments);
  if (!validated.ok) {
    return validated.result;
  }

  let result;
  try {
    result = tool.inputSchema
      ? await Promise.resolve(tool.handler(validated.data, extra))
      : await Promise.resolve(tool.handler(extra));
  } catch (err) {
    if (err instanceof McpError && err.code === ErrorCode.UrlElicitationRequired) {
      throw err;
    }
    return toToolErrorResult(err);
  }

  try {
    await mcpServer.validateToolOutput(tool, result, toolName);
  } catch {
    return toToolErrorResult(new BacklogError("INTERNAL_ERROR", "Tool output validation failed"));
  }
  return result;
}

async function handleReadResource(mcpServer, request, extra) {
  try {
    let uri;
    try {
      uri = new URL(request.params.uri);
    } catch {
      throw new BacklogError("INVALID_ID", "Invalid resource URI");
    }
    const uriString = uri.toString();
    const resource = mcpServer._registeredResources?.[uriString];
    if (resource) {
      if (!resource.enabled) {
        throw new BacklogError("INVALID_ID", `Resource ${uriString} disabled`);
      }
      return await Promise.resolve(resource.readCallback(uri, extra));
    }
    for (const template of Object.values(mcpServer._registeredResourceTemplates ?? {})) {
      if (template.enabled === false) {
        continue;
      }
      const variables = template.resourceTemplate.uriTemplate.match(uriString);
      if (variables) {
        return await Promise.resolve(template.readCallback(uri, variables, extra));
      }
    }
    throw new BacklogError("INVALID_ID", `Resource ${uriString} not found`);
  } catch (err) {
    const info = toJsonRpcErrorInfo(err);
    throw new McpError(info.code, info.message, info.data);
  }
}

async function handleGetPrompt(mcpServer, request, extra) {
  try {
    const promptName = request.params.name;
    const prompt = mcpServer._registeredPrompts?.[promptName];
    if (!prompt) {
      throw new BacklogError("INVALID_ARGUMENT", `Prompt ${promptName} not found`);
    }
    if (!prompt.enabled) {
      throw new BacklogError("INVALID_ARGUMENT", `Prompt ${promptName} disabled`);
    }
    if (prompt.argsSchema) {
      const schema = normalizeObjectSchema(prompt.argsSchema) ?? prompt.argsSchema;
      const parseResult = await safeParseAsync(schema, request.params.arguments ?? {});
      if (!parseResult.success) {
        throw normalizeError(parseResult.error);
      }
      return await Promise.resolve(prompt.callback(parseResult.data, extra));
    }
    return await Promise.resolve(prompt.callback(extra));
  } catch (err) {
    const info = toJsonRpcErrorInfo(err);
    throw new McpError(info.code, info.message, info.data);
  }
}

function installProtocolHandlers(mcpServer) {
  mcpServer.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    handleCallTool(mcpServer, request, extra),
  );
  mcpServer.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
    handleReadResource(mcpServer, request, extra),
  );
  mcpServer.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
    handleGetPrompt(mcpServer, request, extra),
  );
}

export function createBacklogServer(options = {}) {
  const resolver =
    options.resolver ??
    createBacklogResolver({
      config: options.config,
      argv: options.argv,
      env: options.env,
      cwd: options.cwd,
      homeDir: options.homeDir,
      gitTopLevelFn: options.gitTopLevelFn,
    });

  const mcpServer = new McpServer(
    {
      name: options.name ?? SERVER_NAME,
      version: options.version ?? SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  installProtocolHandlers(mcpServer);

  const registerTool = (...args) => mcpServer.registerTool(...args);
  const registerResource = (...args) => mcpServer.registerResource(...args);
  const registerPrompt = (...args) => mcpServer.registerPrompt(...args);

  if (typeof options.setup === "function") {
    options.setup({
      mcpServer,
      resolver,
      registerTool,
      registerResource,
      registerPrompt,
    });
  }

  return {
    mcpServer,
    server: mcpServer.server,
    resolver,
    connect: (transport) => mcpServer.connect(transport),
    close: () => mcpServer.close(),
    registerTool,
    registerResource,
    registerPrompt,
  };
}
