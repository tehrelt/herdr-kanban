import { describe, expect, test } from "bun:test";
import {
  normPath,
  joinPath,
  parentDir,
  resolveInitTargetDir,
  expandTilde,
  parseRemoteDirOutput,
  normalizeRecentEntries,
  filterRecentForMachine,
  addRecentEntry,
} from "../mods/kanban/paths.js";

describe("path helpers", () => {
  test("normPath normalizes slashes and preserves roots", () => {
    expect(normPath("/home/user/repo/")).toBe("/home/user/repo");
    expect(normPath("/")).toBe("/");
    expect(normPath("C:\\Users\\dev\\")).toBe("C:/Users/dev");
    expect(normPath("C:\\")).toBe("C:/");
    expect(normPath("C:/")).toBe("C:/");
    expect(normPath("   ")).toBeNull();
    expect(normPath(null)).toBeNull();
  });

  test("joinPath joins POSIX and Windows roots cleanly", () => {
    expect(joinPath("/", "srv")).toBe("/srv");
    expect(joinPath("/srv/app", "backlog")).toBe("/srv/app/backlog");
    expect(joinPath("C:/", "Users")).toBe("C:/Users");
    expect(joinPath("C:/repo", "backlog")).toBe("C:/repo/backlog");
  });

  test("parentDir handles POSIX root, top-level dirs, and Windows drives", () => {
    expect(parentDir("/")).toBe("/");
    expect(parentDir("/home")).toBe("/");
    expect(parentDir("/home/user/repo")).toBe("/home/user");
    expect(parentDir("C:/")).toBe("C:/");
    expect(parentDir("C:/Users")).toBe("C:/");
    expect(parentDir("C:/Users/dev")).toBe("C:/Users");
  });

  test("expandTilde expands ~ and ~/ against homeDir", () => {
    expect(expandTilde("~", "/home/alice")).toBe("/home/alice");
    expect(expandTilde("~/repo/backlog", "/home/alice/")).toBe("/home/alice/repo/backlog");
    expect(expandTilde("/srv/app", "/home/alice")).toBe("/srv/app");
    expect(expandTilde("~/repo", null)).toBe("~/repo");
  });

  test("resolveInitTargetDir appends backlog unless already backlog/.backlog", () => {
    expect(resolveInitTargetDir("C:\\repo\\app\\")).toBe("C:/repo/app/backlog");
    expect(resolveInitTargetDir("/srv/app/backlog")).toBe("/srv/app/backlog");
    expect(resolveInitTargetDir("/srv/app/.backlog/")).toBe("/srv/app/.backlog");
    expect(resolveInitTargetDir(null)).toBeNull();
  });
});

describe("parseRemoteDirOutput", () => {
  test("parses NUL-delimited directory listing and prioritizes backlog folders", () => {
    const stdout = [
      "DIR", "/srv/app",
      "D", "src",
      "D", ".config",
      "D", "backlog",
      "D", "docs",
      "M", "002-api.md",
      "M", "001-init.md",
    ].join("\0") + "\0";

    const parsed = parseRemoteDirOutput(stdout, "/srv/app");
    expect(parsed.dir).toBe("/srv/app");
    expect(parsed.dirs).toEqual(["backlog", "docs", "src", ".config"]);
    expect(parsed.mdFiles).toEqual(["001-init.md", "002-api.md"]);
  });
});

describe("recent folders per machine", () => {
  test("normalizes legacy strings and filters by machine", () => {
    const raw = [
      "C:/Users/dev/repo/backlog",
      { dir: "/srv/app/backlog", on: "prod-box" },
      { dir: "/home/alice/work/backlog", on: "dev-box" },
      "C:/Users/dev/repo/backlog/",
    ];

    const normalized = normalizeRecentEntries(raw);
    expect(normalized).toEqual([
      { dir: "C:/Users/dev/repo/backlog", on: null },
      { dir: "/srv/app/backlog", on: "prod-box" },
      { dir: "/home/alice/work/backlog", on: "dev-box" },
    ]);

    expect(filterRecentForMachine(normalized, null)).toEqual([
      { dir: "C:/Users/dev/repo/backlog", on: null },
    ]);
    expect(filterRecentForMachine(normalized, "prod-box")).toEqual([
      { dir: "/srv/app/backlog", on: "prod-box" },
    ]);
  });

  test("addRecentEntry prepends and deduplicates per machine", () => {
    let list = addRecentEntry([], "/srv/a/backlog", "vps");
    list = addRecentEntry(list, "C:/local/backlog", null);
    list = addRecentEntry(list, "/srv/a/backlog/", "vps");
    expect(list).toEqual([
      { dir: "/srv/a/backlog", on: "vps" },
      { dir: "C:/local/backlog", on: null },
    ]);
  });
});
