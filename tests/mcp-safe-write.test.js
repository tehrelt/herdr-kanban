import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LOCK_FILENAME,
  computeRevision,
  decodeEpicBytes,
  encodeEpicBytes,
  withBacklogLock,
  readEpicSnapshot,
  safeUpdateFile,
  createFileAtomic,
  safeCreateFile,
} from "../mcp/backlog-server/safe-write.js";
import { updateEpicStatus } from "../mods/kanban/parser.js";

const tempDirs = [];

async function makeTempDir(prefix = "herdr-mcp-write-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeErrno(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("computeRevision, decodeEpicBytes, encodeEpicBytes", () => {
  test("computeRevision hashes Buffer and Uint8Array deterministically and rejects invalid types", () => {
    const buf = Buffer.from("# EPIC-001\n", "utf8");
    const u8 = new Uint8Array(buf);
    const rev1 = computeRevision(buf);
    const rev2 = computeRevision(u8);
    expect(rev1).toMatch(/^[0-9a-f]{64}$/);
    expect(rev2).toBe(rev1);
    expect(() => computeRevision("not-bytes")).toThrow();
  });

  test("decodeEpicBytes and encodeEpicBytes detect and preserve UTF-8 BOM, LF, CRLF, and empty files", () => {
    const lfBytes = encodeEpicBytes("# EPIC-001\n\nBody\n", { hasBom: false });
    expect(decodeEpicBytes(lfBytes)).toEqual({
      text: "# EPIC-001\n\nBody\n",
      hasBom: false,
      eol: "\n",
    });

    const crlfBomBytes = encodeEpicBytes("# EPIC-001\r\n\r\nBody\r\n", { hasBom: true });
    expect(crlfBomBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(decodeEpicBytes(crlfBomBytes)).toEqual({
      text: "# EPIC-001\r\n\r\nBody\r\n",
      hasBom: true,
      eol: "\r\n",
    });

    expect(decodeEpicBytes(Buffer.alloc(0))).toEqual({
      text: "",
      hasBom: false,
      eol: "\n",
    });
    expect(decodeEpicBytes(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({
      text: "",
      hasBom: true,
      eol: "\n",
    });

    expect(() => encodeEpicBytes(123)).toThrow();
  });

  test("decodeEpicBytes rejects NUL bytes, invalid UTF-8, bare CR, and mixed CRLF/LF with UNSUPPORTED_FORMAT", () => {
    const invalidCases = [
      Buffer.from("hello\0world\n", "utf8"),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from([0xe2, 0x82]),
      Buffer.from("line1\rline2\r", "utf8"),
      Buffer.from("line1\r\nline2\n", "utf8"),
    ];

    for (const bytes of invalidCases) {
      expect(() => decodeEpicBytes(bytes, { filename: "001-bad.md" })).toThrow();
      try {
        decodeEpicBytes(bytes, { filename: "001-bad.md" });
      } catch (err) {
        expect(err.code).toBe("UNSUPPORTED_FORMAT");
        expect(err.details).toEqual({ filename: "001-bad.md" });
      }
    }
  });
});

describe("withBacklogLock", () => {
  test("serializes concurrent callbacks and cleans up .herdr-kanban.lock on success and error", async () => {
    const dir = await makeTempDir();
    const events = [];

    await Promise.all(
      [1, 2, 3, 4].map((id) =>
        withBacklogLock(dir, async ({ lockPath }) => {
          events.push(`enter-${id}`);
          const stat = await fs.stat(lockPath);
          expect(stat.isFile()).toBe(true);
          await new Promise((r) => setTimeout(r, 15));
          events.push(`exit-${id}`);
        }),
      ),
    );

    expect(events).toHaveLength(8);
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split("-")[1];
      expect(events[i]).toBe(`enter-${id}`);
      expect(events[i + 1]).toBe(`exit-${id}`);
    }
    await expect(fs.stat(path.join(dir, LOCK_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      withBacklogLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(path.join(dir, LOCK_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("times out with BACKLOG_BUSY (retryable: true) when lock is held", async () => {
    const dir = await makeTempDir();
    let releaseHolder;
    let holderPromise;
    const holderReady = new Promise((resolve) => {
      holderPromise = withBacklogLock(dir, async () => {
        resolve();
        await new Promise((r) => {
          releaseHolder = r;
        });
      });
    });

    await holderReady;
    try {
      await expect(
        withBacklogLock(dir, async () => "never", { lockTimeoutMs: 60 }),
      ).rejects.toMatchObject({
        name: "BacklogError",
        code: "BACKLOG_BUSY",
        retryable: true,
      });
    } finally {
      releaseHolder();
      await holderPromise;
    }
  });

  test("never steals a foreign lock regardless of age", async () => {
    const dir = await makeTempDir();
    const lockPath = path.join(dir, LOCK_FILENAME);
    const foreignContent = JSON.stringify({ pid: 999999, acquiredAt: "1970-01-01T00:00:00.000Z" });
    await fs.writeFile(lockPath, foreignContent, "utf8");
    const epoch = new Date(0);
    await fs.utimes(lockPath, epoch, epoch);

    await expect(
      withBacklogLock(dir, async () => "stolen", { lockTimeoutMs: 80 }),
    ).rejects.toMatchObject({
      name: "BacklogError",
      code: "BACKLOG_BUSY",
      retryable: true,
    });

    expect(await fs.readFile(lockPath, "utf8")).toBe(foreignContent);
  });

  test("validates callback, timeout, and backlogDir", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "file.txt");
    await fs.writeFile(filePath, "x", "utf8");

    await expect(withBacklogLock(dir, "not-fn")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(withBacklogLock(dir, () => {}, { lockTimeoutMs: -1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(withBacklogLock(path.join(dir, "missing"), () => {})).rejects.toMatchObject({
      code: "BACKLOG_NOT_FOUND",
    });
    await expect(withBacklogLock(filePath, () => {})).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
  });
});

describe("safeCreateFile and createFileAtomic", () => {
  test("creates UTF-8 without BOM via non-.md temp file and atomic link+unlink, cleaning up temp file", async () => {
    const dir = await makeTempDir();
    const content = "# EPIC-001 — New\n\n**Status:** [ ] TODO\n";
    let observedSrc = null;
    let observedDst = null;
    let srcBytesDuringPublish = null;
    let dstExistedDuringPublish = null;

    const result = await safeCreateFile({
      backlogDir: dir,
      filename: "001-new.md",
      content,
      publishNoOverwrite: async (src, dst) => {
        observedSrc = src;
        observedDst = dst;
        srcBytesDuringPublish = await fs.readFile(src);
        dstExistedDuringPublish = await fs
          .lstat(dst)
          .then(() => true)
          .catch(() => false);
        await fs.link(src, dst);
      },
    });

    expect(observedSrc).toBeTruthy();
    expect(path.dirname(observedSrc)).toBe(await fs.realpath(dir));
    expect(path.basename(observedSrc).endsWith(".md")).toBe(false);
    expect(path.basename(observedSrc).startsWith(".herdr-kanban.tmp-")).toBe(true);
    expect(observedDst).toBe(path.join(await fs.realpath(dir), "001-new.md"));
    expect(srcBytesDuringPublish).toEqual(Buffer.from(content, "utf8"));
    expect(dstExistedDuringPublish).toBe(false);

    expect(result.created).toBe(true);
    expect(result.hasBom).toBe(false);
    expect(result.eol).toBe("\n");
    expect(result.revision).toBe(computeRevision(Buffer.from(content, "utf8")));

    const diskBytes = await fs.readFile(path.join(dir, "001-new.md"));
    expect(diskBytes).toEqual(Buffer.from(content, "utf8"));
    expect(await fs.readdir(dir)).toEqual(["001-new.md"]);
  });

  test("rejects existing target with WRITE_CONFLICT without overwriting", async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, "001-existing.md");
    await fs.writeFile(target, "# EPIC-001 — Original\n", "utf8");

    await expect(
      safeCreateFile({
        backlogDir: dir,
        filename: "001-existing.md",
        content: "# EPIC-001 — Overwritten\n",
      }),
    ).rejects.toMatchObject({
      name: "BacklogError",
      code: "WRITE_CONFLICT",
      retryable: true,
      details: { filename: "001-existing.md" },
    });

    expect(await fs.readFile(target, "utf8")).toBe("# EPIC-001 — Original\n");
    expect(await fs.readdir(dir)).toEqual(["001-existing.md"]);
  });

  test("maps EEXIST from publishNoOverwrite to WRITE_CONFLICT and cleans up temp file", async () => {
    const dir = await makeTempDir();

    await expect(
      createFileAtomic({
        backlogDir: dir,
        filename: "001-race.md",
        content: "# EPIC-001 — Race\n",
        publishNoOverwrite: async () => {
          throw makeErrno("EEXIST");
        },
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
      details: { filename: "001-race.md" },
    });

    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("maps ENOTSUP/EOPNOTSUPP/ENOSYS/EXDEV/EPERM from publishNoOverwrite to UNSUPPORTED_FILESYSTEM without fallback", async () => {
    for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EPERM"]) {
      const dir = await makeTempDir();
      await expect(
        createFileAtomic({
          backlogDir: dir,
          filename: "001-unsupported.md",
          content: "# EPIC-001 — Unsupported\n",
          publishNoOverwrite: async () => {
            throw makeErrno(code);
          },
        }),
      ).rejects.toMatchObject({
        name: "BacklogError",
        code: "UNSUPPORTED_FILESYSTEM",
        retryable: false,
        details: { filename: "001-unsupported.md" },
      });

      expect(await fs.readdir(dir)).toEqual([]);
    }
  });

  test("concurrent safeCreateFile on same filename yields one success and one WRITE_CONFLICT", async () => {
    const dir = await makeTempDir();
    const results = await Promise.allSettled([
      safeCreateFile({
        backlogDir: dir,
        filename: "001-concurrent.md",
        content: "# EPIC-001 — First\n",
      }),
      safeCreateFile({
        backlogDir: dir,
        filename: "001-concurrent.md",
        content: "# EPIC-001 — Second\n",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
    });
    expect(await fs.readdir(dir)).toEqual(["001-concurrent.md"]);
  });
});

describe("safeUpdateFile and readEpicSnapshot", () => {
  test("preserves CRLF, LF, endsWithNewline (true/false), and UTF-8 BOM", async () => {
    const dir = await makeTempDir();

    const cases = [
      {
        name: "001-crlf-bom.md",
        raw: "# EPIC-001 — One\r\n\r\n**Status:** [ ] TODO\r\n\r\n## Задачи\r\n\r\n- [ ] TASK-001.1 A\r\n",
        hasBom: true,
        expectedEol: "\r\n",
        endsWithNewline: true,
      },
      {
        name: "002-lf-no-eol.md",
        raw: "# EPIC-002 — Two\n\n**Status:** [ ] TODO\n\n## Задачи\n\n- [ ] TASK-002.1 B",
        hasBom: false,
        expectedEol: "\n",
        endsWithNewline: false,
      },
      {
        name: "003-crlf-no-eol.md",
        raw: "# EPIC-003 — Three\r\n\r\n**Status:** [ ] TODO",
        hasBom: false,
        expectedEol: "\r\n",
        endsWithNewline: false,
      },
    ];

    for (const c of cases) {
      const filePath = path.join(dir, c.name);
      await fs.writeFile(filePath, encodeEpicBytes(c.raw, { hasBom: c.hasBom }));
      const snap = await readEpicSnapshot(dir, c.name);
      expect(snap.hasBom).toBe(c.hasBom);
      expect(snap.eol).toBe(c.expectedEol);

      const updated = await safeUpdateFile({
        backlogDir: dir,
        filename: c.name,
        expectedRevision: snap.revision,
        transform: (text) => updateEpicStatus(text, "in_progress"),
      });

      expect(updated.changed).toBe(true);
      expect(updated.hasBom).toBe(c.hasBom);
      expect(updated.eol).toBe(c.expectedEol);
      expect(updated.text.endsWith(c.expectedEol)).toBe(c.endsWithNewline);

      const diskBytes = await fs.readFile(filePath);
      const decoded = decodeEpicBytes(diskBytes);
      expect(decoded.hasBom).toBe(c.hasBom);
      expect(decoded.eol).toBe(c.expectedEol);
      expect(decoded.text).toContain("**Status:** [-] IN PROGRESS");
      expect(decoded.text.endsWith(c.expectedEol)).toBe(c.endsWithNewline);
    }
  });

  test("returns changed: false on no-op while still checking expectedRevision BEFORE no-op", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-noop.md");
    const initial = "# EPIC-001 — Noop\n\n**Status:** [x] DONE\n";
    await fs.writeFile(filePath, initial, "utf8");

    const snap = await readEpicSnapshot(dir, "001-noop.md");
    const staleRevision = "0".repeat(64);
    let transformCalled = false;

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-noop.md",
        expectedRevision: staleRevision,
        transform: (text) => {
          transformCalled = true;
          return text;
        },
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
      details: {
        filename: "001-noop.md",
        expectedRevision: staleRevision,
        currentRevision: snap.revision,
      },
    });
    expect(transformCalled).toBe(false);

    const noopRes = await safeUpdateFile({
      backlogDir: dir,
      filename: "001-noop.md",
      expectedRevision: snap.revision,
      transform: (text) => text,
    });
    expect(noopRes.changed).toBe(false);
    expect(noopRes.revision).toBe(snap.revision);
    expect(await fs.readdir(dir)).toEqual(["001-noop.md"]);
  });

  test("concurrent updates with same expectedRevision yield one success and one WRITE_CONFLICT with revisions", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-race.md");
    await fs.writeFile(filePath, "# EPIC-001 — Race\n\n**Status:** [ ] TODO\n", "utf8");
    const snap = await readEpicSnapshot(dir, "001-race.md");

    const results = await Promise.allSettled([
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-race.md",
        expectedRevision: snap.revision,
        transform: async (text) => {
          await new Promise((r) => setTimeout(r, 20));
          return updateEpicStatus(text, "in_progress");
        },
      }),
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-race.md",
        expectedRevision: snap.revision,
        transform: async (text) => {
          await new Promise((r) => setTimeout(r, 20));
          return updateEpicStatus(text, "blocked");
        },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
      details: {
        filename: "001-race.md",
        expectedRevision: snap.revision,
        currentRevision: fulfilled[0].value.revision,
      },
    });
  });

  test("detects external modification during transform before rename and cleans up temp file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-ext-mod.md");
    await fs.writeFile(filePath, "# EPIC-001 — Initial\n", "utf8");
    const snap = await readEpicSnapshot(dir, "001-ext-mod.md");
    const externalContent = "# EPIC-001 — External Edit\n";
    const externalRev = computeRevision(Buffer.from(externalContent, "utf8"));

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-ext-mod.md",
        expectedRevision: snap.revision,
        transform: async () => {
          await fs.writeFile(filePath, externalContent, "utf8");
          return "# EPIC-001 — Stale Write\n";
        },
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
      details: {
        filename: "001-ext-mod.md",
        expectedRevision: snap.revision,
        currentRevision: externalRev,
      },
    });

    expect(await fs.readFile(filePath, "utf8")).toBe(externalContent);
    expect(await fs.readdir(dir)).toEqual(["001-ext-mod.md"]);
  });

  test("detects external deletion during transform before rename and cleans up temp file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-ext-del.md");
    await fs.writeFile(filePath, "# EPIC-001 — Initial\n", "utf8");
    const snap = await readEpicSnapshot(dir, "001-ext-del.md");

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-ext-del.md",
        expectedRevision: snap.revision,
        transform: async () => {
          await fs.unlink(filePath);
          return "# EPIC-001 — Recreated?\n";
        },
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      retryable: true,
      details: {
        filename: "001-ext-del.md",
        expectedRevision: snap.revision,
      },
    });

    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("rejects transform introducing mixed EOL with UNSUPPORTED_FORMAT without modifying file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-mixed.md");
    const initial = "# EPIC-001 — Clean\n";
    await fs.writeFile(filePath, initial, "utf8");
    const snap = await readEpicSnapshot(dir, "001-mixed.md");

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-mixed.md",
        expectedRevision: snap.revision,
        transform: () => "# EPIC-001 — Clean\r\nMixed\n",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      retryable: false,
      details: { filename: "001-mixed.md" },
    });

    expect(await fs.readFile(filePath, "utf8")).toBe(initial);
    expect(await fs.readdir(dir)).toEqual(["001-mixed.md"]);
  });

  test("validates arguments and rejects non-string transform return or target becoming directory", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "001-edge.md");
    await fs.writeFile(filePath, "# EPIC-001 — Edge\n", "utf8");
    const snap = await readEpicSnapshot(dir, "001-edge.md");

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-edge.md",
        expectedRevision: "",
        transform: (t) => t,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { field: "expectedRevision" } });

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-edge.md",
        expectedRevision: snap.revision,
        transform: "not-a-fn",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-edge.md",
        expectedRevision: snap.revision,
        transform: () => 42,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", details: { filename: "001-edge.md" } });

    await expect(
      createFileAtomic({
        backlogDir: dir,
        filename: "002-bad.md",
        content: 123,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { field: "content" } });

    await expect(
      createFileAtomic({
        backlogDir: dir,
        filename: "002-bad.md",
        content: "# EPIC-002\n",
        publishNoOverwrite: "not-a-fn",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      safeUpdateFile({
        backlogDir: dir,
        filename: "001-edge.md",
        expectedRevision: snap.revision,
        transform: async () => {
          await fs.unlink(filePath);
          await fs.mkdir(filePath);
          return "# EPIC-001 — Replaced by dir\n";
        },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH", details: { filename: "001-edge.md" } });
  });
});
