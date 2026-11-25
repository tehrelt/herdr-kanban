import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveBacklogDir,
  resolvePinnedBacklogDir,
  getBoardSummary,
  listEpics,
  getEpic,
  listTasks,
  createEpic,
  updateEpic,
  addTask,
  updateTask,
  buildPrompt,
  acquireFileLock,
  releaseFileLock,
  atomicWriteFile,
  safeWriteEpic,
} from "../mcp/backlog.js";

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-kanban-mcp-"));
  const backlog = path.join(root, "backlog");
  fs.mkdirSync(backlog, { recursive: true });

  fs.writeFileSync(
    path.join(backlog, "001-auth.md"),
    [
      "# EPIC-001 — Auth foundation",
      "",
      "> Проект: **Demo**",
      "",
      "**Status:** [-] IN PROGRESS",
      "",
      "**Priority:** P0",
      "",
      "## Цель",
      "",
      "Настроить аутентификацию.",
      "",
      "## Задачи",
      "",
      "- [x] TASK-001.1 Добавить JWT",
      "- [ ] TASK-001.2 Добавить refresh tokens",
      "  - Хранить в Redis",
      "",
      "## Definition of Done",
      "",
      "- Все тесты проходят.",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(backlog, "002-billing.md"),
    [
      "# EPIC-002 — Billing",
      "",
      "**Status:** [!] BLOCKED",
      "",
      "**Priority:** P2",
      "",
      "## Задачи",
      "",
      "- [!] TASK-002.1 Ждём ключи Stripe",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(path.join(backlog, "README.md"), "# Backlog README\n", "utf8");
  return { root, backlog };
}

describe("mcp/backlog", () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempProject();
  });

  afterEach(() => {
    fs.rmSync(tmp.root, { recursive: true, force: true });
  });

  test("resolveBacklogDir finds backlog from project root or explicit backlog dir", () => {
    expect(resolveBacklogDir({ cwd: tmp.root })).toBe(tmp.backlog);
    expect(resolveBacklogDir({ backlogDir: tmp.backlog })).toBe(tmp.backlog);
    expect(resolveBacklogDir({ backlogDir: tmp.root })).toBe(tmp.backlog);
  });

  test("resolveBacklogDir throws when directory does not exist", () => {
    expect(() => resolveBacklogDir({ backlogDir: path.join(tmp.root, "missing") })).toThrow();
  });

  test("getBoardSummary aggregates epics and tasks by status and priority", () => {
    const summary = getBoardSummary(tmp.backlog);
    expect(summary.backlogDir).toBe(tmp.backlog);
    expect(summary.epics.total).toBe(2);
    expect(summary.epics.byStatus).toEqual({
      todo: 0,
      in_progress: 1,
      blocked: 1,
      done: 0,
    });
    expect(summary.tasks.total).toBe(3);
    expect(summary.tasks.byStatus).toEqual({
      todo: 1,
      in_progress: 0,
      blocked: 1,
      done: 1,
    });
    expect(summary.blockedEpics.map((e) => e.id)).toEqual(["EPIC-002"]);
  });

  test("listEpics filters by status, priority, and query", () => {
    expect(listEpics(tmp.backlog)).toHaveLength(2);
    expect(listEpics(tmp.backlog, { status: "blocked" }).map((e) => e.id)).toEqual(["EPIC-002"]);
    expect(listEpics(tmp.backlog, { priority: "P0" }).map((e) => e.id)).toEqual(["EPIC-001"]);
    expect(listEpics(tmp.backlog, { query: "refresh" }).map((e) => e.id)).toEqual(["EPIC-001"]);
  });

  test("getEpic resolves by EPIC-NNN, number, or filename", () => {
    expect(getEpic(tmp.backlog, "EPIC-001").title).toBe("Auth foundation");
    expect(getEpic(tmp.backlog, "epic-001").id).toBe("EPIC-001");
    expect(getEpic(tmp.backlog, "1").id).toBe("EPIC-001");
    expect(getEpic(tmp.backlog, "002-billing.md").id).toBe("EPIC-002");
    expect(() => getEpic(tmp.backlog, "EPIC-999")).toThrow();
  });

  test("listTasks returns flat tasks with filters and pagination", () => {
    const all = listTasks(tmp.backlog);
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    const todo = listTasks(tmp.backlog, { status: "todo" });
    expect(todo.total).toBe(1);
    expect(todo.items[0]).toMatchObject({
      id: "TASK-001.2",
      epicId: "EPIC-001",
      epicPriority: "P0",
      subitems: ["Хранить в Redis"],
    });

    const paged = listTasks(tmp.backlog, { limit: 1, offset: 1 });
    expect(paged.total).toBe(3);
    expect(paged.items).toHaveLength(1);
    expect(paged.items[0].id).toBe("TASK-001.2");
  });

  test("createEpic creates numbered markdown file and inherits project", () => {
    const created = createEpic(tmp.backlog, {
      title: "Notifications",
      priority: "P1",
      goal: "Send emails",
      firstTask: "Setup SMTP",
    });
    expect(created.id).toBe("EPIC-003");
    expect(created.filename).toBe("003-notifications.md");
    expect(created.project).toBe("Demo");
    expect(created.tasks).toHaveLength(1);
    expect(created.tasks[0].id).toBe("TASK-003.1");
    expect(fs.existsSync(created.filePath)).toBe(true);
  });

  test("updateEpic updates status and priority on disk", () => {
    const updated = updateEpic(tmp.backlog, "EPIC-002", { status: "in_progress", priority: "P1" });
    expect(updated.status).toBe("in_progress");
    expect(updated.priority).toBe("P1");

    const reloaded = getEpic(tmp.backlog, "EPIC-002");
    expect(reloaded.status).toBe("in_progress");
    expect(reloaded.priority).toBe("P1");
  });

  test("addTask appends task with next TASK-NNN.K id", () => {
    const res = addTask(tmp.backlog, { epic: "EPIC-001", title: "Add rate limiting" });
    expect(res.task.id).toBe("TASK-001.3");
    expect(res.epic.counts.total).toBe(3);
  });

  test("updateTask updates task status by task id without requiring epic and syncs epic status", () => {
    const res = updateTask(tmp.backlog, { task: "TASK-001.2", status: "done" });
    expect(res.task.status).toBe("done");
    expect(res.epic.status).toBe("done");
    expect(res.epic.counts.done).toBe(2);
  });

  test("buildPrompt generates prompt for epic or specific task", () => {
    const epicPrompt = buildPrompt(tmp.backlog, { epic: "EPIC-001" });
    expect(epicPrompt).toContain("EPIC-001");
    expect(epicPrompt).toContain("TASK-001.2");

    const taskPrompt = buildPrompt(tmp.backlog, { epic: "EPIC-001", task: "TASK-001.2" });
    expect(taskPrompt).toContain("TASK-001.2");
    expect(taskPrompt).toContain("Хранить в Redis");
  });

  test("resolveBacklogDir prefers backlog subdir over root markdown files like PLAN.md", () => {
    fs.writeFileSync(path.join(tmp.root, "PLAN.md"), "# Plan\n", "utf8");
    fs.writeFileSync(path.join(tmp.root, "RECIPE.md"), "# Recipe\n", "utf8");
    expect(resolveBacklogDir({ backlogDir: tmp.root })).toBe(tmp.backlog);
  });

  test("resolveBacklogDir accepts empty backlog/ and .backlog/ directories", () => {
    const emptyProj = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-empty-bl-"));
    try {
      const bl = path.join(emptyProj, "backlog");
      fs.mkdirSync(bl);
      expect(resolveBacklogDir({ cwd: emptyProj })).toBe(bl);

      fs.rmSync(bl, { recursive: true, force: true });
      const dotBl = path.join(emptyProj, ".backlog");
      fs.mkdirSync(dotBl);
      expect(resolveBacklogDir({ cwd: emptyProj })).toBe(dotBl);
    } finally {
      fs.rmSync(emptyProj, { recursive: true, force: true });
    }
  });

  test("resolveBacklogDir discovers numbered epics in git root from nested subdir", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-git-root-"));
    try {
      fs.mkdirSync(path.join(repo, ".git"));
      fs.writeFileSync(path.join(repo, "001-root-epic.md"), "# EPIC-001 — Root\n", "utf8");
      const nested = path.join(repo, "packages", "app");
      fs.mkdirSync(nested, { recursive: true });
      expect(resolveBacklogDir({ cwd: nested })).toBe(repo);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects symlink inside backlog pointing outside backlogDir", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-outside-"));
    try {
      const outsideFile = path.join(outside, "009-secret.md");
      fs.writeFileSync(outsideFile, "# EPIC-009 — Secret\n", "utf8");
      const linkPath = path.join(tmp.backlog, "009-secret.md");
      let fileSymlinkCreated = false;
      try {
        fs.symlinkSync(outsideFile, linkPath, "file");
        fileSymlinkCreated = true;
      } catch (err) {
        if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
      }

      if (fileSymlinkCreated) {
        expect(() => listEpics(tmp.backlog)).toThrow(/escapes backlog directory/i);
        return;
      }

      // Windows without Developer Mode disallows file symlinks; verify via directory junction
      const junctionInBacklog = path.join(tmp.backlog, "009-escape.md");
      fs.symlinkSync(outside, junctionInBacklog, "junction");
      expect(() => listEpics(tmp.backlog)).toThrow(/escapes backlog directory/i);
      expect(() => resolvePinnedBacklogDir(tmp.backlog, junctionInBacklog)).toThrow(/outside configured root/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("safeWriteEpic recovers stale lockfile and leaves no lock or temp files", () => {
    const epicPath = path.join(tmp.backlog, "002-billing.md");
    const lockPath = `${epicPath}.lock`;
    fs.writeFileSync(lockPath, "99999999:0:stale-token", "utf8");
    const staleTime = new Date(Date.now() - 20_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const updated = updateEpic(tmp.backlog, "EPIC-002", { status: "done" });
    expect(updated.status).toBe("done");
    expect(fs.existsSync(lockPath)).toBe(false);
    const leftovers = fs.readdirSync(tmp.backlog).filter((n) => n.includes(".tmp.") || n.endsWith(".lock") || n.endsWith(".recover"));
    expect(leftovers).toEqual([]);
  });

  test("acquireFileLock never steals a lock owned by a live PID even when mtime is stale", () => {
    const lockPath = path.join(tmp.backlog, "live.lock");
    const liveToken = `${process.pid}:0:live-holder`;
    fs.writeFileSync(lockPath, liveToken, "utf8");
    const staleTime = new Date(Date.now() - 20_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    expect(() => acquireFileLock(lockPath, { timeoutMs: 120 })).toThrow(/timed out waiting for file lock/i);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(liveToken);
  });

  test("acquireFileLock recovers a lock owned by a dead PID", () => {
    const lockPath = path.join(tmp.backlog, "dead.lock");
    fs.writeFileSync(lockPath, "99999999:0:dead-holder", "utf8");

    const token = acquireFileLock(lockPath, { timeoutMs: 500 });
    expect(fs.readFileSync(lockPath, "utf8")).toBe(token);
    releaseFileLock(lockPath, token);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("acquireFileLock rejects dangling symlinks at lockPath and recoverPath immediately", () => {
    const createDanglingLink = (linkPath, targetPath) => {
      try {
        fs.symlinkSync(targetPath, linkPath, "file");
      } catch (err) {
        if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
        fs.symlinkSync(targetPath, linkPath, "junction");
      }
    };

    const lockPath = path.join(tmp.backlog, "dangling.lock");
    createDanglingLink(lockPath, path.join(tmp.backlog, "missing-target"));
    const start1 = Date.now();
    expect(() => acquireFileLock(lockPath, { timeoutMs: 2000 })).toThrow(/non-regular lock file/i);
    expect(Date.now() - start1).toBeLessThan(500);

    const staleLockPath = path.join(tmp.backlog, "stale-with-dangling-recover.lock");
    fs.writeFileSync(staleLockPath, "99999999:0:dead-holder", "utf8");
    createDanglingLink(`${staleLockPath}.recover`, path.join(tmp.backlog, "missing-recover-target"));
    const start2 = Date.now();
    expect(() => acquireFileLock(staleLockPath, { timeoutMs: 2000 })).toThrow(/non-regular lock file/i);
    expect(Date.now() - start2).toBeLessThan(500);
  });

  test("ownership-safe lock release does not unlink newer holder lock and safeWriteEpic aborts if lock lost", () => {
    const epicPath = path.join(tmp.backlog, "002-billing.md");
    const lockPath = `${epicPath}.lock`;

    const oldToken = acquireFileLock(lockPath);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(oldToken);

    // Simulate stale lock takeover by a newer holder
    const newerToken = "99999:12345:newer-holder";
    fs.writeFileSync(lockPath, newerToken, "utf8");

    // Old holder releasing must NOT delete newer holder's lock
    releaseFileLock(lockPath, oldToken);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(newerToken);

    // Newer holder releasing DOES delete it
    releaseFileLock(lockPath, newerToken);
    expect(fs.existsSync(lockPath)).toBe(false);

    // Simulate lock ownership loss mid-safeWriteEpic
    const originalRaw = fs.readFileSync(epicPath, "utf8");
    const origReadFileSync = fs.readFileSync.bind(fs);
    let hijacked = false;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation((target, ...args) => {
      const result = origReadFileSync(target, ...args);
      if (!hijacked && path.resolve(String(target)) === path.resolve(epicPath)) {
        hijacked = true;
        fs.writeFileSync(lockPath, newerToken, "utf8");
      }
      return result;
    });

    try {
      expect(() => safeWriteEpic(tmp.backlog, epicPath, originalRaw, `${originalRaw}\n<!-- edited -->\n`)).toThrow(
        /lost file lock/i,
      );
      expect(origReadFileSync(epicPath, "utf8")).toBe(originalRaw);
      expect(origReadFileSync(lockPath, "utf8")).toBe(newerToken);
    } finally {
      readSpy.mockRestore();
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("acquireFileLock fails closed without stealing or unlinking an existing .recover lock", () => {
    const lockPath = path.join(tmp.backlog, "recover-held.lock");
    const recoverPath = `${lockPath}.recover`;
    const staleLockContent = "99999999:0:dead-holder";
    const existingRecoverContent = "99999998:0:abandoned-recover";
    fs.writeFileSync(lockPath, staleLockContent, "utf8");
    fs.writeFileSync(recoverPath, existingRecoverContent, "utf8");
    const staleTime = new Date(Date.now() - 20_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    fs.utimesSync(recoverPath, staleTime, staleTime);

    const unlinkSpy = spyOn(fs, "unlinkSync");
    try {
      expect(() => acquireFileLock(lockPath, { timeoutMs: 80 })).toThrow(/timed out waiting for file lock/i);
      expect(fs.existsSync(recoverPath)).toBe(true);
      expect(fs.readFileSync(recoverPath, "utf8")).toBe(existingRecoverContent);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(staleLockContent);
      const recoverUnlinks = unlinkSpy.mock.calls.filter(
        ([p]) => path.resolve(String(p)) === path.resolve(recoverPath),
      );
      expect(recoverUnlinks).toHaveLength(0);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("acquireFileLock rejects oversized lock files", () => {
    const lockPath = path.join(tmp.backlog, "oversized.lock");
    fs.writeFileSync(lockPath, "x".repeat(300), "utf8");
    expect(() => acquireFileLock(lockPath, { timeoutMs: 100 })).toThrow(/exceeds maximum size/i);
  });

  test("stale lock recovery does not unlink a lock replaced by another waiter", () => {
    const lockPath = path.join(tmp.backlog, "race.lock");
    fs.writeFileSync(lockPath, "stale-token", "utf8");
    const staleTime = new Date(Date.now() - 20_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const origReadFileSync = fs.readFileSync.bind(fs);
    const origOpenSync = fs.openSync.bind(fs);
    const origReadSync = fs.readSync.bind(fs);
    const unlinkSpy = spyOn(fs, "unlinkSync");
    let replaced = false;
    let lockOpenAttempts = 0;
    let lockReadFd = null;

    const openSpy = spyOn(fs, "openSync").mockImplementation((target, flags, ...args) => {
      if (path.resolve(String(target)) === path.resolve(lockPath) && flags === "wx") {
        lockOpenAttempts += 1;
        if (lockOpenAttempts === 2) {
          // Verify stale recovery did NOT unlink the fresh lock before this retry
          const lockUnlinks = unlinkSpy.mock.calls.filter(
            ([p]) => path.resolve(String(p)) === path.resolve(lockPath),
          );
          expect(lockUnlinks).toHaveLength(0);
          expect(origReadFileSync(lockPath, "utf8")).toBe("fresh-token");
          fs.rmSync(lockPath, { force: true });
        }
        return origOpenSync(target, flags, ...args);
      }
      const fd = origOpenSync(target, flags, ...args);
      if (path.resolve(String(target)) === path.resolve(lockPath)) {
        lockReadFd = fd;
      }
      return fd;
    });

    const readSyncSpy = spyOn(fs, "readSync").mockImplementation((fd, buf, offset, length, position) => {
      const bytesRead = origReadSync(fd, buf, offset, length, position);
      if (
        !replaced &&
        fd === lockReadFd &&
        bytesRead > 0 &&
        buf.subarray(offset, offset + bytesRead).toString("utf8") === "stale-token"
      ) {
        replaced = true;
        fs.writeFileSync(lockPath, "fresh-token", "utf8");
      }
      return bytesRead;
    });

    try {
      const token = acquireFileLock(lockPath);
      expect(replaced).toBe(true);
      expect(lockOpenAttempts).toBe(2);
      expect(origReadFileSync(lockPath, "utf8")).toBe(token);
      releaseFileLock(lockPath, token);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      readSyncSpy.mockRestore();
      openSpy.mockRestore();
      unlinkSpy.mockRestore();
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("concurrent createEpic calls produce distinct sequential epic numbers", async () => {
    const backlogModuleUrl = new URL("../mcp/backlog.js", import.meta.url).href;
    const runWorker = (title) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { createEpic } from ${JSON.stringify(backlogModuleUrl)};
           const res = createEpic(${JSON.stringify(tmp.backlog)}, { title: ${JSON.stringify(title)} });
           console.log(JSON.stringify({ id: res.id, number: res.number, filename: res.filename }));`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

    const p1 = runWorker("Concurrent Alpha");
    const p2 = runWorker("Concurrent Beta");
    const [code1, code2, out1, out2, err1, err2] = await Promise.all([
      p1.exited,
      p2.exited,
      new Response(p1.stdout).text(),
      new Response(p2.stdout).text(),
      new Response(p1.stderr).text(),
      new Response(p2.stderr).text(),
    ]);

    expect({ code1, err1 }).toEqual({ code1: 0, err1: "" });
    expect({ code2, err2 }).toEqual({ code2: 0, err2: "" });

    const r1 = JSON.parse(out1.trim());
    const r2 = JSON.parse(out2.trim());
    const ids = [r1.id, r2.id].sort();
    expect(ids).toEqual(["EPIC-003", "EPIC-004"]);

    const epics = listEpics(tmp.backlog);
    expect(epics.map((e) => e.id)).toEqual(["EPIC-001", "EPIC-002", "EPIC-003", "EPIC-004"]);
    const leftovers = fs.readdirSync(tmp.backlog).filter((n) => n.includes(".tmp.") || n.endsWith(".lock") || n.endsWith(".recover"));
    expect(leftovers).toEqual([]);
  });

  test("atomicWriteFile and safeWriteEpic preserve existing file permissions and ACLs", () => {
    const epicPath = path.join(tmp.backlog, "002-billing.md");
    const raw = fs.readFileSync(epicPath, "utf8");

    if (process.platform === "win32") {
      const grant = Bun.spawnSync(["icacls", epicPath, "/grant", "*S-1-1-0:R"]);
      expect(grant.exitCode).toBe(0);
      const aclBefore = Bun.spawnSync(["icacls", epicPath]).stdout.toString();

      const origExecFileSync = childProcess.execFileSync.bind(childProcess);
      const origWriteFileSync = fs.writeFileSync.bind(fs);
      const events = [];
      const execSpy = spyOn(childProcess, "execFileSync").mockImplementation((cmd, args, opts) => {
        if (
          String(cmd).toLowerCase().includes("icacls") &&
          Array.isArray(args) &&
          String(args[0]).includes(".tmp.") &&
          args.includes("/inheritance:r")
        ) {
          events.push(`icacls:${path.basename(String(args[0]))}`);
        }
        return origExecFileSync(cmd, args, opts);
      });
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((target, data, ...rest) => {
        if (typeof target === "number" && data === `${raw}\n`) {
          events.push("write-content");
        }
        return origWriteFileSync(target, data, ...rest);
      });

      try {
        safeWriteEpic(tmp.backlog, epicPath, raw, `${raw}\n`);
      } finally {
        execSpy.mockRestore();
        writeSpy.mockRestore();
      }

      expect(events.length).toBeGreaterThanOrEqual(2);
      const icaclsIdx = events.findIndex((e) => e.startsWith("icacls:"));
      const writeIdx = events.indexOf("write-content");
      expect(icaclsIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeGreaterThan(icaclsIdx);

      const aclAfter = Bun.spawnSync(["icacls", epicPath]).stdout.toString();
      expect(aclAfter).toBe(aclBefore);
      expect(fs.readFileSync(epicPath, "utf8")).toBe(`${raw}\n`);

      const newFile = path.join(tmp.backlog, "003-new.md");
      atomicWriteFile(newFile, "# EPIC-003 — New\n");
      expect(fs.readFileSync(newFile, "utf8")).toBe("# EPIC-003 — New\n");
      return;
    }

    fs.chmodSync(epicPath, 0o640);
    const expectedMode = fs.statSync(epicPath).mode & 0o777;
    const chmodSpy = spyOn(fs, "chmodSync");

    try {
      safeWriteEpic(tmp.backlog, epicPath, raw, `${raw}\n`);
      expect(chmodSpy).toHaveBeenCalled();
      const [tmpArg, modeArg] = chmodSpy.mock.calls[0];
      expect(String(tmpArg)).toContain(".tmp.");
      expect(modeArg).toBe(expectedMode);
      expect(fs.statSync(epicPath).mode & 0o777).toBe(0o640);

      // Direct atomicWriteFile on a new file does not call chmodSync
      chmodSpy.mockClear();
      const newFile = path.join(tmp.backlog, "003-new.md");
      atomicWriteFile(newFile, "# EPIC-003 — New\n");
      expect(chmodSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(newFile, "utf8")).toBe("# EPIC-003 — New\n");
    } finally {
      chmodSpy.mockRestore();
    }
  });

  test("createEpic and addTask reject CR/LF in single-line fields while allowing multiline goal", () => {
    expect(() => createEpic(tmp.backlog, { title: "Line1\nLine2" })).toThrow(/single line/i);
    expect(() => createEpic(tmp.backlog, { title: "Line1\r" })).toThrow(/single line/i);
    expect(() => createEpic(tmp.backlog, { title: "Valid", project: "Proj\nInject" })).toThrow(/single line/i);
    expect(() => createEpic(tmp.backlog, { title: "Valid", firstTask: "Task\r\nInject" })).toThrow(/single line/i);
    expect(() => addTask(tmp.backlog, { epic: "EPIC-001", title: "Task\n- [x] Fake" })).toThrow(/single line/i);

    const created = createEpic(tmp.backlog, {
      title: "Multiline Goal Epic",
      goal: "Line 1\nLine 2",
    });
    expect(created.goal).toContain("Line 1\nLine 2");
  });
});
