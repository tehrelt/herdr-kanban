import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BacklogError, mapFsError } from "./errors.js";
import { resolveSafeEpicPath } from "./resolve-backlog.js";

export const LOCK_FILENAME = ".herdr-kanban.lock";
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UNSUPPORTED_PUBLISH_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EPERM"]);

function assertByteBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new BacklogError("INVALID_ARGUMENT", "Expected Buffer or Uint8Array");
  }
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function computeRevision(bytes) {
  const buf = assertByteBuffer(bytes);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function detectHomogeneousEol(text, details) {
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13) {
      if (text.charCodeAt(i + 1) !== 10) {
        throw new BacklogError("UNSUPPORTED_FORMAT", "File contains bare CR line endings", details);
      }
      crlfCount++;
      i++;
    } else if (ch === 10) {
      lfCount++;
    }
  }
  if (crlfCount > 0 && lfCount > 0) {
    throw new BacklogError("UNSUPPORTED_FORMAT", "File contains mixed CRLF and LF line endings", details);
  }
  return crlfCount > 0 ? "\r\n" : "\n";
}

export function decodeEpicBytes(bytes, details = {}) {
  const buf = assertByteBuffer(bytes);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const payload = hasBom ? buf.subarray(3) : buf;
  if (payload.includes(0x00)) {
    throw new BacklogError("UNSUPPORTED_FORMAT", "File contains NUL bytes", details);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (err) {
    throw new BacklogError("UNSUPPORTED_FORMAT", "File is not valid UTF-8", details, { cause: err });
  }
  const eol = detectHomogeneousEol(text, details);
  return Object.freeze({ text, hasBom, eol });
}

export function encodeEpicBytes(text, { hasBom = false } = {}) {
  if (typeof text !== "string") {
    throw new BacklogError("INVALID_ARGUMENT", "Content must be a string");
  }
  const body = Buffer.from(text, "utf8");
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyLockDirectory(backlogDir) {
  if (typeof backlogDir !== "string" || backlogDir.trim().length === 0) {
    throw new BacklogError("BACKLOG_NOT_FOUND", "Backlog directory not found");
  }
  let stats;
  try {
    stats = await fs.stat(backlogDir);
  } catch (err) {
    throw mapFsError(err);
  }
  if (!stats.isDirectory()) {
    throw new BacklogError("NOT_DIRECTORY", "Backlog path is not a directory");
  }
  try {
    return await fs.realpath(backlogDir);
  } catch (err) {
    throw mapFsError(err);
  }
}

async function acquireLockFile(lockPath, lockTimeoutMs) {
  const deadline = Date.now() + lockTimeoutMs;
  let transientEpermRetries = 0;
  let sawEexist = false;
  while (true) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      const meta = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n";
      await handle.writeFile(meta, "utf8");
      return handle;
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
      if (err?.code === "EEXIST") {
        sawEexist = true;
        transientEpermRetries = 0;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new BacklogError("BACKLOG_BUSY", "Backlog is busy; lock acquisition timed out");
        }
        const delay = Math.min(remaining, 15 + Math.floor(Math.random() * 25));
        await sleep(delay);
        continue;
      }
      if (process.platform === "win32" && err?.code === "EPERM") {
        const remaining = deadline - Date.now();
        if (remaining > 0 && transientEpermRetries < 8) {
          transientEpermRetries++;
          await sleep(Math.min(remaining, 10 + transientEpermRetries * 5));
          continue;
        }
        if (sawEexist && remaining <= 0) {
          throw new BacklogError("BACKLOG_BUSY", "Backlog is busy; lock acquisition timed out");
        }
      }
      throw mapFsError(err);
    }
  }
}

async function releaseLockFile(handle, lockPath) {
  if (handle) {
    await handle.close().catch(() => {});
  }
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(`[herdr-kanban-mcp] Failed to release lock: ${err?.code || "UNKNOWN"}\n`);
    }
  }
}

export async function withBacklogLock(backlogDir, fn, options = {}) {
  if (typeof fn !== "function") {
    throw new BacklogError("INVALID_ARGUMENT", "Lock callback must be a function");
  }
  const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (typeof lockTimeoutMs !== "number" || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new BacklogError("INVALID_ARGUMENT", "lockTimeoutMs must be a non-negative finite number");
  }
  const canonicalDir = await verifyLockDirectory(backlogDir);
  const lockPath = path.join(canonicalDir, LOCK_FILENAME);
  const handle = await acquireLockFile(lockPath, lockTimeoutMs);
  try {
    return await fn({ backlogDir: canonicalDir, lockPath });
  } finally {
    await releaseLockFile(handle, lockPath);
  }
}

async function readFileBytesNoFollow(filePath, filename, missingCode = "EPIC_NOT_FOUND") {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle = null;
  try {
    handle = await fs.open(filePath, flags);
    return await handle.readFile();
  } catch (err) {
    throw mapFsError(err, "IO_ERROR", { filename }, { ENOENT: missingCode });
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function lstatRegularFile(targetPath, filename, missingCode = "EPIC_NOT_FOUND") {
  let st;
  try {
    st = await fs.lstat(targetPath);
  } catch (err) {
    throw mapFsError(err, "IO_ERROR", { filename }, { ENOENT: missingCode });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BacklogError("UNSAFE_PATH", "Symbolic links and non-regular files are not allowed", {
      filename,
    });
  }
  return st;
}

export async function readEpicSnapshot(backlogDir, filename) {
  const filePath = await resolveSafeEpicPath(backlogDir, filename, { mustExist: true });
  const bytes = await readFileBytesNoFollow(filePath, filename, "EPIC_NOT_FOUND");
  const revision = computeRevision(bytes);
  const { text, hasBom, eol } = decodeEpicBytes(bytes, { filename });
  return Object.freeze({ filename, filePath, bytes, text, hasBom, eol, revision });
}

async function writeAllBytes(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) {
      throw new BacklogError("IO_ERROR", "Short write while writing temporary file");
    }
    offset += bytesWritten;
  }
}

async function writeTempFile(canonicalDir, bytes, { mode = 0o666, preserveMode = false, filename }) {
  const tempPath = path.join(canonicalDir, `.herdr-kanban.tmp-${process.pid}-${crypto.randomUUID()}`);
  let handle = null;
  let created = false;
  try {
    handle = await fs.open(tempPath, "wx", mode);
    created = true;
    if (preserveMode && typeof mode === "number") {
      await handle.chmod(mode);
    }
    await writeAllBytes(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    return tempPath;
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (created) {
      await cleanupTempFile(tempPath);
    }
    throw mapFsError(err, "IO_ERROR", { filename });
  }
}

async function cleanupTempFile(tempPath) {
  try {
    await fs.unlink(tempPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(`[herdr-kanban-mcp] Failed to remove temp file: ${err?.code || "UNKNOWN"}\n`);
    }
  }
}

async function verifyTargetForUpdate(targetPath, filename, expectedRevision) {
  let st;
  try {
    st = await fs.lstat(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new BacklogError("WRITE_CONFLICT", "Target file disappeared before publish", {
        filename,
        expectedRevision,
      });
    }
    throw mapFsError(err, "IO_ERROR", { filename });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BacklogError("UNSAFE_PATH", "Target became a symbolic link or non-regular file", {
      filename,
    });
  }
  const latestBytes = await readFileBytesNoFollow(targetPath, filename, "WRITE_CONFLICT");
  const currentRevision = computeRevision(latestBytes);
  if (currentRevision !== expectedRevision) {
    throw new BacklogError("WRITE_CONFLICT", "Target file changed concurrently before publish", {
      filename,
      expectedRevision,
      currentRevision,
    });
  }
}

async function publishUpdatedTempFile(targetPath, tempPath, filename, expectedRevision) {
  try {
    await verifyTargetForUpdate(targetPath, filename, expectedRevision);
    try {
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      throw mapFsError(err, "IO_ERROR", { filename });
    }
  } finally {
    await cleanupTempFile(tempPath);
  }
}

function buildWriteResult({ changed, filename, filePath, revision, text, bytes, hasBom, eol }) {
  return Object.freeze({ changed, filename, filePath, revision, text, bytes, hasBom, eol });
}

async function readAndVerifyForUpdate(canonicalDir, filename, expectedRevision) {
  const targetPath = await resolveSafeEpicPath(canonicalDir, filename, { mustExist: true });
  const targetStat = await lstatRegularFile(targetPath, filename, "EPIC_NOT_FOUND");
  const currentBytes = await readFileBytesNoFollow(targetPath, filename, "EPIC_NOT_FOUND");
  const currentRevision = computeRevision(currentBytes);
  if (currentRevision !== expectedRevision) {
    throw new BacklogError("WRITE_CONFLICT", "File revision does not match expectedRevision", {
      filename,
      expectedRevision,
      currentRevision,
    });
  }
  const decoded = decodeEpicBytes(currentBytes, { filename });
  return { targetPath, targetStat, currentBytes, currentRevision, decoded };
}

async function updateFileUnderLock({ canonicalDir, filename, expectedRevision, transform }) {
  const { targetPath, targetStat, currentBytes, currentRevision, decoded } =
    await readAndVerifyForUpdate(canonicalDir, filename, expectedRevision);

  const nextText = await transform(decoded.text, {
    filename,
    filePath: targetPath,
    hasBom: decoded.hasBom,
    eol: decoded.eol,
    revision: currentRevision,
  });
  if (typeof nextText !== "string") {
    throw new BacklogError("INTERNAL_ERROR", "Transform must return a string", { filename });
  }

  const nextBytes = encodeEpicBytes(nextText, { hasBom: decoded.hasBom });
  const nextDecoded = decodeEpicBytes(nextBytes, { filename });
  if (Buffer.compare(nextBytes, currentBytes) === 0) {
    return buildWriteResult({
      changed: false,
      filename,
      filePath: targetPath,
      revision: currentRevision,
      text: decoded.text,
      bytes: currentBytes,
      hasBom: decoded.hasBom,
      eol: decoded.eol,
    });
  }

  const tempPath = await writeTempFile(canonicalDir, nextBytes, {
    mode: targetStat.mode & 0o777,
    preserveMode: true,
    filename,
  });
  await publishUpdatedTempFile(targetPath, tempPath, filename, expectedRevision);
  return buildWriteResult({
    changed: true,
    filename,
    filePath: targetPath,
    revision: computeRevision(nextBytes),
    text: nextText,
    bytes: nextBytes,
    hasBom: decoded.hasBom,
    eol: nextDecoded.eol,
  });
}

export async function safeUpdateFile({
  backlogDir,
  filename,
  expectedRevision,
  transform,
  lockOptions,
}) {
  if (typeof expectedRevision !== "string" || expectedRevision.length === 0) {
    throw new BacklogError("INVALID_ARGUMENT", "expectedRevision must be a non-empty string", {
      field: "expectedRevision",
    });
  }
  if (typeof transform !== "function") {
    throw new BacklogError("INVALID_ARGUMENT", "transform must be a function");
  }
  return withBacklogLock(
    backlogDir,
    ({ backlogDir: canonicalDir }) =>
      updateFileUnderLock({ canonicalDir, filename, expectedRevision, transform }),
    lockOptions,
  );
}

async function assertTargetAbsent(targetPath, filename) {
  let st;
  try {
    st = await fs.lstat(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw mapFsError(err, "IO_ERROR", { filename });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BacklogError("UNSAFE_PATH", "Target path exists and is not a regular file", {
      filename,
    });
  }
  throw new BacklogError("WRITE_CONFLICT", "Target file already exists", { filename });
}

async function publishAtomicNoOverwrite(publishNoOverwrite, tempPath, targetPath, filename) {
  try {
    await publishNoOverwrite(tempPath, targetPath);
  } catch (err) {
    if (err instanceof BacklogError) throw err;
    const code = err?.code;
    if (code === "EEXIST") {
      throw new BacklogError("WRITE_CONFLICT", "Target file already exists", { filename }, { cause: err });
    }
    if (UNSUPPORTED_PUBLISH_CODES.has(code)) {
      throw new BacklogError(
        "UNSUPPORTED_FILESYSTEM",
        "Filesystem does not support atomic non-overwriting file creation",
        { filename },
        { cause: err },
      );
    }
    throw mapFsError(err, "IO_ERROR", { filename });
  }
}

export async function createFileAtomic({
  backlogDir,
  filename,
  content,
  publishNoOverwrite = (src, dst) => fs.link(src, dst),
}) {
  if (typeof content !== "string") {
    throw new BacklogError("INVALID_ARGUMENT", "content must be a string", { field: "content" });
  }
  if (typeof publishNoOverwrite !== "function") {
    throw new BacklogError("INVALID_ARGUMENT", "publishNoOverwrite must be a function");
  }
  const targetPath = await resolveSafeEpicPath(backlogDir, filename, { mustExist: false });
  await assertTargetAbsent(targetPath, filename);

  const bytes = encodeEpicBytes(content, { hasBom: false });
  const decoded = decodeEpicBytes(bytes, { filename });
  const canonicalDir = path.dirname(targetPath);
  const tempPath = await writeTempFile(canonicalDir, bytes, {
    mode: 0o666,
    preserveMode: false,
    filename,
  });
  try {
    await assertTargetAbsent(targetPath, filename);
    await publishAtomicNoOverwrite(publishNoOverwrite, tempPath, targetPath, filename);
    return Object.freeze({
      created: true,
      filename,
      filePath: targetPath,
      revision: computeRevision(bytes),
      text: content,
      bytes,
      hasBom: false,
      eol: decoded.eol,
    });
  } finally {
    await cleanupTempFile(tempPath);
  }
}

export async function safeCreateFile({
  backlogDir,
  filename,
  content,
  lockOptions,
  publishNoOverwrite,
}) {
  return withBacklogLock(
    backlogDir,
    ({ backlogDir: canonicalDir }) =>
      createFileAtomic({
        backlogDir: canonicalDir,
        filename,
        content,
        publishNoOverwrite,
      }),
    lockOptions,
  );
}
