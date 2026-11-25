import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  COLUMNS,
  PRIORITIES,
  isEpicFilename,
  isNumberedEpicFilename,
  parseEpicFile,
  updateEpicStatus,
  updateEpicPriority,
  updateTaskStatus,
  addTaskAndSyncEpic,
  createEpicMarkdown,
  slugifyEpicFilename,
  buildAgentPrompt,
} from "../mods/kanban/parser.js";
import { expandTilde } from "../mods/kanban/paths.js";

const VALID_STATUSES = new Set(COLUMNS.map((c) => c.id));
const VALID_PRIORITIES = new Set(PRIORITIES);
const BACKLOG_SUBDIRS = ["backlog", path.join("docs", "backlog"), ".backlog"];
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 15;
const MAX_LOCK_BYTES = 256;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function expandUserPath(rawPath, cwd = process.cwd()) {
  if (!rawPath || typeof rawPath !== "string") return null;
  const expanded = expandTilde(rawPath, os.homedir());
  if (!expanded) return null;
  return path.resolve(cwd, expanded);
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listMdNames(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveExplicitDir(rawDir, cwd) {
  const resolved = expandUserPath(rawDir, cwd);
  if (!resolved || !isDirectory(resolved)) {
    throw new Error(`Backlog directory not found: ${rawDir}`);
  }

  const baseName = path.basename(resolved).toLowerCase();
  if (baseName === "backlog" || baseName === ".backlog") return resolved;

  for (const sub of BACKLOG_SUBDIRS) {
    const candidate = path.join(resolved, sub);
    if (!isDirectory(candidate)) continue;
    const subFiles = listMdNames(candidate) ?? [];
    if (subFiles.some(isEpicFilename) || sub === "backlog" || sub === ".backlog") return candidate;
  }

  const directFiles = listMdNames(resolved) ?? [];
  if (directFiles.some(isEpicFilename)) return resolved;
  return resolved;
}

export function resolveBacklogDir({ backlogDir, cwd } = {}) {
  const baseCwd = expandUserPath(cwd || process.cwd()) || process.cwd();
  const explicit = backlogDir || process.env.HERDR_KANBAN_DIR;
  if (explicit) return resolveExplicitDir(explicit, baseCwd);

  const gitRoot = findGitRoot(baseCwd);
  const roots = gitRoot && gitRoot !== baseCwd ? [baseCwd, gitRoot] : [baseCwd];
  const candidates = [];

  for (const root of roots) {
    for (const sub of BACKLOG_SUBDIRS) {
      candidates.push({ dir: path.join(root, sub), strict: false });
    }
  }
  candidates.push({ dir: baseCwd, strict: true });
  if (gitRoot && gitRoot !== baseCwd) {
    candidates.push({ dir: gitRoot, strict: true });
  }

  for (const candidate of candidates) {
    if (!isDirectory(candidate.dir)) continue;
    const files = listMdNames(candidate.dir) ?? [];
    const hasEpics = candidate.strict ? files.some(isNumberedEpicFilename) : files.some(isEpicFilename);
    const baseName = path.basename(candidate.dir).toLowerCase();
    const isNamedBacklog = baseName === "backlog" || baseName === ".backlog";
    if (hasEpics || isNamedBacklog) return candidate.dir;
  }

  throw new Error(
    `Could not auto-detect backlog directory from "${baseCwd}". Pass backlogDir or set HERDR_KANBAN_DIR.`,
  );
}

function isOutsideRelative(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel);
}

function resolveCanonicalTarget(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    const parentReal = fs.realpathSync(path.dirname(resolved));
    return path.join(parentReal, path.basename(resolved));
  }
}

export function pinBacklogRoot(defaultBacklogDir, { cwd } = {}) {
  if (!defaultBacklogDir) return null;
  const baseCwd = expandUserPath(cwd || process.cwd()) || process.cwd();
  const expanded = expandUserPath(defaultBacklogDir, baseCwd);
  if (!expanded || !isDirectory(expanded)) {
    throw new Error(`Backlog directory not found: ${defaultBacklogDir}`);
  }
  return fs.realpathSync(expanded);
}

function verifyPinnedRootIdentity(pinnedRoot, expectedStat) {
  let lstat;
  try {
    lstat = fs.lstatSync(pinnedRoot);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`Pinned backlog root changed identity: ${pinnedRoot}`);
    }
    throw err;
  }
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    throw new Error(`Pinned backlog root changed identity: ${pinnedRoot}`);
  }
  const resolved = path.resolve(pinnedRoot);
  if (fs.realpathSync(pinnedRoot) !== resolved) {
    throw new Error(`Pinned backlog root changed identity: ${pinnedRoot}`);
  }
  if (expectedStat && expectedStat.ino && (lstat.dev !== expectedStat.dev || lstat.ino !== expectedStat.ino)) {
    throw new Error(`Pinned backlog root changed identity: ${pinnedRoot}`);
  }
  return resolved;
}

export function resolvePinnedBacklogDir(
  pinnedRoot,
  requestedBacklogDir,
  { cwd, expectedStat, strictCanonical = false } = {},
) {
  const baseCwd = expandUserPath(cwd || process.cwd()) || process.cwd();
  if (!pinnedRoot) {
    return resolveBacklogDir({ backlogDir: requestedBacklogDir || undefined, cwd: baseCwd });
  }

  const pinnedReal =
    strictCanonical || expectedStat
      ? verifyPinnedRootIdentity(pinnedRoot, expectedStat)
      : pinBacklogRoot(pinnedRoot, { cwd: baseCwd });

  if (requestedBacklogDir) {
    const reqExpanded = expandUserPath(requestedBacklogDir, baseCwd);
    if (!reqExpanded || !isDirectory(reqExpanded)) {
      throw new Error(`Backlog directory not found: ${requestedBacklogDir}`);
    }
    const reqReal = fs.realpathSync(reqExpanded);
    if (isOutsideRelative(path.relative(pinnedReal, reqReal))) {
      throw new Error(`Backlog directory "${requestedBacklogDir}" is outside configured root "${pinnedReal}"`);
    }
  }

  const resolved = resolveBacklogDir({ backlogDir: requestedBacklogDir || pinnedReal, cwd: baseCwd });
  const resolvedReal = fs.realpathSync(resolved);
  if (isOutsideRelative(path.relative(pinnedReal, resolvedReal))) {
    throw new Error(`Backlog directory resolves outside configured root "${pinnedReal}"`);
  }
  return resolvedReal;
}

function assertInsideDir(dirPath, targetPath) {
  const root = fs.realpathSync(path.resolve(dirPath));
  const target = resolveCanonicalTarget(targetPath);
  const rel = path.relative(root, target);
  if (!rel || isOutsideRelative(rel)) {
    throw new Error(`Path escapes backlog directory: ${targetPath}`);
  }
  return target;
}

function loadEpics(backlogDir) {
  if (!isDirectory(backlogDir)) {
    throw new Error(`Backlog directory not found: ${backlogDir}`);
  }
  const files = fs
    .readdirSync(backlogDir, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isEpicFilename(entry.name))
    .map((entry) => entry.name)
    .sort();

  const epics = [];
  for (const name of files) {
    const fullPath = assertInsideDir(backlogDir, path.join(backlogDir, name));
    if (!fs.statSync(fullPath).isFile()) continue;
    const raw = fs.readFileSync(fullPath, "utf8");
    epics.push(parseEpicFile(name, raw, fullPath));
  }
  return epics.sort((a, b) => a.number - b.number || a.filename.localeCompare(b.filename));
}

function findEpicRecord(epics, query) {
  const raw = String(query ?? "").trim();
  if (!raw) throw new Error("Epic identifier is required");

  const upper = raw.toUpperCase();
  const numMatch = raw.match(/^(?:EPIC-)?(\d+)$/i);
  const normalizedId = numMatch ? `EPIC-${String(Number(numMatch[1])).padStart(3, "0")}` : upper;
  const lower = raw.toLowerCase();

  const match = epics.find(
    (e) =>
      e.id.toUpperCase() === normalizedId ||
      e.filename.toLowerCase() === lower ||
      e.filename.replace(/\.md$/i, "").toLowerCase() === lower ||
      path.resolve(e.filePath) === path.resolve(raw),
  );
  if (!match) throw new Error(`Epic not found: ${raw}`);
  return match;
}

function summarizeEpic(epic) {
  const nextTask = epic.tasks.find((t) => t.status !== "done") ?? null;
  return {
    id: epic.id,
    number: epic.number,
    title: epic.title,
    status: epic.status,
    explicitStatus: epic.explicitStatus,
    priority: epic.priority,
    project: epic.project,
    filename: epic.filename,
    filePath: epic.filePath,
    counts: epic.counts,
    nextTask: nextTask ? { id: nextTask.id, title: nextTask.title, status: nextTask.status } : null,
  };
}

function formatEpicDetail(epic) {
  return {
    id: epic.id,
    number: epic.number,
    title: epic.title,
    status: epic.status,
    explicitStatus: epic.explicitStatus,
    priority: epic.priority,
    project: epic.project,
    filename: epic.filename,
    filePath: epic.filePath,
    goal: epic.goal,
    dod: epic.dod,
    summary: epic.summary,
    other: epic.other,
    counts: epic.counts,
    tasks: epic.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      lineIndex: t.lineIndex,
      subitems: t.subitems,
    })),
  };
}

const require = createRequire(import.meta.url);
let win32Kernel32 = null;

function getWin32Kernel32() {
  if (win32Kernel32) return win32Kernel32;
  const { dlopen, FFIType } = require("bun:ffi");
  win32Kernel32 = dlopen("kernel32.dll", {
    ReplaceFileW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  });
  return win32Kernel32;
}

function replaceFileWindows(targetPath, tmpPath) {
  const { ptr } = require("bun:ffi");
  const k32 = getWin32Kernel32();
  const targetWide = Buffer.from(`${path.resolve(targetPath)}\0`, "utf16le");
  const tmpWide = Buffer.from(`${path.resolve(tmpPath)}\0`, "utf16le");
  const ok = k32.symbols.ReplaceFileW(ptr(targetWide), ptr(tmpWide), null, 0, null, null);
  if (!ok) {
    const errCode = k32.symbols.GetLastError();
    throw new Error(`ReplaceFileW failed for ${targetPath} (Win32 error ${errCode})`);
  }
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function unlinkIgnoreMissing(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function parseLockPid(content) {
  if (typeof content !== "string") return null;
  const match = content.match(/^(\d+):/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function assertRegularLockOrMissing(filePath) {
  let lstat;
  try {
    lstat = fs.lstatSync(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error(`Refusing non-regular lock file: ${filePath}`);
  }
  return lstat;
}

function readLockIfExists(lockPath) {
  const lstat = assertRegularLockOrMissing(lockPath);
  if (!lstat) return null;

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = fs.openSync(lockPath, flags);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    if (err?.code === "ELOOP") {
      throw new Error(`Refusing non-regular lock file: ${lockPath}`);
    }
    throw err;
  }

  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new Error(`Refusing non-regular lock file: ${lockPath}`);
    }
    if (fstat.size > MAX_LOCK_BYTES) {
      throw new Error(`Lock file exceeds maximum size (${MAX_LOCK_BYTES} bytes): ${lockPath}`);
    }
    const buf = Buffer.allocUnsafe(MAX_LOCK_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const bytesRead = fs.readSync(fd, buf, total, buf.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_LOCK_BYTES) {
        throw new Error(`Lock file exceeds maximum size (${MAX_LOCK_BYTES} bytes): ${lockPath}`);
      }
    }
    return { content: buf.subarray(0, total).toString("utf8"), mtimeMs: fstat.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function isLockReclaimable(lockInfo) {
  const pid = parseLockPid(lockInfo.content);
  if (isProcessAlive(pid)) return false;
  if (pid !== null) return true;
  return Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS;
}

function tryAcquireRecoveryLock(recoverPath) {
  assertRegularLockOrMissing(recoverPath);
  const recoverToken = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
  try {
    const fd = fs.openSync(recoverPath, "wx", 0o600);
    let wrote = false;
    try {
      fs.writeFileSync(fd, recoverToken, "utf8");
      wrote = true;
    } finally {
      fs.closeSync(fd);
      if (!wrote) unlinkIgnoreMissing(recoverPath);
    }
    return recoverToken;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

function tryRemoveStaleLock(lockPath) {
  const initial = readLockIfExists(lockPath);
  if (!initial) return true;
  if (!isLockReclaimable(initial)) return false;

  const recoverPath = `${lockPath}.recover`;
  const recoverToken = tryAcquireRecoveryLock(recoverPath);
  if (!recoverToken) return false;

  try {
    const current = readLockIfExists(lockPath);
    if (!current) return true;
    if (current.content !== initial.content || !isLockReclaimable(current)) {
      return false;
    }
    unlinkIgnoreMissing(lockPath);
    return true;
  } finally {
    releaseFileLock(recoverPath, recoverToken);
  }
}

export function acquireFileLock(lockPath, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const token = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
  const deadline = performance.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0 && performance.now() >= deadline) {
      throw new Error(`Timed out waiting for file lock: ${lockPath}`);
    }
    assertRegularLockOrMissing(lockPath);
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      let wrote = false;
      try {
        fs.writeFileSync(fd, token, "utf8");
        wrote = true;
      } finally {
        fs.closeSync(fd);
        if (!wrote) unlinkIgnoreMissing(lockPath);
      }
      return token;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const removed = tryRemoveStaleLock(lockPath);
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      if (removed) continue;
      sleepSync(Math.min(LOCK_RETRY_MS, Math.max(1, Math.ceil(remaining))));
    }
  }
}

export function releaseFileLock(lockPath, token) {
  const current = readLockIfExists(lockPath);
  if (!current || current.content !== token) return;
  unlinkIgnoreMissing(lockPath);
}

function assertLockOwnership(lockPath, token) {
  const current = readLockIfExists(lockPath);
  if (!current) {
    throw new Error(`Lost file lock (missing): ${lockPath}`);
  }
  if (current.content !== token) {
    throw new Error(`Lost file lock ownership: ${lockPath}`);
  }
}

function getExistingFileStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

let cachedWindowsUserSid = null;

function getWindowsSystemExe(name) {
  const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const full = path.join(sys32, name);
  return fs.existsSync(full) ? full : name;
}

function getWindowsUserSid() {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const whoamiExe = getWindowsSystemExe("whoami.exe");
  const out = childProcess.execFileSync(whoamiExe, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const match = out.trim().match(/"(S-1-[^"]+)"\s*$/);
  if (!match) {
    throw new Error("Failed to determine current Windows user SID");
  }
  cachedWindowsUserSid = match[1];
  return cachedWindowsUserSid;
}

function restrictWindowsStagingAcl(tmpPath) {
  const sid = getWindowsUserSid();
  const icaclsExe = getWindowsSystemExe("icacls.exe");
  childProcess.execFileSync(icaclsExe, [tmpPath, "/inheritance:r", "/grant:r", `*${sid}:(F)`], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function hasPosixExtendedAcl(targetPath) {
  const out = childProcess.execFileSync("ls", ["-ld", targetPath], { encoding: "utf8" });
  return /^[-bcdlps][rwxstST-]{9}\+/.test(out.trim());
}

function preservePosixMetadata(targetPath, tmpPath, targetStat) {
  if (
    typeof process.getuid === "function" &&
    (targetStat.uid !== process.getuid() ||
      (typeof process.getgid === "function" && targetStat.gid !== process.getgid()))
  ) {
    fs.chownSync(tmpPath, targetStat.uid, targetStat.gid);
  }
  fs.chmodSync(tmpPath, targetStat.mode & 0o777);
  if (hasPosixExtendedAcl(targetPath)) {
    try {
      const aclText = childProcess.execFileSync("getfacl", ["-p", targetPath], { encoding: "utf8" });
      childProcess.execFileSync("setfacl", ["--set-file=-", tmpPath], { input: aclText, encoding: "utf8" });
    } catch {
      throw new Error(`Refusing atomic replacement of file with extended ACL: ${targetPath}`);
    }
  }
}

export function atomicWriteFile(targetPath, content) {
  const targetStat = getExistingFileStat(targetPath);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
  try {
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      if (process.platform === "win32") {
        restrictWindowsStagingAcl(tmpPath);
      }
      fs.writeFileSync(fd, content, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform === "win32") {
      if (targetStat !== undefined && typeof Bun !== "undefined") {
        replaceFileWindows(targetPath, tmpPath);
      } else {
        fs.renameSync(tmpPath, targetPath);
      }
      return;
    }
    if (targetStat !== undefined) {
      preservePosixMetadata(targetPath, tmpPath, targetStat);
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

export function safeWriteEpic(backlogDir, filePath, expectedRaw, nextRaw) {
  const safePath = assertInsideDir(backlogDir, filePath);
  const lockPath = `${safePath}.lock`;
  const token = acquireFileLock(lockPath);
  try {
    const current = fs.readFileSync(safePath, "utf8");
    if (current !== expectedRaw) {
      throw new Error(`File changed on disk before write: ${safePath}`);
    }
    assertLockOwnership(lockPath, token);
    atomicWriteFile(safePath, nextRaw);
  } finally {
    releaseFileLock(lockPath, token);
  }
}

function assertSingleLine(value, fieldName) {
  if (value === undefined || value === null) return;
  if (/[\r\n]/.test(String(value))) {
    throw new Error(`${fieldName} must be a single line (cannot contain CR or LF)`);
  }
}

function assertValidStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status "${status}". Expected one of: ${[...VALID_STATUSES].join(", ")}`);
  }
}

function assertValidPriority(priority) {
  const upper = String(priority ?? "").toUpperCase();
  if (!VALID_PRIORITIES.has(upper)) {
    throw new Error(`Invalid priority "${priority}". Expected one of: ${PRIORITIES.join(", ")}`);
  }
  return upper;
}

export function getBoardSummary(backlogDir) {
  const epics = loadEpics(backlogDir);
  const epicsByStatus = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
  const epicsByPriority = { P0: 0, P1: 0, P2: 0, P3: 0, unset: 0 };
  const tasksByStatus = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
  let totalTasks = 0;

  for (const epic of epics) {
    epicsByStatus[epic.status] = (epicsByStatus[epic.status] ?? 0) + 1;
    const prioKey = epic.priority && VALID_PRIORITIES.has(epic.priority) ? epic.priority : "unset";
    epicsByPriority[prioKey] += 1;
    totalTasks += epic.counts.total;
    for (const key of VALID_STATUSES) {
      tasksByStatus[key] += epic.counts[key] ?? 0;
    }
  }

  return {
    backlogDir,
    epics: { total: epics.length, byStatus: epicsByStatus, byPriority: epicsByPriority },
    tasks: { total: totalTasks, byStatus: tasksByStatus },
    blockedEpics: epics.filter((e) => e.status === "blocked").map(summarizeEpic),
    inProgressEpics: epics.filter((e) => e.status === "in_progress").map(summarizeEpic),
  };
}

export function listEpics(backlogDir, { status, priority, query } = {}) {
  if (status) assertValidStatus(status);
  const normPriority = priority ? assertValidPriority(priority) : null;
  const q = query ? String(query).trim().toLowerCase() : "";

  return loadEpics(backlogDir)
    .filter((epic) => {
      if (status && epic.status !== status) return false;
      if (normPriority && epic.priority !== normPriority) return false;
      if (!q) return true;
      const haystack = [
        epic.id,
        epic.title,
        epic.goal,
        ...epic.tasks.map((t) => `${t.id} ${t.title}`),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(q);
    })
    .map(summarizeEpic);
}

export function getEpic(backlogDir, epicQuery) {
  const epics = loadEpics(backlogDir);
  return formatEpicDetail(findEpicRecord(epics, epicQuery));
}

export function listTasks(backlogDir, { epic, status, priority, query, limit = 100, offset = 0 } = {}) {
  if (status) assertValidStatus(status);
  const normPriority = priority ? assertValidPriority(priority) : null;
  const q = query ? String(query).trim().toLowerCase() : "";

  const allEpics = loadEpics(backlogDir);
  const targetEpics = epic ? [findEpicRecord(allEpics, epic)] : allEpics;
  const matched = [];

  for (const ep of targetEpics) {
    if (normPriority && ep.priority !== normPriority) continue;
    for (const task of ep.tasks) {
      if (status && task.status !== status) continue;
      if (q) {
        const text = `${task.id} ${task.title} ${ep.id} ${ep.title} ${task.subitems.join(" ")}`.toLowerCase();
        if (!text.includes(q)) continue;
      }
      matched.push({
        id: task.id,
        title: task.title,
        status: task.status,
        lineIndex: task.lineIndex,
        subitems: task.subitems,
        epicId: ep.id,
        epicTitle: ep.title,
        epicStatus: ep.status,
        epicPriority: ep.priority,
        filePath: ep.filePath,
      });
    }
  }

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  return {
    total: matched.length,
    offset: safeOffset,
    limit: safeLimit,
    items: matched.slice(safeOffset, safeOffset + safeLimit),
  };
}

export function createEpic(backlogDir, { title, priority = "P1", goal = "", project = "", firstTask = "", number } = {}) {
  assertSingleLine(title, "title");
  assertSingleLine(project, "project");
  assertSingleLine(firstTask, "firstTask");
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("Epic title is required");
  const normPriority = assertValidPriority(priority);

  if (!isDirectory(backlogDir)) {
    throw new Error(`Backlog directory not found: ${backlogDir}`);
  }

  const safeBacklogDir = fs.realpathSync(path.resolve(backlogDir));
  const lockPath = path.join(safeBacklogDir, ".epic-create.lock");
  const token = acquireFileLock(lockPath);
  try {
    const epics = loadEpics(safeBacklogDir);
    const maxNum = epics.reduce((m, e) => (e.number < 9000 ? Math.max(m, e.number) : m), 0);
    const nextNum = number !== undefined && number !== null ? Number(number) : maxNum + 1;
    if (!Number.isInteger(nextNum) || nextNum <= 0) {
      throw new Error(`Invalid epic number: ${number}`);
    }
    if (epics.some((e) => e.number === nextNum)) {
      throw new Error(`Epic number ${nextNum} already exists`);
    }

    const resolvedProject = project || epics.find((e) => e.project)?.project || "";
    const filename = slugifyEpicFilename(nextNum, cleanTitle);
    const fullPath = assertInsideDir(safeBacklogDir, path.join(safeBacklogDir, filename));
    const md = createEpicMarkdown({
      number: nextNum,
      title: cleanTitle,
      priority: normPriority,
      goal,
      project: resolvedProject,
      firstTask,
    });

    assertLockOwnership(lockPath, token);
    fs.writeFileSync(fullPath, md, { encoding: "utf8", flag: "wx" });
    return formatEpicDetail(parseEpicFile(filename, md, fullPath));
  } finally {
    releaseFileLock(lockPath, token);
  }
}

export function updateEpic(backlogDir, epicQuery, { status, priority } = {}) {
  if (!status && !priority) {
    throw new Error("Provide at least one of status or priority");
  }
  const epics = loadEpics(backlogDir);
  const epic = findEpicRecord(epics, epicQuery);
  let nextRaw = epic.rawText;

  if (status) {
    assertValidStatus(status);
    nextRaw = updateEpicStatus(nextRaw, status);
  }
  if (priority) {
    nextRaw = updateEpicPriority(nextRaw, assertValidPriority(priority));
  }

  if (nextRaw !== epic.rawText) {
    safeWriteEpic(backlogDir, epic.filePath, epic.rawText, nextRaw);
  }
  return formatEpicDetail(parseEpicFile(epic.filename, nextRaw, epic.filePath));
}

export function addTask(backlogDir, { epic: epicQuery, title } = {}) {
  assertSingleLine(title, "title");
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("Task title is required");

  const epics = loadEpics(backlogDir);
  const epic = findEpicRecord(epics, epicQuery);
  const nextRaw = addTaskAndSyncEpic(epic.rawText, cleanTitle, epic.id);
  if (nextRaw === epic.rawText) {
    throw new Error("Failed to add task to epic");
  }

  safeWriteEpic(backlogDir, epic.filePath, epic.rawText, nextRaw);
  const updated = parseEpicFile(epic.filename, nextRaw, epic.filePath);
  const addedTask = updated.tasks[updated.tasks.length - 1];
  return {
    epic: summarizeEpic(updated),
    task: {
      id: addedTask.id,
      title: addedTask.title,
      status: addedTask.status,
      lineIndex: addedTask.lineIndex,
    },
  };
}

function findTaskTarget(epics, epicQuery, taskQuery) {
  const rawTask = String(taskQuery ?? "").trim();
  if (!rawTask) throw new Error("Task identifier is required");

  if (epicQuery) {
    const epic = findEpicRecord(epics, epicQuery);
    const task = findTaskInEpic(epic, rawTask);
    if (!task) throw new Error(`Task "${rawTask}" not found in ${epic.id}`);
    return { epic, task };
  }

  const matches = [];
  for (const epic of epics) {
    const task = findTaskInEpic(epic, rawTask);
    if (task) matches.push({ epic, task });
  }
  if (matches.length === 0) throw new Error(`Task not found: ${rawTask}`);
  if (matches.length > 1) {
    throw new Error(`Task "${rawTask}" matched multiple epics (${matches.map((m) => m.epic.id).join(", ")}); specify epic`);
  }
  return matches[0];
}

function findTaskInEpic(epic, rawTask) {
  const upper = rawTask.toUpperCase();
  if (/^\d+$/.test(rawTask)) {
    const lineIdx = Number(rawTask);
    const byLine = epic.tasks.find((t) => t.lineIndex === lineIdx);
    if (byLine) return byLine;
  }
  return epic.tasks.find((t) => t.id.toUpperCase() === upper) ?? null;
}

export function updateTask(backlogDir, { epic: epicQuery, task: taskQuery, status, syncEpicStatus = true } = {}) {
  assertValidStatus(status);
  const epics = loadEpics(backlogDir);
  const { epic, task } = findTaskTarget(epics, epicQuery, taskQuery);

  const nextRaw = updateTaskStatus(epic.rawText, task.lineIndex, status, { syncEpicStatus });
  if (nextRaw !== epic.rawText) {
    safeWriteEpic(backlogDir, epic.filePath, epic.rawText, nextRaw);
  }

  const updated = parseEpicFile(epic.filename, nextRaw, epic.filePath);
  const updatedTask = updated.tasks.find((t) => t.lineIndex === task.lineIndex) ?? task;
  return {
    epic: summarizeEpic(updated),
    task: {
      id: updatedTask.id,
      title: updatedTask.title,
      status: updatedTask.status,
      lineIndex: updatedTask.lineIndex,
    },
  };
}

export function buildPrompt(backlogDir, { epic: epicQuery, task: taskQuery, projectRoot } = {}) {
  const epics = loadEpics(backlogDir);
  const epic = findEpicRecord(epics, epicQuery);
  let task = null;
  if (taskQuery) {
    task = findTaskInEpic(epic, String(taskQuery).trim());
    if (!task) throw new Error(`Task "${taskQuery}" not found in ${epic.id}`);
  }
  const root = projectRoot || path.dirname(backlogDir);
  return buildAgentPrompt(epic, task, root);
}
