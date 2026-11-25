#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliConfig } from "./resolve-backlog.js";
import { createBacklogServer } from "./server.js";

function attachShutdownListeners({ stdin, attachSignals, onShutdown }) {
  stdin.on?.("end", onShutdown);
  stdin.on?.("close", onShutdown);
  if (attachSignals) {
    process.on("SIGINT", onShutdown);
    process.on("SIGTERM", onShutdown);
  }
  return () => {
    stdin.off?.("end", onShutdown);
    stdin.off?.("close", onShutdown);
    if (attachSignals) {
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
    }
  };
}

function waitForShutdown({ server, transport, stdin, attachSignals }) {
  return new Promise((resolve, reject) => {
    let closing = false;
    const prevOnClose = transport.onclose;
    let detachListeners = () => {};

    const cleanup = () => {
      detachListeners();
      if (transport.onclose === onTransportClose) {
        transport.onclose = prevOnClose;
      }
    };

    const onShutdown = async () => {
      if (closing) return;
      closing = true;
      cleanup();
      try {
        await server.close();
        resolve(0);
      } catch (err) {
        reject(err);
      }
    };

    const onTransportClose = () => {
      prevOnClose?.();
      void onShutdown();
    };

    transport.onclose = onTransportClose;
    detachListeners = attachShutdownListeners({ stdin, attachSignals, onShutdown });

    if (stdin.readableEnded || stdin.destroyed) {
      void onShutdown();
    }
  });
}

export async function runCli(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const attachSignals = options.attachSignals ?? true;

  let config;
  try {
    config = parseCliConfig(argv, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`[herdr-kanban-mcp] ${message}\n`);
    return 2;
  }

  const createServerFn = options.createServerFn ?? createBacklogServer;
  const server = createServerFn({
    config,
    cwd,
    homeDir,
    gitTopLevelFn: options.gitTopLevelFn,
    setup: options.setup,
  });

  const transport = new StdioServerTransport(stdin, stdout);
  try {
    await server.connect(transport);
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }

  return waitForShutdown({ server, transport, stdin, attachSignals });
}

if (import.meta.main) {
  runCli()
    .then((code) => {
      if (typeof code === "number" && code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[herdr-kanban-mcp] Fatal error: ${message}\n`);
      process.exitCode = 1;
    });
}
