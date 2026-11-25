import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { normPath, joinPath, parentDir, expandTilde } from "../../mods/kanban/paths.js";
import { isEpicFilename, isNumberedEpicFilename } from "../../mods/kanban/parser.js";
import { BacklogError, mapFsError } from "./errors.js";

export class CliConfigError extends BacklogError {
  constructor(message, details = {}) {
    super("INVALID_ARGUMENT", message, details);
    this.name = "CliConfigError";
  }
}

function validateRawDirValue(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliConfigError(`${label} must not be empty`, { field: "backlogDir" });
  }
  if (value.includes("\0")) {
    throw new CliConfigError(`${label} must not contain NUL bytes`, { field: "backlogDir" });
  }
  return value.trim();
}

function parseBacklogFlagValue(argv, index) {
  const arg = argv[index];
  if (arg === "--backlog-dir") {
    if (index + 1 >= argv.length) {
      throw new CliConfigError("Missing value for --backlog-dir", { field: "backlogDir" });
    }
    const next = argv[index + 1];
    if (next === "--backlog-dir" || next.startsWith("--backlog-dir=")) {
      throw new CliConfigError("Missing value for --backlog-dir", { field: "backlogDir" });
    }
    return { value: validateRawDirValue(next, "--backlog-dir"), nextIndex: index + 1 };
  }
  const raw = arg.slice("--backlog-dir=".length);
  return { value: validateRawDirValue(raw, "--backlog-dir"), nextIndex: index };
}

export function parseCliConfig(argv = process.argv.slice(2), env = process.env) {
  if (!Array.isArray(argv)) {
    throw new CliConfigError("CLI arguments must be an array");
  }
  let cliDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") {
      throw new CliConfigError("CLI argument must be a string");
    }
    if (arg === "--backlog-dir" || arg.startsWith("--backlog-dir=")) {
      if (cliDir !== null) {
        throw new CliConfigError("Duplicate --backlog-dir flag", { field: "backlogDir" });
      }
      const parsed = parseBacklogFlagValue(argv, i);
      cliDir = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliConfigError(`Unknown CLI flag: ${arg}`);
    }
    throw new CliConfigError(`Unexpected positional argument: ${arg}`);
  }
  if (cliDir !== null) {
    return Object.freeze({ mode: "explicit", source: "cli", rawDir: cliDir });
  }
  if (env && Object.hasOwn(env, "HERDR_BACKLOG_DIR") && env.HERDR_BACKLOG_DIR !== undefined) {
    const envDir = validateRawDirValue(env.HERDR_BACKLOG_DIR, "HERDR_BACKLOG_DIR");
    return Object.freeze({ mode: "explicit", source: "env", rawDir: envDir });
  }
  return Object.freeze({ mode: "auto", source: "auto", rawDir: null });
}

function canonicalKey(p) {
  const normalized = normPath(p);
  if (!normalized) return "";
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function defaultGitTopLevel(cwd) {
  if (!cwd || typeof cwd !== "string") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { shell: false, windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || typeof stdout !== "string") {
          resolve(null);
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed ? normPath(trimmed) : null);
      },
    );
  });
}

async function safeGitTopLevel(gitTopLevelFn, dir) {
  if (typeof gitTopLevelFn !== "function") return null;
  try {
    const top = await gitTopLevelFn(dir);
    return typeof top === "string" && top.trim() ? normPath(top.trim()) : null;
  } catch {
    return null;
  }
}

function expandAndResolvePath(rawPath, baseCwd, homeDir, field = "backlogDir") {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\0")) {
    throw new BacklogError("INVALID_ARGUMENT", `${field} path must be a non-empty string`, {
      field,
    });
  }
  const normalized = normPath(rawPath);
  if (normalized === "~" || normalized.startsWith("~/")) {
    if (typeof homeDir !== "string" || homeDir.trim().length === 0) {
      throw new BacklogError("BACKLOG_NOT_FOUND", "Cannot expand '~' without home directory");
    }
    const expanded = expandTilde(normalized, homeDir);
    return path.resolve(baseCwd, expanded);
  }
  return path.resolve(baseCwd, rawPath.trim());
}

async function verifyDirectoryExists(dirPath) {
  let stats;
  try {
    stats = await fs.stat(dirPath);
  } catch (err) {
    throw mapFsError(err);
  }
  if (!stats.isDirectory()) {
    throw new BacklogError("NOT_DIRECTORY", "Backlog path is not a directory");
  }
  try {
    return await fs.realpath(dirPath);
  } catch (err) {
    throw mapFsError(err);
  }
}

async function verifyReadableDirectory(dirPath) {
  const canonical = await verifyDirectoryExists(dirPath);
  try {
    const dir = await fs.opendir(canonical);
    await dir.close();
  } catch (err) {
    throw mapFsError(err);
  }
  return canonical;
}

async function isSafeRegularChildFile(canonicalRoot, name) {
  const fullPath = path.join(canonicalRoot, name);
  let st;
  try {
    st = await fs.lstat(fullPath);
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw mapFsError(err, "IO_ERROR", { filename: name });
  }
  if (st.isSymbolicLink() || !st.isFile()) return false;
  try {
    const realFile = await fs.realpath(fullPath);
    return canonicalKey(path.dirname(realFile)) === canonicalKey(canonicalRoot);
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw mapFsError(err, "IO_ERROR", { filename: name });
  }
}

async function readDirectRegularMdFiles(canonicalRoot) {
  let entries;
  try {
    entries = await fs.readdir(canonicalRoot, { withFileTypes: true });
  } catch (err) {
    throw mapFsError(err);
  }
  const files = [];
  for (const dirent of entries) {
    if (dirent.isSymbolicLink() || !dirent.isFile()) continue;
    if (!dirent.name.toLowerCase().endsWith(".md")) continue;
    if (await isSafeRegularChildFile(canonicalRoot, dirent.name)) {
      files.push(dirent.name);
    }
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function safeRealpathOrNull(dirPath) {
  try {
    return await fs.realpath(dirPath);
  } catch {
    return null;
  }
}

async function buildAutoCandidates(startCwd, gitTopLevelFn) {
  const normCwd = normPath(startCwd);
  const candidates = [
    { dir: path.resolve(joinPath(normCwd, "backlog")), projectRoot: startCwd, strict: false },
    { dir: path.resolve(joinPath(normCwd, "docs/backlog")), projectRoot: startCwd, strict: false },
    { dir: path.resolve(joinPath(normCwd, ".backlog")), projectRoot: startCwd, strict: false },
  ];
  const rawTop = await safeGitTopLevel(gitTopLevelFn, startCwd);
  const resolvedTop = rawTop ? path.resolve(rawTop) : null;
  const realCwd = await safeRealpathOrNull(startCwd);
  const realTop = resolvedTop ? await safeRealpathOrNull(resolvedTop) : null;
  const sameRoot =
    resolvedTop &&
    (canonicalKey(resolvedTop) === canonicalKey(startCwd) ||
      (realCwd && realTop && canonicalKey(realTop) === canonicalKey(realCwd)));
  if (resolvedTop && !sameRoot) {
    const normTop = normPath(resolvedTop);
    candidates.push(
      { dir: path.resolve(joinPath(normTop, "backlog")), projectRoot: resolvedTop, strict: false },
      { dir: path.resolve(joinPath(normTop, "docs/backlog")), projectRoot: resolvedTop, strict: false },
      { dir: path.resolve(joinPath(normTop, ".backlog")), projectRoot: resolvedTop, strict: false },
    );
  }
  const fallbackRoot = resolvedTop || path.resolve(parentDir(normCwd));
  candidates.push({ dir: startCwd, projectRoot: fallbackRoot, strict: true });
  return candidates;
}

async function probeAutoCandidate(candidate, seenResolved, seenCanonical) {
  const resolved = path.resolve(candidate.dir);
  const resKey = canonicalKey(resolved);
  if (!resKey || seenResolved.has(resKey)) return null;
  seenResolved.add(resKey);

  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw mapFsError(err);
  }
  if (!stats.isDirectory()) return null;

  let canonical;
  try {
    canonical = await fs.realpath(resolved);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw mapFsError(err);
  }
  const canKey = canonicalKey(canonical);
  if (seenCanonical.has(canKey)) return null;
  seenCanonical.add(canKey);

  const mdFiles = await readDirectRegularMdFiles(canonical);
  const isNamedBacklog = normPath(resolved).toLowerCase().endsWith("/backlog");
  const accepted = candidate.strict
    ? mdFiles.some(isNumberedEpicFilename)
    : mdFiles.some(isEpicFilename) || (isNamedBacklog && mdFiles.length > 0);
  if (!accepted) return null;

  return { backlogDir: canonical, projectRoot: candidate.projectRoot };
}

async function resolveExplicit(config, startCwd, homeDir, gitTopLevelFn) {
  const targetPath = expandAndResolvePath(config.rawDir, startCwd, homeDir);
  const canonical = await verifyReadableDirectory(targetPath);
  const top = await safeGitTopLevel(gitTopLevelFn, canonical);
  const projectRoot = top ? path.resolve(top) : path.resolve(parentDir(normPath(canonical)));
  return Object.freeze({
    backlogDir: canonical,
    projectRoot,
    mode: config.mode,
    source: config.source,
  });
}

async function resolveAuto(config, startCwd, gitTopLevelFn) {
  const candidates = await buildAutoCandidates(startCwd, gitTopLevelFn);
  const seenResolved = new Set();
  const seenCanonical = new Set();
  for (const candidate of candidates) {
    const match = await probeAutoCandidate(candidate, seenResolved, seenCanonical);
    if (match) {
      return Object.freeze({
        backlogDir: match.backlogDir,
        projectRoot: match.projectRoot,
        mode: config.mode,
        source: config.source,
      });
    }
  }
  throw new BacklogError("BACKLOG_NOT_FOUND", "No backlog directory found");
}

export function createBacklogResolver({
  config,
  argv,
  env,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  gitTopLevelFn = defaultGitTopLevel,
} = {}) {
  const resolvedConfig = config ?? parseCliConfig(argv, env);
  const startCwd = expandAndResolvePath(cwd, process.cwd(), homeDir, "cwd");
  let pinned = null;

  return {
    config: resolvedConfig,
    getPinned() {
      return pinned;
    },
    async resolve() {
      if (pinned !== null) {
        const canonical = await verifyReadableDirectory(pinned.backlogDir);
        if (canonicalKey(canonical) !== canonicalKey(pinned.backlogDir)) {
          throw new BacklogError("UNSAFE_PATH", "Pinned backlog directory changed unexpectedly");
        }
        return pinned;
      }
      const result =
        resolvedConfig.mode === "explicit"
          ? await resolveExplicit(resolvedConfig, startCwd, homeDir, gitTopLevelFn)
          : await resolveAuto(resolvedConfig, startCwd, gitTopLevelFn);
      pinned = result;
      return pinned;
    },
  };
}

export async function resolveBacklogDir(options = {}) {
  return createBacklogResolver(options).resolve();
}

export async function listEpicFiles(backlogDir) {
  if (typeof backlogDir !== "string" || backlogDir.trim().length === 0) {
    throw new BacklogError("BACKLOG_NOT_FOUND", "Backlog directory not found");
  }
  const canonicalRoot = await verifyDirectoryExists(backlogDir);
  const mdFiles = await readDirectRegularMdFiles(canonicalRoot);
  return mdFiles.filter(isEpicFilename);
}

function assertSafeEpicFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new BacklogError("UNSAFE_PATH", "Filename must be a non-empty string");
  }
  if (/[\u0000-\u001f\u007f]/.test(filename)) {
    throw new BacklogError("UNSAFE_PATH", "Filename contains control characters", { filename });
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes(":")) {
    throw new BacklogError("UNSAFE_PATH", "Filename must not contain path separators", { filename });
  }
  if (filename === "." || filename === ".." || path.basename(filename) !== filename) {
    throw new BacklogError("UNSAFE_PATH", "Invalid epic filename", { filename });
  }
  if (!isEpicFilename(filename)) {
    throw new BacklogError("UNSAFE_PATH", "Filename is not a valid epic markdown file", { filename });
  }
}

async function verifySafeExistingEpicFile(canonicalRoot, candidatePath, filename, mustExist) {
  let st;
  try {
    st = await fs.lstat(candidatePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (mustExist) {
        throw new BacklogError("EPIC_NOT_FOUND", "Epic file not found", { filename });
      }
      return candidatePath;
    }
    throw mapFsError(err, "IO_ERROR", { filename });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BacklogError("UNSAFE_PATH", "Symbolic links and non-regular files are not allowed", {
      filename,
    });
  }
  let realFile;
  try {
    realFile = await fs.realpath(candidatePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      if (mustExist) {
        throw new BacklogError("EPIC_NOT_FOUND", "Epic file not found", { filename });
      }
      return candidatePath;
    }
    throw mapFsError(err, "IO_ERROR", { filename });
  }
  if (canonicalKey(path.dirname(realFile)) !== canonicalKey(canonicalRoot)) {
    throw new BacklogError("UNSAFE_PATH", "Resolved file escapes backlog directory", { filename });
  }
  return candidatePath;
}

export async function resolveSafeEpicPath(backlogDir, filename, { mustExist = false } = {}) {
  assertSafeEpicFilename(filename);
  if (typeof backlogDir !== "string" || backlogDir.trim().length === 0) {
    throw new BacklogError("BACKLOG_NOT_FOUND", "Backlog directory not found", { filename });
  }
  const canonicalRoot = await verifyDirectoryExists(backlogDir);
  const candidatePath = path.join(canonicalRoot, filename);
  if (
    canonicalKey(path.dirname(candidatePath)) !== canonicalKey(canonicalRoot) ||
    path.relative(canonicalRoot, candidatePath) !== filename
  ) {
    throw new BacklogError("UNSAFE_PATH", "Path escapes backlog directory", { filename });
  }
  return verifySafeExistingEpicFile(canonicalRoot, candidatePath, filename, mustExist);
}
