#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKanbanMcpServer } from "./server.js";

export function parseCliArgs(argv = []) {
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-") || !next.trim()) {
        throw new Error("Missing value for --dir");
      }
      dir = next;
      i += 1;
    } else if (arg.startsWith("--dir=")) {
      const val = arg.slice("--dir=".length);
      if (!val.trim()) {
        throw new Error("Missing value for --dir");
      }
      dir = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { dir };
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const { dir } = parseCliArgs(process.argv.slice(2));
  const defaultBacklogDir = dir || process.env.HERDR_KANBAN_DIR || null;
  const server = createKanbanMcpServer({ defaultBacklogDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("herdr-kanban MCP server failed:", err);
    process.exit(1);
  });
}
