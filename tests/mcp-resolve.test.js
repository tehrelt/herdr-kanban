import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CliConfigError,
  parseCliConfig,
  defaultGitTopLevel,
  createBacklogResolver,
  resolveBacklogDir,
  listEpicFiles,
  resolveSafeEpicPath,
} from "../mcp/backlog-server/resolve-backlog.js";
import { BacklogError } from "../mcp/backlog-server/errors.js";

const tempDirs = [];

async function makeTempDir(prefix = "herdr-mcp-resolve-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function tryCreateFileSymlink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, "file");
    return true;
  } catch (err) {
    if (err?.code === "EPERM" || err?.code === "ENOTSUP" || err?.code === "EACCES") {
      return false;
    }
    throw err;
  }
}

async function tryCreateDirLink(target, linkPath) {
  const type = process.platform === "win32" ? "junction" : "dir";
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    if (err?.code === "EPERM" || err?.code === "ENOTSUP" || err?.code === "EACCES") {
      return false;
    }
    throw err;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("parseCliConfig", () => {
  test("defaults to auto mode when no CLI flag or env var is provided", () => {
    expect(parseCliConfig([], {})).toEqual({
      mode: "auto",
      source: "auto",
      rawDir: null,
    });
    expect(parseCliConfig([], { HERDR_BACKLOG_DIR: undefined })).toEqual({
      mode: "auto",
      source: "auto",
      rawDir: null,
    });
  });

  test("parses --backlog-dir <dir> and --backlog-dir=<dir> and trims whitespace", () => {
    expect(parseCliConfig(["--backlog-dir", "  ./backlog  "], {})).toEqual({
      mode: "explicit",
      source: "cli",
      rawDir: "./backlog",
    });
    expect(parseCliConfig(["--backlog-dir=  /tmp/backlog  "], {})).toEqual({
      mode: "explicit",
      source: "cli",
      rawDir: "/tmp/backlog",
    });
  });

  test("parses HERDR_BACKLOG_DIR and enforces priority --backlog-dir > HERDR_BACKLOG_DIR > auto", () => {
    expect(parseCliConfig([], { HERDR_BACKLOG_DIR: "  ~/work/backlog  " })).toEqual({
      mode: "explicit",
      source: "env",
      rawDir: "~/work/backlog",
    });
    expect(
      parseCliConfig(["--backlog-dir", "/cli/backlog"], { HERDR_BACKLOG_DIR: "/env/backlog" }),
    ).toEqual({
      mode: "explicit",
      source: "cli",
      rawDir: "/cli/backlog",
    });
  });

  test("rejects duplicate --backlog-dir flags", () => {
    for (const argv of [
      ["--backlog-dir", "a", "--backlog-dir", "b"],
      ["--backlog-dir=a", "--backlog-dir=b"],
      ["--backlog-dir", "a", "--backlog-dir=b"],
    ]) {
      expect(() => parseCliConfig(argv, {})).toThrow(CliConfigError);
      try {
        parseCliConfig(argv, {});
      } catch (err) {
        expect(err.code).toBe("INVALID_ARGUMENT");
        expect(err.details).toEqual({ field: "backlogDir" });
      }
    }
  });

  test("rejects missing or empty --backlog-dir and empty HERDR_BACKLOG_DIR", () => {
    const badArgvs = [
      ["--backlog-dir"],
      ["--backlog-dir", ""],
      ["--backlog-dir", "   "],
      ["--backlog-dir="],
      ["--backlog-dir=   "],
      ["--backlog-dir", "--backlog-dir", "x"],
      ["--backlog-dir", "--backlog-dir=x"],
    ];
    for (const argv of badArgvs) {
      expect(() => parseCliConfig(argv, {})).toThrow(CliConfigError);
    }
    for (const env of [{ HERDR_BACKLOG_DIR: "" }, { HERDR_BACKLOG_DIR: "   " }]) {
      expect(() => parseCliConfig([], env)).toThrow(CliConfigError);
    }
  });

  test("rejects unknown flags, positional args, NUL bytes, and invalid argv types", () => {
    for (const argv of [
      ["--unknown"],
      ["-b"],
      ["positional/dir"],
      ["--backlog-dir", "bad\0dir"],
      ["--backlog-dir=bad\0dir"],
      [123],
    ]) {
      expect(() => parseCliConfig(argv, {})).toThrow(CliConfigError);
    }
    expect(() => parseCliConfig("not-an-array", {})).toThrow(CliConfigError);
    expect(() => parseCliConfig([], { HERDR_BACKLOG_DIR: "bad\0env" })).toThrow(CliConfigError);
  });
});

describe("createBacklogResolver and resolveBacklogDir — explicit mode", () => {
  test("resolves existing explicit directory including empty directory", async () => {
    const root = await makeTempDir();
    const emptyBacklog = path.join(root, "empty-backlog");
    await fs.mkdir(emptyBacklog);

    const resolved = await resolveBacklogDir({
      argv: ["--backlog-dir", emptyBacklog],
      env: {},
      cwd: root,
      gitTopLevelFn: async () => null,
    });

    expect(resolved).toEqual({
      backlogDir: await fs.realpath(emptyBacklog),
      projectRoot: path.resolve(await fs.realpath(root)),
      mode: "explicit",
      source: "cli",
    });
  });

  test("rejects missing explicit directory with BACKLOG_NOT_FOUND without falling back to auto", async () => {
    const root = await makeTempDir();
    const autoBacklog = path.join(root, "backlog");
    await fs.mkdir(autoBacklog);
    await fs.writeFile(path.join(autoBacklog, "001-init.md"), "# EPIC-001 — Init\n", "utf8");

    const missing = path.join(root, "does-not-exist");
    await expect(
      resolveBacklogDir({
        argv: ["--backlog-dir", missing],
        env: {},
        cwd: root,
        gitTopLevelFn: async () => null,
      }),
    ).rejects.toMatchObject({
      name: "BacklogError",
      code: "BACKLOG_NOT_FOUND",
    });
  });

  test("rejects file path passed as explicit backlog directory with NOT_DIRECTORY", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "not-a-dir.md");
    await fs.writeFile(filePath, "# file\n", "utf8");

    await expect(
      resolveBacklogDir({
        argv: [],
        env: { HERDR_BACKLOG_DIR: filePath },
        cwd: root,
        gitTopLevelFn: async () => null,
      }),
    ).rejects.toMatchObject({
      name: "BacklogError",
      code: "NOT_DIRECTORY",
    });
  });

  test("expands ~ and ~/ against homeDir and resolves relative paths from cwd", async () => {
    const root = await makeTempDir();
    const fakeHome = path.join(root, "home");
    const homeBacklog = path.join(fakeHome, "my-backlog");
    const cwdDir = path.join(root, "workspace");
    const relBacklog = path.join(cwdDir, "nested", "tasks");
    await fs.mkdir(homeBacklog, { recursive: true });
    await fs.mkdir(relBacklog, { recursive: true });

    const tildeOnly = await resolveBacklogDir({
      argv: ["--backlog-dir", "~"],
      env: {},
      cwd: cwdDir,
      homeDir: fakeHome,
      gitTopLevelFn: async () => null,
    });
    expect(tildeOnly.backlogDir).toBe(await fs.realpath(fakeHome));

    const tildeSub = await resolveBacklogDir({
      argv: ["--backlog-dir", "~/my-backlog"],
      env: {},
      cwd: cwdDir,
      homeDir: fakeHome,
      gitTopLevelFn: async () => null,
    });
    expect(tildeSub.backlogDir).toBe(await fs.realpath(homeBacklog));

    const relative = await resolveBacklogDir({
      argv: ["--backlog-dir", "./nested/tasks"],
      env: {},
      cwd: cwdDir,
      homeDir: fakeHome,
      gitTopLevelFn: async () => null,
    });
    expect(relative.backlogDir).toBe(await fs.realpath(relBacklog));

    await expect(
      resolveBacklogDir({
        argv: ["--backlog-dir", "~/my-backlog"],
        env: {},
        cwd: cwdDir,
        homeDir: "",
        gitTopLevelFn: async () => null,
      }),
    ).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });
  });
});

describe("createBacklogResolver and resolveBacklogDir — auto mode", () => {
  test("checks <cwd>/backlog, <cwd>/docs/backlog, <cwd>/.backlog in priority order", async () => {
    const root = await makeTempDir();
    const b1 = path.join(root, "backlog");
    const b2 = path.join(root, "docs", "backlog");
    const b3 = path.join(root, ".backlog");
    await fs.mkdir(b1, { recursive: true });
    await fs.mkdir(b2, { recursive: true });
    await fs.mkdir(b3, { recursive: true });

    await fs.writeFile(path.join(b3, "001-dot.md"), "# EPIC-001 — Dot\n", "utf8");
    let res = await resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null });
    expect(res.backlogDir).toBe(await fs.realpath(b3));
    expect(res.mode).toBe("auto");
    expect(res.source).toBe("auto");

    await fs.writeFile(path.join(b2, "001-docs.md"), "# EPIC-001 — Docs\n", "utf8");
    res = await resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null });
    expect(res.backlogDir).toBe(await fs.realpath(b2));

    await fs.writeFile(path.join(b1, "001-main.md"), "# EPIC-001 — Main\n", "utf8");
    res = await resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null });
    expect(res.backlogDir).toBe(await fs.realpath(b1));
  });

  test("accepts named /backlog with only README.md, while .backlog requires an epic file", async () => {
    const root = await makeTempDir();
    const dotBacklog = path.join(root, ".backlog");
    await fs.mkdir(dotBacklog);
    await fs.writeFile(path.join(dotBacklog, "README.md"), "# Guide\n", "utf8");

    await expect(
      resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null }),
    ).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });

    const namedBacklog = path.join(root, "backlog");
    await fs.mkdir(namedBacklog);
    await fs.writeFile(path.join(namedBacklog, "README.md"), "# Guide\n", "utf8");

    const res = await resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null });
    expect(res.backlogDir).toBe(await fs.realpath(namedBacklog));
  });

  test("checks git top-level candidates when gitTopLevelFn returns a different root", async () => {
    const repoRoot = await makeTempDir();
    const subCwd = path.join(repoRoot, "packages", "app");
    const topDocsBacklog = path.join(repoRoot, "docs", "backlog");
    await fs.mkdir(subCwd, { recursive: true });
    await fs.mkdir(topDocsBacklog, { recursive: true });
    await fs.writeFile(path.join(topDocsBacklog, "001-top.md"), "# EPIC-001 — Top\n", "utf8");

    const res = await resolveBacklogDir({
      argv: [],
      env: {},
      cwd: subCwd,
      gitTopLevelFn: async () => repoRoot,
    });
    expect(res.backlogDir).toBe(await fs.realpath(topDocsBacklog));
    expect(res.projectRoot).toBe(path.resolve(repoRoot));
  });

  test("handles gitTopLevelFn errors gracefully", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "001-root.md"), "# EPIC-001 — Root\n", "utf8");

    const res = await resolveBacklogDir({
      argv: [],
      env: {},
      cwd: root,
      gitTopLevelFn: async () => {
        throw new Error("git failed");
      },
    });
    expect(res.backlogDir).toBe(await fs.realpath(root));
  });

  test("accepts <cwd> strictly only when isNumberedEpicFilename matches", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "README.md"), "# Readme\n", "utf8");
    await fs.writeFile(path.join(root, "notes.md"), "# Notes\n", "utf8");

    await expect(
      resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null }),
    ).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });

    await fs.writeFile(path.join(root, "001-bootstrap.md"), "# EPIC-001 — Boot\n", "utf8");
    const res = await resolveBacklogDir({ argv: [], env: {}, cwd: root, gitTopLevelFn: async () => null });
    expect(res.backlogDir).toBe(await fs.realpath(root));
  });

  test("deduplicates canonical paths across symlinked/junctioned candidates", async () => {
    const root = await makeTempDir();
    const realRepo = path.join(root, "real-repo");
    const realBacklog = path.join(realRepo, "backlog");
    const aliasRepo = path.join(root, "alias-repo");
    await fs.mkdir(realBacklog, { recursive: true });
    await fs.mkdir(aliasRepo, { recursive: true });

    const linked = await tryCreateDirLink(realBacklog, path.join(aliasRepo, "backlog"));
    if (!linked) return;

    let statCalls = 0;
    const origStat = fs.stat;
    const spyStat = async (p, ...rest) => {
      if (String(p).endsWith("backlog")) statCalls++;
      return origStat.call(fs, p, ...rest);
    };
    fs.stat = spyStat;
    try {
      await expect(
        resolveBacklogDir({
          argv: [],
          env: {},
          cwd: aliasRepo,
          gitTopLevelFn: async () => realRepo,
        }),
      ).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });
    } finally {
      fs.stat = origStat;
    }
    expect(statCalls).toBeGreaterThanOrEqual(2);

    await fs.writeFile(path.join(realBacklog, "001-shared.md"), "# EPIC-001 — Shared\n", "utf8");
    const res = await resolveBacklogDir({
      argv: [],
      env: {},
      cwd: aliasRepo,
      gitTopLevelFn: async () => realRepo,
    });
    expect(res.backlogDir).toBe(await fs.realpath(realBacklog));
  });

  test("pins resolved directory, re-resolves after initial BACKLOG_NOT_FOUND, and errors if pinned dir disappears", async () => {
    const root = await makeTempDir();
    const docsBacklog = path.join(root, "docs", "backlog");
    const mainBacklog = path.join(root, "backlog");

    const resolver = createBacklogResolver({
      argv: [],
      env: {},
      cwd: root,
      gitTopLevelFn: async () => null,
    });

    expect(resolver.getPinned()).toBeNull();
    await expect(resolver.resolve()).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });
    expect(resolver.getPinned()).toBeNull();

    await fs.mkdir(docsBacklog, { recursive: true });
    await fs.writeFile(path.join(docsBacklog, "001-docs.md"), "# EPIC-001 — Docs\n", "utf8");

    const first = await resolver.resolve();
    expect(first.backlogDir).toBe(await fs.realpath(docsBacklog));
    expect(resolver.getPinned()).toBe(first);

    await fs.mkdir(mainBacklog, { recursive: true });
    await fs.writeFile(path.join(mainBacklog, "001-main.md"), "# EPIC-001 — Main\n", "utf8");
    const second = await resolver.resolve();
    expect(second).toBe(first);
    expect(second.backlogDir).toBe(first.backlogDir);

    await fs.rm(docsBacklog, { recursive: true, force: true });
    await expect(resolver.resolve()).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });
  });

  test("throws UNSAFE_PATH if pinned directory is replaced by a link to another directory", async () => {
    const root = await makeTempDir();
    const backlog = path.join(root, "backlog");
    const other = path.join(root, "other");
    await fs.mkdir(backlog);
    await fs.mkdir(other);
    await fs.writeFile(path.join(backlog, "001-a.md"), "# EPIC-001 — A\n", "utf8");

    const resolver = createBacklogResolver({
      argv: ["--backlog-dir", backlog],
      env: {},
      cwd: root,
      gitTopLevelFn: async () => null,
    });
    await resolver.resolve();

    await fs.rm(backlog, { recursive: true, force: true });
    const linked = await tryCreateDirLink(other, backlog);
    if (!linked) return;

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  test("defaultGitTopLevel returns null for non-git dir and repo root for git repo", async () => {
    const nonGit = await makeTempDir();
    expect(await defaultGitTopLevel(nonGit)).toBeNull();
    expect(await defaultGitTopLevel("")).toBeNull();

    const repoTop = await defaultGitTopLevel(path.resolve(import.meta.dir, ".."));
    expect(typeof repoTop).toBe("string");
    expect(repoTop.toLowerCase()).toContain("herdr-kanban");
  });
});

describe("listEpicFiles and resolveSafeEpicPath", () => {
  test("listEpicFiles returns sorted epic files and ignores README, CURRENT, subdirs, and symlinks/junctions", async () => {
    const root = await makeTempDir();
    const backlog = path.join(root, "backlog");
    const outside = path.join(root, "outside");
    await fs.mkdir(backlog);
    await fs.mkdir(outside);

    await fs.writeFile(path.join(backlog, "002-second.md"), "# EPIC-002\n", "utf8");
    await fs.writeFile(path.join(backlog, "001-first.md"), "# EPIC-001\n", "utf8");
    await fs.writeFile(path.join(backlog, "README.md"), "# Guide\n", "utf8");
    await fs.writeFile(path.join(backlog, "CURRENT.md"), "# Current\n", "utf8");
    await fs.writeFile(path.join(backlog, "notes.txt"), "ignore\n", "utf8");
    await fs.mkdir(path.join(backlog, "003-subdir.md"));

    const outsideFile = path.join(outside, "004-secret.md");
    await fs.writeFile(outsideFile, "# EPIC-004\n", "utf8");
    await tryCreateFileSymlink(outsideFile, path.join(backlog, "004-symlink.md"));
    await tryCreateDirLink(outside, path.join(backlog, "005-junction.md"));

    const files = await listEpicFiles(backlog);
    expect(files).toEqual(["001-first.md", "002-second.md"]);
  });

  test("listEpicFiles validates backlogDir", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "file.md");
    await fs.writeFile(filePath, "x", "utf8");

    await expect(listEpicFiles("")).rejects.toMatchObject({ code: "BACKLOG_NOT_FOUND" });
    await expect(listEpicFiles(path.join(root, "missing"))).rejects.toMatchObject({
      code: "BACKLOG_NOT_FOUND",
    });
    await expect(listEpicFiles(filePath)).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
  });

  test("resolveSafeEpicPath accepts valid epic filenames and enforces mustExist", async () => {
    const root = await makeTempDir();
    const backlog = path.join(root, "backlog");
    await fs.mkdir(backlog);
    const existing = path.join(backlog, "001-alpha.md");
    await fs.writeFile(existing, "# EPIC-001\n", "utf8");

    const resolvedExisting = await resolveSafeEpicPath(backlog, "001-alpha.md", { mustExist: true });
    expect(resolvedExisting).toBe(path.join(await fs.realpath(backlog), "001-alpha.md"));

    const resolvedNew = await resolveSafeEpicPath(backlog, "002-beta.md", { mustExist: false });
    expect(resolvedNew).toBe(path.join(await fs.realpath(backlog), "002-beta.md"));

    await expect(
      resolveSafeEpicPath(backlog, "002-beta.md", { mustExist: true }),
    ).rejects.toMatchObject({
      name: "BacklogError",
      code: "EPIC_NOT_FOUND",
      details: { filename: "002-beta.md" },
    });
  });

  test("resolveSafeEpicPath rejects path traversal, separators, control chars, and non-epic filenames", async () => {
    const root = await makeTempDir();
    const backlog = path.join(root, "backlog");
    await fs.mkdir(backlog);

    const unsafeNames = [
      "",
      ".",
      "..",
      "../001-a.md",
      "sub/001-a.md",
      "sub\\001-a.md",
      "C:001-a.md",
      "001-a.md\0.txt",
      "001-a\n.md",
      "001-a\r.md",
      "001-a\x1f.md",
      "001-a\x7f.md",
      "README.md",
      "CURRENT.md",
      "notes.txt",
    ];

    for (const name of unsafeNames) {
      await expect(resolveSafeEpicPath(backlog, name)).rejects.toMatchObject({
        name: "BacklogError",
        code: "UNSAFE_PATH",
      });
    }
  });

  test("resolveSafeEpicPath rejects symlinked .md files and directory junctions", async () => {
    const root = await makeTempDir();
    const backlog = path.join(root, "backlog");
    const outside = path.join(root, "outside");
    await fs.mkdir(backlog);
    await fs.mkdir(outside);

    const outsideFile = path.join(outside, "009-outside.md");
    await fs.writeFile(outsideFile, "# EPIC-009\n", "utf8");

    const junctionPath = path.join(backlog, "008-junction.md");
    if (await tryCreateDirLink(outside, junctionPath)) {
      await expect(resolveSafeEpicPath(backlog, "008-junction.md")).rejects.toMatchObject({
        code: "UNSAFE_PATH",
      });
    }

    const symlinkPath = path.join(backlog, "009-link.md");
    if (await tryCreateFileSymlink(outsideFile, symlinkPath)) {
      await expect(resolveSafeEpicPath(backlog, "009-link.md")).rejects.toMatchObject({
        code: "UNSAFE_PATH",
      });
      await expect(
        resolveSafeEpicPath(backlog, "009-link.md", { mustExist: true }),
      ).rejects.toMatchObject({
        code: "UNSAFE_PATH",
      });
    }
  });
});
