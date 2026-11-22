import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  agents,
  terminals,
  exec,
  hc,
  readTextFile,
  writeTextFile,
  watchFolder,
  pickFolder,
  knownAgents,
  run,
  closeOverlay,
  notify,
  theme,
  props,
  nextCommand,
  checking,
  window,
  shared,
  setShared,
  settings,
} from "herdr";
import {
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
} from "./parser.js";
import {
  renderToolbar,
  renderNewEpicBar,
  renderLoadingState,
  renderEmptyState,
  renderBoard,
  renderContextMenu,
} from "./board.js";
import { renderDetail } from "./detail.js";

const STORAGE_FOLDERS = "kanban.folders";
const STORAGE_RECENT = "kanban.recent";
const STORAGE_MODE = "kanban.mode";
const STORAGE_AGENT = "kanban.agent";

function normPath(p) {
  if (!p || typeof p !== "string") return null;
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function joinPath(dir, name) {
  const base = normPath(dir);
  if (!base) return name;
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function parentDir(dir) {
  const p = normPath(dir);
  if (!p) return null;
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return p;
  if (idx === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
  return p.slice(0, idx);
}

function readShared(key, fallback) {
  const val = shared(key);
  if (val !== undefined && val !== null) return val;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    if (key === STORAGE_MODE || key === STORAGE_AGENT) return raw;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function listMarkdownFiles(dir, on) {
  const cleanDir = normPath(dir);
  if (!cleanDir) return null;

  const runPowerShell = async () => {
    const escaped = cleanDir.replace(/['‘’‚‛]/g, "$&$&");
    const script =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      "& { param($p) if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 2 }; " +
      "ConvertTo-Json -Compress -InputObject @(Get-ChildItem -LiteralPath $p -File -Filter '*.md' -ErrorAction Stop | Select-Object -ExpandProperty Name) } " +
      `'${escaped}'`;
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
    if (r.code !== 0) return null;
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  };

  if (!on && window()?.platform === "windows") {
    return runPowerShell();
  }

  const shScript =
    'test -d "$1" || exit 2; for p in "$1"/*.md "$1"/*.MD; do [ -f "$p" ] || continue; printf "%s\\0" "${p##*/}"; done';
  try {
    const r = await exec("sh", ["-c", shScript, "kanban", cleanDir], { on });
    if (r.code !== 0) return null;
    return r.stdout.split("\0").filter(Boolean);
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) {
      return runPowerShell();
    }
    return null;
  }
}

async function gitTopLevel(cwd, on) {
  if (!cwd) return null;
  try {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (r.code !== 0) return null;
    return normPath(r.stdout.trim());
  } catch {
    return null;
  }
}

export default class Kanban extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.size = null;
    this.epics = [];
    this.backlogDir = null;
    this.projectRoot = null;
    this.overrideFolder = null;
    this.on = null;
    this.readOnly = false;
    this.loading = false;
    this.writing = false;
    this.error = null;
    this.contextKey = null;

    const propMode = props()?.mode;
    const savedMode = readShared(STORAGE_MODE, "epics");
    this.mode =
      propMode === "tasks" || propMode === "epics"
        ? propMode
        : savedMode === "tasks"
          ? "tasks"
          : "epics";
    this.priorityFilter = "ALL";
    this.query = "";
    this.columnLimits = {};

    this.selectedEpicFile = null;
    this.selectedTaskLine = null;
    this.hoveredCard = null;
    this.hoveredTask = null;
    this.drag = null;
    this.dragOverCol = null;
    this.justDragged = false;
    this.pendingMenu = null;
    this.contextMenu = null;

    this.creatingEpic = false;
    this.newEpicPriority = "P1";
    this.agentPickerOpen = false;
    this.knownAgentsList = [];
    this.extraInstalledKeys = new Set();
    const savedAgent = readShared(STORAGE_AGENT, null);
    this.selectedAgentKey = typeof savedAgent === "string" && savedAgent ? savedAgent : null;

    const savedFolders = readShared(STORAGE_FOLDERS, {});
    this.spaceFolders =
      savedFolders && typeof savedFolders === "object" && !Array.isArray(savedFolders) ? savedFolders : {};
    const savedRecent = readShared(STORAGE_RECENT, []);
    this.recentFolders = Array.isArray(savedRecent) ? savedRecent : [];

    this.searchFocused = false;
    this.searchInput = InputState.new({ placeholder: "Поиск…" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });

    this.newTaskFocused = false;
    this.newTaskInput = InputState.new({ placeholder: "Добавить задачу… (Enter)" });
    this.newTaskInput.on("submit", (_e, cx) => {
      const epic = this.selectedEpic();
      if (epic) this.submitNewTask(epic, cx);
    });
    this.newTaskInput.on("focus", (_e, cx) => {
      this.newTaskFocused = true;
      cx.notify();
    });
    this.newTaskInput.on("blur", (_e, cx) => {
      this.newTaskFocused = false;
      cx.notify();
    });

    this.newEpicTitleFocused = false;
    this.newEpicTitleInput = InputState.new({ placeholder: "Название эпика (например: Auth UI)" });
    this.newEpicTitleInput.on("submit", (_e, cx) => this.submitNewEpic(cx));
    this.newEpicTitleInput.on("focus", (_e, cx) => {
      this.newEpicTitleFocused = true;
      cx.notify();
    });
    this.newEpicTitleInput.on("blur", (_e, cx) => {
      this.newEpicTitleFocused = false;
      cx.notify();
    });

    this.newEpicTaskFocused = false;
    this.newEpicTaskInput = InputState.new({ placeholder: "Первая задача (необязательно)" });
    this.newEpicTaskInput.on("submit", (_e, cx) => this.submitNewEpic(cx));
    this.newEpicTaskInput.on("focus", (_e, cx) => {
      this.newEpicTaskFocused = true;
      cx.notify();
    });
    this.newEpicTaskInput.on("blur", (_e, cx) => {
      this.newEpicTaskFocused = false;
      cx.notify();
    });

    this.watchHandle = null;
    this.watchedDir = null;

    if (this.isOverlay()) {
      this.handle.focus();
    }

    if (checking()) return;

    this.refresh(cx, true);
    this.loadAgents(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx, false));

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "refresh") {
          this.refresh(cx, true);
        } else if (cmd === "mode-epics") {
          this.setMode("epics", cx);
        } else if (cmd === "mode-tasks") {
          this.setMode("tasks", cx);
        } else if (cmd === "new-epic") {
          this.toggleCreateEpic(cx);
        } else if (cmd === "close-detail") {
          this.closeDetail(cx);
        }
        cx.notify();
      }
    });
  }

  async close() {
    this.stopWatch();
  }

  isOverlay() {
    return Boolean(props()?.overlay);
  }

  closeSelf() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  stopWatch() {
    if (this.watchHandle) {
      try {
        this.watchHandle.cancel();
      } catch {}
      this.watchHandle = null;
    }
    this.watchedDir = null;
  }

  startWatch(dir, cx) {
    if (!dir || this.on) {
      this.stopWatch();
      return;
    }
    if (this.watchedDir === dir && this.watchHandle) return;
    this.stopWatch();
    this.watchedDir = dir;
    cx.spawn(async (cx) => {
      while (this.watchedDir === dir && !this.on) {
        const watch = watchFolder(dir);
        this.watchHandle = watch;
        try {
          const changed = await watch;
          if (this.watchedDir !== dir) break;
          if (Array.isArray(changed) && changed.length === 0) break;
          if (!this.writing) this.refresh(cx, false);
        } catch {
          if (this.watchedDir === dir) this.watchedDir = null;
          break;
        }
      }
    });
  }

  resolveContext() {
    const space = spaces().find((s) => s.active) ?? null;
    const f = focused();
    const allPanes = panes();
    const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
    const paneCwd =
      (f?.pane ? allPanes.find((p) => p.pane === f.pane)?.cwd : null) ||
      f?.cwd ||
      (f?.tab ? allPanes.find((p) => p.tab === f.tab && p.cwd)?.cwd : null) ||
      allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd ||
      space?.folder ||
      null;
    const on = space?.machine ?? null;
    const spaceKey = space?.id ?? "__global__";
    const sharedFolders = shared(STORAGE_FOLDERS);
    if (sharedFolders && typeof sharedFolders === "object" && !Array.isArray(sharedFolders)) {
      this.spaceFolders = sharedFolders;
    }
    const sharedRecent = shared(STORAGE_RECENT);
    if (Array.isArray(sharedRecent)) {
      this.recentFolders = sharedRecent;
    }
    const overrideFolder =
      this.overrideFolder && this.overrideFolder.spaceKey === spaceKey ? normPath(this.overrideFolder.dir) : null;
    const propFolder = normPath(props()?.folder);
    const manualDir = normPath(this.spaceFolders[spaceKey]);
    const key = JSON.stringify([spaceKey, on, overrideFolder, propFolder, manualDir, normPath(paneCwd)]);
    return { space, spaceKey, on, overrideFolder, propFolder, manualDir, paneCwd: normPath(paneCwd), key };
  }

  async detectBacklogDir(ctx) {
    for (const explicitDir of [ctx.overrideFolder, ctx.propFolder, ctx.manualDir]) {
      if (!explicitDir) continue;
      const files = await listMarkdownFiles(explicitDir, ctx.on);
      if (files !== null) {
        const root = (await gitTopLevel(explicitDir, ctx.on)) || parentDir(explicitDir);
        return { backlogDir: explicitDir, projectRoot: root, files };
      }
    }

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (dir, root, strict = false) => {
      const clean = normPath(dir);
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      candidates.push({ dir: clean, root: normPath(root) || parentDir(clean), strict });
    };

    const top = await gitTopLevel(ctx.paneCwd, ctx.on);
    if (ctx.paneCwd) {
      pushCandidate(joinPath(ctx.paneCwd, "backlog"), ctx.paneCwd, false);
      pushCandidate(joinPath(ctx.paneCwd, "docs/backlog"), ctx.paneCwd, false);
      pushCandidate(joinPath(ctx.paneCwd, ".backlog"), ctx.paneCwd, false);
    }
    if (top && top !== ctx.paneCwd) {
      pushCandidate(joinPath(top, "backlog"), top, false);
      pushCandidate(joinPath(top, "docs/backlog"), top, false);
      pushCandidate(joinPath(top, ".backlog"), top, false);
    }
    if (ctx.paneCwd) {
      const lower = ctx.paneCwd.toLowerCase();
      const isBacklogDir = lower.endsWith("/backlog") || lower.endsWith("/.backlog");
      pushCandidate(ctx.paneCwd, top || parentDir(ctx.paneCwd), !isBacklogDir);
    }

    for (const c of candidates) {
      const files = await listMarkdownFiles(c.dir, ctx.on);
      if (!files) continue;
      const hasEpics = c.strict ? files.some(isNumberedEpicFilename) : files.some(isEpicFilename);
      const isNamedBacklog = c.dir.toLowerCase().endsWith("/backlog") && files.length > 0;
      if (hasEpics || isNamedBacklog) {
        return { backlogDir: c.dir, projectRoot: c.root, files };
      }
    }

    return { backlogDir: null, projectRoot: top || ctx.paneCwd, files: null };
  }

  refresh(cx, force = false) {
    const ctx = this.resolveContext();
    const contextChanged = ctx.key !== this.contextKey;
    if (contextChanged) {
      this.contextKey = ctx.key;
      this.on = ctx.on;
      this.readOnly = Boolean(ctx.on);
      this.selectedEpicFile = null;
      this.selectedTaskLine = null;
      this.contextMenu = null;
      this.error = null;
      this.stopWatch();
      this.loadAgents(cx);
    }
    if (this.loading && !force && !contextChanged) return;

    const expectedKey = ctx.key;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const detected = await this.detectBacklogDir(ctx);
        if (this.contextKey !== expectedKey) return;

        this.backlogDir = detected.backlogDir;
        this.projectRoot = detected.projectRoot;

        if (!detected.backlogDir) {
          this.epics = [];
          this.error = null;
          this.stopWatch();
          return;
        }

        this.rememberRecent(detected.backlogDir);
        const epicFiles = (detected.files ?? []).filter(isEpicFilename).sort();
        const loaded = [];
        const batchSize = 12;
        for (let i = 0; i < epicFiles.length; i += batchSize) {
          const batch = epicFiles.slice(i, i + batchSize);
          const results = await Promise.all(
            batch.map(async (name) => {
              const fullPath = joinPath(detected.backlogDir, name);
              const text = await readTextFile(fullPath, { on: ctx.on }).catch(() => null);
              if (text === null) return null;
              return parseEpicFile(name, text, fullPath);
            }),
          );
          for (const item of results) {
            if (item) loaded.push(item);
          }
        }

        if (this.contextKey !== expectedKey) return;
        loaded.sort((a, b) => a.number - b.number || a.filename.localeCompare(b.filename));
        this.epics = loaded;
        this.error = null;

        if (this.selectedEpicFile && !loaded.some((e) => e.filePath === this.selectedEpicFile)) {
          this.selectedEpicFile = null;
          this.selectedTaskLine = null;
        } else if (!this.selectedEpicFile && props()?.epic && !this.initialEpicApplied) {
          const target = String(props().epic).toUpperCase();
          const match = loaded.find((e) => e.id.toUpperCase() === target);
          if (match) {
            this.selectedEpicFile = match.filePath;
            this.initialEpicApplied = true;
          }
        }

        this.startWatch(detected.backlogDir, cx);
      } catch (e) {
        if (this.contextKey === expectedKey) {
          this.error = String(e?.message ?? e);
        }
      } finally {
        if (this.contextKey === expectedKey) {
          this.loading = false;
        }
        cx.notify();
      }
    });
  }

  rememberRecent(dir) {
    const clean = normPath(dir);
    if (!clean) return;
    const sharedCurrent = shared(STORAGE_RECENT);
    const base = Array.isArray(sharedCurrent) ? sharedCurrent : this.recentFolders;
    const next = [clean, ...base.filter((d) => d !== clean)].slice(0, 8);
    if (
      !Array.isArray(sharedCurrent) ||
      JSON.stringify(next) !== JSON.stringify(sharedCurrent) ||
      JSON.stringify(next) !== JSON.stringify(this.recentFolders)
    ) {
      this.recentFolders = next;
      setShared(STORAGE_RECENT, next);
    }
  }

  selectFolder(dir, cx) {
    const clean = normPath(dir);
    if (!clean) return;
    const ctx = this.resolveContext();
    this.overrideFolder = { spaceKey: ctx.spaceKey, dir: clean };
    const sharedCurrent = shared(STORAGE_FOLDERS);
    const base =
      sharedCurrent && typeof sharedCurrent === "object" && !Array.isArray(sharedCurrent)
        ? sharedCurrent
        : this.spaceFolders;
    this.spaceFolders = { ...base, [ctx.spaceKey]: clean };
    setShared(STORAGE_FOLDERS, this.spaceFolders);
    this.rememberRecent(clean);
    this.selectedEpicFile = null;
    this.selectedTaskLine = null;
    this.refresh(cx, true);
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Выбрать папку backlog" });
      if (!picked) return;
      const clean = normPath(picked);
      // If user picked a project root containing `backlog/`, prefer `<picked>/backlog`.
      const directFiles = await listMarkdownFiles(clean, this.on);
      const hasDirectEpics = directFiles?.some(isEpicFilename);
      if (!hasDirectEpics) {
        const sub = joinPath(clean, "backlog");
        const subFiles = await listMarkdownFiles(sub, this.on);
        if (subFiles !== null) {
          this.selectFolder(sub, cx);
          return;
        }
      }
      this.selectFolder(clean, cx);
    });
  }

  loadAgents(cx) {
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on });
        this.knownAgentsList = Array.isArray(list) ? list : [];
      } catch {
        this.knownAgentsList = [];
      }

      // Fallback check on local Windows/Unix if knownAgents reported none installed.
      const anyInstalled = this.knownAgentsList.some((a) => a.installed);
      if (!anyInstalled && !on) {
        const extra = new Set();
        for (const a of agents()) {
          if (a.program?.key) extra.add(a.program.key);
        }
        const probeCmd = window()?.platform === "windows" ? "where.exe" : "which";
        const candidates = this.knownAgentsList.length
          ? this.knownAgentsList
          : [
              { key: "opencode", name: "OpenCode", run: ["opencode"] },
              { key: "claude", name: "Claude Code", run: ["claude"] },
              { key: "codex", name: "Codex", run: ["codex", "--no-daemon"] },
            ];
        await Promise.all(
          candidates.slice(0, 10).map(async (ag) => {
            const bin = ag.run?.[0];
            if (!bin || extra.has(ag.key)) return;
            const r = await exec(probeCmd, [bin]).catch(() => null);
            if (r?.code === 0) extra.add(ag.key);
          }),
        );
        this.extraInstalledKeys = extra;
      }
      cx.notify();
    });
  }

  getAgentChoices() {
    const runningKeys = new Set(agents().map((a) => a.program?.key).filter(Boolean));
    const base = this.knownAgentsList.length
      ? this.knownAgentsList
      : [
          { key: "opencode", name: "OpenCode", run: ["opencode"], installed: false },
          { key: "claude", name: "Claude Code", run: ["claude"], installed: false },
          { key: "codex", name: "Codex", run: ["codex", "--no-daemon"], installed: false },
        ];
    const enriched = base.map((a) => ({
      ...a,
      installed: Boolean(a.installed || this.extraInstalledKeys.has(a.key) || runningKeys.has(a.key)),
    }));
    const installed = enriched.filter((a) => a.installed);
    return installed.length ? installed : enriched.slice(0, 6);
  }

  getSelectedAgent(choices = this.getAgentChoices()) {
    if (!choices.length) return null;
    return choices.find((a) => a.key === this.selectedAgentKey) ?? choices.find((a) => a.installed) ?? choices[0];
  }

  selectAgent(key, cx) {
    this.selectedAgentKey = key;
    this.agentPickerOpen = false;
    setShared(STORAGE_AGENT, key);
    cx.notify();
  }

  findTargetTerminal() {
    const space = spaces().find((s) => s.active);
    if (!space) return null;
    const activeTabId = space.tabs?.find((t) => t.active)?.id ?? focused()?.tab ?? null;
    const tabIds = new Set((space.tabs ?? []).map((t) => t.id));
    const spacePanes = panes().filter((p) => tabIds.has(p.tab) && p.terminal);
    const paneByTerm = new Map(spacePanes.map((p) => [p.terminal, p]));
    const live = terminals().filter((t) => t.state === "live" && paneByTerm.has(t.address));
    const inActiveTab = live.filter((t) => paneByTerm.get(t.address)?.tab === activeTabId);
    return (
      inActiveTab.find((t) => t.program?.agent) ??
      inActiveTab[0] ??
      live.find((t) => t.program?.agent) ??
      live[0] ??
      null
    );
  }

  launchAgent(epic, task, cx) {
    const agent = this.getSelectedAgent();
    if (!agent || !agent.installed) {
      const prompt = buildAgentPrompt(epic, task, this.projectRoot);
      cx.write_to_clipboard(prompt);
      notify({
        title: "Агент не найден — промпт скопирован",
        body: task ? `${epic.id} · ${task.id}` : `${epic.id} — ${epic.title}`,
        level: "warning",
      });
      return;
    }
    const space = spaces().find((s) => s.active);
    const prompt = buildAgentPrompt(epic, task, this.projectRoot);
    const tabName = task ? `${epic.id} ${task.id}` : epic.id;
    const folder = this.projectRoot || parentDir(this.backlogDir) || space?.folder;

    run("tab.new", {
      name: tabName,
      ...(space?.id ? { space: space.id } : {}),
      ...(folder ? { folder } : {}),
      argv: agent.run,
      task: prompt,
    });

    notify({
      title: `Запущен ${agent.name}`,
      body: task ? `${epic.id} · ${task.id}` : `${epic.id} — ${epic.title}`,
      level: "success",
    });

    if (this.isOverlay()) {
      this.closeSelf();
    }
  }

  sendToTerminal(epic, task, terminalAddress, cx) {
    const prompt = buildAgentPrompt(epic, task, this.projectRoot);
    cx.spawn(async (cx) => {
      const r = await hc(["send", terminalAddress, prompt]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        notify({
          title: `Отправлено в ${terminalAddress}`,
          body: task ? `${epic.id} · ${task.id}` : epic.id,
          level: "success",
        });
        run("pane.focus", { terminal: terminalAddress });
        if (this.isOverlay()) this.closeSelf();
      } else {
        notify({
          title: "Не удалось отправить в терминал",
          body: r.stderr || "Терминал недоступен",
          level: "error",
        });
      }
      cx.notify();
    });
  }

  copyPrompt(epic, task, cx) {
    const prompt = buildAgentPrompt(epic, task, this.projectRoot);
    cx.write_to_clipboard(prompt);
    notify({
      title: "Промпт скопирован",
      body: task ? `${epic.id} · ${task.id}` : epic.id,
      level: "info",
    });
  }

  copyFilePath(epic, cx) {
    cx.write_to_clipboard(epic.filePath);
    notify({
      title: "Путь скопирован",
      body: epic.filePath,
      level: "info",
    });
  }

  selectedEpic() {
    if (!this.selectedEpicFile) return null;
    return this.epics.find((e) => e.filePath === this.selectedEpicFile) ?? null;
  }

  setMode(mode, cx) {
    this.mode = mode;
    setShared(STORAGE_MODE, mode);
    cx.notify();
  }

  setPriorityFilter(prio, cx) {
    this.priorityFilter = prio;
    cx.notify();
  }

  clearSearch(cx) {
    this.query = "";
    this.searchInput.set_value("");
    cx.notify();
  }

  showMoreInColumn(colId, cx) {
    this.columnLimits[colId] = (this.columnLimits[colId] ?? 50) + 50;
    cx.notify();
  }

  setHoveredCard(nextKey, cardKey, cx) {
    if (nextKey) {
      if (this.hoveredCard !== nextKey) {
        this.hoveredCard = nextKey;
        cx.notify();
      }
    } else if (this.hoveredCard === cardKey) {
      this.hoveredCard = null;
      cx.notify();
    }
  }

  startDrag(info, e, cx) {
    if (this.readOnly) return;
    this.justDragged = false;
    this.drag = {
      ...info,
      startX: e.position.x,
      startY: e.position.y,
      active: false,
    };
  }

  onRootMouseMove(e, cx) {
    if (!this.drag || this.drag.active) return;
    const dist = Math.hypot(e.position.x - this.drag.startX, e.position.y - this.drag.startY);
    if (dist > 6) {
      this.drag.active = true;
      cx.notify();
    }
  }

  onColumnHover(colId, hovered, cx) {
    if (!this.drag?.active) return;
    const next = hovered ? colId : this.dragOverCol === colId ? null : this.dragOverCol;
    if (this.dragOverCol !== next) {
      this.dragOverCol = next;
      cx.notify();
    }
  }

  onColumnDrop(colId, cx) {
    const drag = this.drag;
    if (!drag?.active) return;
    this.drag = null;
    this.dragOverCol = null;
    this.justDragged = true;
    cx.timer.after(50, () => {
      this.justDragged = false;
    });
    if (drag.fromStatus === colId) {
      cx.notify();
      return;
    }
    const epic = this.epics.find((e) => e.filePath === drag.epicFile);
    if (!epic) {
      cx.notify();
      return;
    }
    if (drag.kind === "epic") {
      this.moveEpic(epic, colId, cx);
    } else if (drag.kind === "task") {
      const task = epic.tasks.find((t) => t.lineIndex === drag.taskLineIndex);
      if (task) this.moveTask(epic, task, colId, cx);
    }
  }

  onRootMouseUp(cx) {
    if (!this.drag) return;
    if (this.drag.active) {
      this.justDragged = true;
      cx.timer.after(50, () => {
        this.justDragged = false;
      });
    }
    this.drag = null;
    this.dragOverCol = null;
    cx.notify();
  }

  onCardClick(epicFile, taskLine, cx) {
    if (this.justDragged) {
      this.justDragged = false;
      return;
    }
    this.handle.focus();
    this.selectedEpicFile = epicFile;
    this.selectedTaskLine = taskLine;
    this.agentPickerOpen = false;
    cx.notify();
  }

  openCardMenu(info, _e, _cx) {
    this.pendingMenu = info;
  }

  onRootRightMouseDown(e, cx) {
    if (this.pendingMenu) {
      const z = Number(settings()?.zoom) || 1;
      this.contextMenu = {
        ...this.pendingMenu,
        x: (e.local_position?.x ?? 24) / z,
        y: (e.local_position?.y ?? 24) / z,
      };
      this.pendingMenu = null;
      cx.notify();
    } else if (this.contextMenu) {
      this.contextMenu = null;
      cx.notify();
    }
  }

  closeDetail(cx) {
    this.selectedEpicFile = null;
    this.selectedTaskLine = null;
    this.agentPickerOpen = false;
    this.handle.focus();
    cx.notify();
  }

  mutateEpic(epic, transformFn, cx) {
    if (this.readOnly) {
      notify({ title: "Только чтение", body: "Запись на удалённую машину пока не поддерживается", level: "warning" });
      return;
    }
    const nextText = transformFn(epic.rawText);
    if (nextText === epic.rawText) return;

    this.writing = true;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(epic.filePath, nextText, epic.rawText);
        const updated = parseEpicFile(epic.filename, nextText, epic.filePath);
        this.epics = this.epics.map((e) => (e.filePath === epic.filePath ? updated : e));
      } catch (e) {
        notify({
          title: "Файл изменился на диске",
          body: "Доска обновлена до актуальной версии — повторите действие",
          level: "warning",
        });
        this.refresh(cx, true);
      } finally {
        this.writing = false;
        cx.notify();
      }
    });
  }

  moveEpic(epic, nextStatus, cx) {
    this.mutateEpic(epic, (raw) => updateEpicStatus(raw, nextStatus), cx);
  }

  changeEpicPriority(epic, nextPriority, cx) {
    this.mutateEpic(epic, (raw) => updateEpicPriority(raw, nextPriority), cx);
  }

  moveTask(epic, task, nextStatus, cx) {
    this.mutateEpic(epic, (raw) => updateTaskStatus(raw, task.lineIndex, nextStatus), cx);
  }

  submitNewTask(epic, cx) {
    const title = this.newTaskInput.value().trim();
    if (!title) return;
    this.newTaskInput.set_value("");
    this.mutateEpic(epic, (raw) => addTaskAndSyncEpic(raw, title, epic.id), cx);
  }

  toggleCreateEpic(cx, forceState = null) {
    this.creatingEpic = forceState !== null ? forceState : !this.creatingEpic;
    if (this.creatingEpic) {
      this.newEpicTitleInput.set_value("");
      this.newEpicTaskInput.set_value("");
      this.newEpicTitleInput.focus();
    } else {
      this.handle.focus();
    }
    cx.notify();
  }

  submitNewEpic(cx) {
    if (this.readOnly || !this.backlogDir) return;
    const title = this.newEpicTitleInput.value().trim();
    if (!title) {
      notify({ title: "Введите название эпика", level: "warning" });
      return;
    }
    const firstTask = this.newEpicTaskInput.value().trim();
    const maxNum = this.epics.reduce((m, e) => (e.number < 9000 ? Math.max(m, e.number) : m), 0);
    const nextNum = maxNum + 1;
    const filename = slugifyEpicFilename(nextNum, title);
    const fullPath = joinPath(this.backlogDir, filename);
    const project = this.epics.find((e) => e.project)?.project ?? "";
    const md = createEpicMarkdown({
      number: nextNum,
      title,
      priority: this.newEpicPriority,
      project,
      firstTask,
    });

    this.writing = true;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(fullPath, md, null);
        const created = parseEpicFile(filename, md, fullPath);
        this.epics = [...this.epics, created].sort((a, b) => a.number - b.number);
        this.creatingEpic = false;
        this.selectedEpicFile = fullPath;
        this.selectedTaskLine = null;
        this.handle.focus();
        notify({ title: `Создан ${created.id}`, body: created.title, level: "success" });
      } catch (e) {
        notify({ title: "Не удалось создать эпик", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.writing = false;
        cx.notify();
      }
    });
  }

  onKeyDown(e, cx) {
    if (this.searchFocused || this.newTaskFocused || this.creatingEpic) {
      if (e.key === "escape") {
        if (this.creatingEpic) this.creatingEpic = false;
        this.searchFocused = false;
        this.newTaskFocused = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }

    if (e.key === "escape") {
      if (this.contextMenu) {
        this.contextMenu = null;
        cx.stop_propagation();
        cx.notify();
      } else if (this.selectedEpicFile) {
        this.closeDetail(cx);
        cx.stop_propagation();
      } else if (this.isOverlay()) {
        this.closeSelf();
        cx.stop_propagation();
      }
      return;
    }

    if (e.modifiers.control || e.modifiers.alt || e.modifiers.platform) return;

    if (e.key === "r") {
      this.refresh(cx, true);
      cx.stop_propagation();
    } else if (e.key === "/") {
      this.searchInput.focus();
      cx.stop_propagation();
    } else if (e.key === "1") {
      this.setMode("epics", cx);
      cx.stop_propagation();
    } else if (e.key === "2") {
      this.setMode("tasks", cx);
      cx.stop_propagation();
    } else if (e.key === "n" && !this.readOnly && this.backlogDir) {
      this.toggleCreateEpic(cx, true);
      cx.stop_propagation();
    }
  }

  render(cx) {
    const ctx = this.resolveContext();
    if (!checking() && ctx.key !== this.contextKey) {
      this.refresh(cx, true);
    }

    const t = theme();
    const selected = this.selectedEpic();
    const narrow = (this.size?.width ?? 1000) < 760;
    const showLoading = this.loading && this.epics.length === 0;
    const showEmpty = !showLoading && (!this.backlogDir || this.epics.length === 0);
    const showBoard = !showLoading && Boolean(this.backlogDir) && this.epics.length > 0;

    return v_flex()
      .id("kanban-root")
      .relative()
      .size_full()
      .min_h(0)
      .min_w(0)
      .bg(t.canvas ?? t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const z = Number(settings()?.zoom) || 1;
        const logical = { width: size.width / z, height: size.height / z };
        if (
          !this.size ||
          Math.abs(this.size.width - logical.width) > 2 ||
          Math.abs(this.size.height - logical.height) > 2
        ) {
          this.size = logical;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => this.onKeyDown(e, cx))
      .on_mouse_move((e, cx) => this.onRootMouseMove(e, cx))
      .on_mouse_up("left", (_e, cx) => this.onRootMouseUp(cx))
      .on_mouse_down("right", (e, cx) => this.onRootRightMouseDown(e, cx))
      .child(renderToolbar(this, t))
      .when(this.creatingEpic, (el) => el.child(renderNewEpicBar(this, t)))
      .child(
        h_flex()
          .w_full()
          .flex_1()
          .min_h(0)
          .min_w(0)
          .when(showLoading, (el) => el.child(renderLoadingState(t)))
          .when(showEmpty, (el) => el.child(renderEmptyState(this, t)))
          .when(showBoard, (el) =>
            el
              .when(!(narrow && selected), (b) => b.child(renderBoard(this, t)))
              .when(Boolean(selected), (b) => b.child(renderDetail(this, selected, t, narrow))),
          ),
      )
      .when(Boolean(this.contextMenu), (el) => el.child(renderContextMenu(this, t)));
  }
}
