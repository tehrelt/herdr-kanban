export const ALLOWED_DETAIL_KEYS = Object.freeze([
  "epicId",
  "taskId",
  "field",
  "expectedRevision",
  "currentRevision",
  "filename",
]);

export const ERROR_CATALOG = Object.freeze({
  INVALID_ARGUMENT: Object.freeze({ retryable: false, jsonRpcCode: -32602 }),
  INVALID_ID: Object.freeze({ retryable: false, jsonRpcCode: -32602 }),
  BACKLOG_NOT_FOUND: Object.freeze({ retryable: false, jsonRpcCode: -32002 }),
  NOT_DIRECTORY: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  PERMISSION_DENIED: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  UNSAFE_PATH: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  EPIC_NOT_FOUND: Object.freeze({ retryable: false, jsonRpcCode: -32002 }),
  TASK_NOT_FOUND: Object.freeze({ retryable: false, jsonRpcCode: -32002 }),
  AMBIGUOUS_ID: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  UNSUPPORTED_FORMAT: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  UNSUPPORTED_FILESYSTEM: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  WRITE_CONFLICT: Object.freeze({ retryable: true, jsonRpcCode: -32000 }),
  BACKLOG_BUSY: Object.freeze({ retryable: true, jsonRpcCode: -32000 }),
  NUMBER_EXHAUSTED: Object.freeze({ retryable: false, jsonRpcCode: -32000 }),
  IO_ERROR: Object.freeze({ retryable: true, jsonRpcCode: -32000 }),
  INTERNAL_ERROR: Object.freeze({ retryable: false, jsonRpcCode: -32603 }),
});

const FS_ERROR_MESSAGES = Object.freeze({
  PERMISSION_DENIED: "Permission denied accessing backlog path",
  BACKLOG_NOT_FOUND: "Backlog directory not found",
  EPIC_NOT_FOUND: "Epic file not found",
  NOT_DIRECTORY: "Path is not a directory",
  UNSAFE_PATH: "Unsafe path or symbolic link detected",
  WRITE_CONFLICT: "Target file already exists or changed concurrently",
  INVALID_ARGUMENT: "Path or filename exceeds filesystem limits",
  UNSUPPORTED_FILESYSTEM: "Filesystem does not support atomic non-overwriting creation",
  IO_ERROR: "Filesystem I/O error",
});

export function sanitizeErrorDetails(details) {
  if (!details || typeof details !== "object") {
    return Object.freeze({});
  }
  const clean = {};
  for (const key of ALLOWED_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) {
      clean[key] = value;
    }
  }
  return Object.freeze(clean);
}

export class BacklogError extends Error {
  constructor(code, message, details = {}, options = {}) {
    const resolvedCode = Object.hasOwn(ERROR_CATALOG, code) ? code : "INTERNAL_ERROR";
    const meta = ERROR_CATALOG[resolvedCode];
    const safeMessage = typeof message === "string" && message.length > 0 ? message : resolvedCode;
    const superOptions = options && options.cause !== undefined ? { cause: options.cause } : undefined;
    super(safeMessage, superOptions);
    this.name = "BacklogError";
    this.code = resolvedCode;
    this.retryable = meta.retryable;
    this.jsonRpcCode = meta.jsonRpcCode;
    this.details = sanitizeErrorDetails(details);
  }
}

function normalizeZodError(err) {
  const first = err.issues[0];
  const field = Array.isArray(first?.path) && first.path.length > 0 ? first.path.join(".") : "";
  const isIdField =
    field === "epicId" ||
    field === "taskId" ||
    field.endsWith(".epicId") ||
    field.endsWith(".taskId");
  const code = isIdField ? "INVALID_ID" : "INVALID_ARGUMENT";
  const message = typeof first?.message === "string" && first.message ? first.message : "Invalid arguments";
  const details = field ? { field } : {};
  return new BacklogError(code, message, details, { cause: err });
}

export function normalizeError(err) {
  if (err instanceof BacklogError) {
    return err;
  }
  if (err && (err.name === "ZodError" || err.name === "$ZodError") && Array.isArray(err.issues)) {
    return normalizeZodError(err);
  }
  if (err && typeof err === "object" && typeof err.code === "string" && Object.hasOwn(ERROR_CATALOG, err.code)) {
    const msg = typeof err.message === "string" && err.message ? err.message : err.code;
    return new BacklogError(err.code, msg, err.details, { cause: err });
  }
  return new BacklogError("INTERNAL_ERROR", "Internal server error", {}, { cause: err });
}

function toPublicErrorObject(err) {
  const normalized = normalizeError(err);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    details: normalized.details,
  };
}

export function toErrorPayload(err) {
  return {
    ok: false,
    error: toPublicErrorObject(err),
  };
}

export function toToolErrorResult(err) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(toErrorPayload(err)),
      },
    ],
  };
}

export function toJsonRpcErrorInfo(err) {
  const normalized = normalizeError(err);
  const data = toPublicErrorObject(normalized);
  return {
    code: normalized.jsonRpcCode,
    message: data.message,
    data,
  };
}

function resolveFsErrorCode(fsCode, fallbackCode, overrides) {
  if (fsCode && Object.hasOwn(overrides, fsCode)) {
    return overrides[fsCode];
  }
  if (fsCode === "EACCES" || fsCode === "EPERM") return "PERMISSION_DENIED";
  if (fsCode === "ENOENT") {
    return fallbackCode === "EPIC_NOT_FOUND" ? "EPIC_NOT_FOUND" : "BACKLOG_NOT_FOUND";
  }
  if (fsCode === "ENOTDIR") return "NOT_DIRECTORY";
  if (fsCode === "EISDIR" || fsCode === "ELOOP") return "UNSAFE_PATH";
  if (fsCode === "EEXIST") return "WRITE_CONFLICT";
  if (fsCode === "ENAMETOOLONG") return "INVALID_ARGUMENT";
  if (fsCode === "ENOTSUP" || fsCode === "EOPNOTSUPP" || fsCode === "ENOSYS" || fsCode === "EXDEV") {
    return "UNSUPPORTED_FILESYSTEM";
  }
  return Object.hasOwn(ERROR_CATALOG, fallbackCode) ? fallbackCode : "IO_ERROR";
}

export function mapFsError(err, fallbackCode = "IO_ERROR", details = {}, overrides = {}) {
  if (err instanceof BacklogError) {
    return err;
  }
  const fsCode = err && typeof err.code === "string" ? err.code : "";
  const mappedCode = resolveFsErrorCode(fsCode, fallbackCode, overrides);
  const baseMessage = FS_ERROR_MESSAGES[mappedCode] ?? "Filesystem operation failed";
  const message = mappedCode === "IO_ERROR" && fsCode ? `${baseMessage} (${fsCode})` : baseMessage;
  return new BacklogError(mappedCode, message, details, { cause: err });
}
