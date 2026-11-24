import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, Scrollbar } from "gpui-base";
import { COLUMNS, PRIORITIES, isEpicFilename, nextEpicNumber } from "./parser.js";
import { filterRecentForMachine, joinPath, parentDir } from "./paths.js";
import {
  alpha,
  badge,
  iconButton,
  pillButton,
  priorityColor,
  priorityRank,
  statusColor,
  statusIcon,
} from "./ui.js";

function shortFolderLabel(dir) {
  if (!dir) return "Выбрать папку…";
  const parts = dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function matchesQuery(epic, task, q) {
  if (!q) return true;
  const hay = task
    ? `${epic.id} ${epic.title} ${task.id} ${task.title} ${(task.subitems ?? []).join(" ")}`
    : `${epic.id} ${epic.title} ${epic.goal} ${epic.tasks.map((t) => `${t.id} ${t.title}`).join(" ")}`;
  return hay.toLowerCase().includes(q);
}

export function renderToolbar(view, t) {
  const totalEpics = view.epics.length;
  const totalTasks = view.epics.reduce((sum, e) => sum + e.counts.total, 0);
  const doneTasks = view.epics.reduce((sum, e) => sum + e.counts.done, 0);

  return h_flex()
    .id("kanban-toolbar")
    .flex_none()
    .flex_wrap()
    .px(12)
    .py(8)
    .gap(8)
    .items_center()
    .bg(t.chrome)
    .border_b(1)
    .border_color(t.border)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(svg("mods/kanban/icons/kanban.svg").size(15).flex_none().text_color(t.accent))
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Kanban"))
        .child(
          h_flex()
            .id("kb-folder-btn")
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(view.backlogDir ? t.muted : t.accent)
            .cursor_pointer()
            .tooltip(
              view.backlogDir
                ? `${view.on ? `[${view.on}] ` : ""}${view.backlogDir} (нажмите, чтобы сменить)`
                : view.on
                  ? `Выбрать папку backlog на ${view.on}`
                  : "Выбрать папку backlog",
            )
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => view.chooseFolder(cx))
            .child(svg("mods/kanban/icons/folder.svg").size(12).flex_none())
            .child(div().max_w(180).truncate().child(shortFolderLabel(view.backlogDir))),
        )
        .when(view.readOnly, (el) =>
          el.child(badge(view.on ? `${view.on} · чтение` : "Только чтение", t.working, alpha(t.working, "20"))),
        )
        .when(totalEpics > 0, (el) =>
          el.child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                pillButton(
                  "kb-mode-epics",
                  `Эпики (${totalEpics})`,
                  view.mode === "epics",
                  (_e, cx) => view.setMode("epics", cx),
                  t,
                ),
              )
              .child(
                pillButton(
                  "kb-mode-tasks",
                  `Задачи (${doneTasks}/${totalTasks})`,
                  view.mode === "tasks",
                  (_e, cx) => view.setMode("tasks", cx),
                  t,
                ),
              ),
          ),
        ),
    )
    .child(div().flex_1())
    .child(
      h_flex()
        .flex_wrap()
        .gap(6)
        .items_center()
        .when(totalEpics > 0, (el) =>
          el
            .child(
              h_flex()
                .gap(3)
                .items_center()
                .child(
                  pillButton(
                    "kb-prio-all",
                    "Все",
                    view.priorityFilter === "ALL",
                    (_e, cx) => view.setPriorityFilter("ALL", cx),
                    t,
                    { px: 7, height: 24, textSize: 11 },
                  ),
                )
                .children(
                  PRIORITIES.map((p) =>
                    pillButton(
                      `kb-prio-${p}`,
                      p,
                      view.priorityFilter === p,
                      (_e, cx) => view.setPriorityFilter(p, cx),
                      t,
                      {
                        px: 7,
                        height: 24,
                        textSize: 11,
                        activeFg: priorityColor(t, p),
                        activeBg: alpha(priorityColor(t, p), "22"),
                        activeBorder: alpha(priorityColor(t, p), "66"),
                      },
                    ),
                  ),
                ),
            )
            .child(
              h_flex()
                .id("kb-search-box")
                .w(175)
                .h(26)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(view.searchFocused ? t.accent : t.input)
                .bg(t.background)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .child(svg("mods/kanban/icons/search.svg").size(12).flex_none().text_color(t.dim))
                .child(Input.new(view.searchInput).flex_1().h_full().text_size(12).text_color(t.foreground))
                .when(Boolean(view.query), (s) =>
                  s.child(iconButton("kb-search-clear", "x", "Очистить поиск", (_e, cx) => view.clearSearch(cx), t, { size: 18, iconSize: 11 })),
                ),
            ),
        )
        .when(Boolean(view.backlogDir) && !view.readOnly, (el) =>
          el.child(
            pillButton(
              "kb-new-epic",
              "Эпик",
              view.creatingEpic,
              (_e, cx) => view.toggleCreateEpic(cx),
              t,
              { icon: "plus", height: 26, px: 8 },
            ),
          ),
        )
        .child(
          iconButton(
            "kb-refresh",
            "refresh",
            "Обновить доску (R)",
            (_e, cx) => view.refresh(cx, true),
            t,
            { size: 26, iconSize: 13 },
          ),
        )
        .when(view.isOverlay(), (el) =>
          el.child(
            iconButton(
              "kb-close-overlay",
              "x",
              "Закрыть (Esc)",
              () => view.closeSelf(),
              t,
              { size: 26, iconSize: 14 },
            ),
          ),
        ),
    );
}

export function renderNewEpicModal(view, t) {
  const isAgent = view.newEpicMode === "agent";
  const agentsList = view.getAgentChoices();
  const activeAgent = view.getSelectedAgent(agentsList);
  const nextNum = nextEpicNumber(view.epics);
  const nextId = `EPIC-${String(nextNum).padStart(3, "0")}`;
  const modalW = Math.min(580, Math.max(340, (view.size?.width ?? 800) - 48));

  return div()
    .id("kb-new-epic-backdrop")
    .absolute()
    .inset_0()
    .flex()
    .items_center()
    .justify_center()
    .bg(alpha(t.canvas ?? t.background, "cc"))
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      view.toggleCreateEpic(cx, false);
    })
    .child(
      v_flex()
        .id("kb-new-epic-modal")
        .w(modalW)
        .rounded(12)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(
          h_flex()
            .h(44)
            .flex_none()
            .px(14)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(svg("mods/kanban/icons/plus.svg").size(14).flex_none().text_color(t.accent))
            .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Новый эпик"))
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(
                  pillButton(
                    "kb-new-mode-manual",
                    "Вручную",
                    !isAgent,
                    (_e, cx) => view.setNewEpicMode("manual", cx),
                    t,
                    { height: 24, px: 9, textSize: 11.5 },
                  ),
                )
                .child(
                  pillButton(
                    "kb-new-mode-agent",
                    "С агентом",
                    isAgent,
                    (_e, cx) => view.setNewEpicMode("agent", cx),
                    t,
                    { height: 24, px: 9, textSize: 11.5 },
                  ),
                ),
            )
            .child(div().flex_1())
            .child(
              iconButton(
                "kb-new-epic-close",
                "x",
                "Закрыть (Esc)",
                (_e, cx) => view.toggleCreateEpic(cx, false),
                t,
                { size: 24, iconSize: 13 },
              ),
            ),
        )
        .when(!isAgent, (el) =>
          el.child(
            v_flex()
              .p(14)
              .gap(12)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Приоритет"))
                  .child(
                    h_flex()
                      .gap(4)
                      .items_center()
                      .children(
                        PRIORITIES.map((p) =>
                          pillButton(
                            `kb-new-prio-${p}`,
                            p,
                            view.newEpicPriority === p,
                            (_e, cx) => {
                              view.newEpicPriority = p;
                              cx.notify();
                            },
                            t,
                            {
                              px: 8,
                              height: 24,
                              textSize: 11,
                              activeFg: priorityColor(t, p),
                              activeBg: alpha(priorityColor(t, p), "22"),
                              activeBorder: alpha(priorityColor(t, p), "66"),
                            },
                          ),
                        ),
                      ),
                  ),
              )
              .child(
                v_flex()
                  .gap(5)
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Название эпика"))
                  .child(
                    div()
                      .w_full()
                      .h(32)
                      .px(10)
                      .flex()
                      .items_center()
                      .rounded(7)
                      .border_1()
                      .border_color(view.newEpicTitleFocused ? t.accent : t.input)
                      .bg(t.background)
                      .child(Input.new(view.newEpicTitleInput).w_full().h_full().text_size(12.5).text_color(t.foreground)),
                  ),
              )
              .child(
                v_flex()
                  .gap(5)
                  .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Первая задача (необязательно)"))
                  .child(
                    div()
                      .w_full()
                      .h(32)
                      .px(10)
                      .flex()
                      .items_center()
                      .rounded(7)
                      .border_1()
                      .border_color(view.newEpicTaskFocused ? t.accent : t.input)
                      .bg(t.background)
                      .child(Input.new(view.newEpicTaskInput).w_full().h_full().text_size(12.5).text_color(t.foreground)),
                  ),
              ),
          ),
        )
        .when(isAgent, (el) =>
          el.child(
            v_flex()
              .p(14)
              .gap(10)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(11.5)
                      .text_color(t.muted)
                      .child(`Агент создаст .md файлы в ${view.backlogDir || "backlog/"} начиная с ${nextId}`),
                  ),
              )
              .child(
                div()
                  .w_full()
                  .p(8)
                  .rounded(8)
                  .border_1()
                  .border_color(view.newEpicPromptFocused ? t.accent : t.input)
                  .bg(t.background)
                  .child(
                    Textarea.new(view.newEpicPromptInput)
                      .w_full()
                      .h(200)
                      .text_size(12.5)
                      .text_color(t.foreground),
                  ),
              )
              .when(view.newEpicAgentPickerOpen && agentsList.length > 0, (p) =>
                p.child(
                  h_flex()
                    .flex_wrap()
                    .gap(4)
                    .pt(2)
                    .children(
                      agentsList.map((ag) =>
                        pillButton(
                          `kb-new-ag-${ag.key}`,
                          ag.installed ? ag.name : `${ag.name} (?)`,
                          activeAgent?.key === ag.key,
                          (_e, cx) => view.selectAgent(ag.key, cx),
                          t,
                          { height: 24, px: 8, textSize: 11 },
                        ),
                      ),
                    ),
                ),
              ),
          ),
        )
        .child(
          h_flex()
            .h(48)
            .flex_none()
            .px(14)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(isAgent ? "Откроет новую вкладку с агентом" : "Enter — создать · Esc — отмена"),
            )
            .child(
              h_flex()
                .id("kb-create-epic-cancel")
                .h(30)
                .px(12)
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_color(t.muted)
                .text_size(12)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => view.toggleCreateEpic(cx, false))
                .child("Отмена"),
            )
            .when(!isAgent, (el) =>
              el.child(
                h_flex()
                  .id("kb-create-epic-submit")
                  .h(30)
                  .px(14)
                  .items_center()
                  .rounded(6)
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .text_size(12)
                  .font_medium()
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => view.submitNewEpic(cx))
                  .child("Создать"),
              ),
            )
            .when(isAgent, (el) =>
              el.child(
                h_flex()
                  .gap(2)
                  .items_center()
                  .child(
                    h_flex()
                      .id("kb-create-agent-submit")
                      .h(30)
                      .px(12)
                      .gap(6)
                      .items_center()
                      .rounded(6)
                      .bg(t.solid)
                      .text_color(t.solid_foreground)
                      .text_size(12)
                      .font_medium()
                      .cursor_pointer()
                      .hover((s) => s.opacity(0.88))
                      .on_click((_e, cx) => view.submitAgentEpics(cx))
                      .child(svg("mods/kanban/icons/play.svg").size(12).flex_none())
                      .child(activeAgent ? `Создать задачи (${activeAgent.name})` : "Создать задачи"),
                  )
                  .when(agentsList.length > 1, (b) =>
                    b.child(
                      iconButton(
                        "kb-new-agent-pick",
                        view.newEpicAgentPickerOpen ? "chevron-down" : "chevron-right",
                        "Выбрать агента",
                        (_e, cx) => {
                          view.newEpicAgentPickerOpen = !view.newEpicAgentPickerOpen;
                          cx.notify();
                        },
                        t,
                        { size: 30, iconSize: 13 },
                      ),
                    ),
                  ),
              ),
            ),
        ),
    );
}

export function renderLoadingState(t) {
  return v_flex()
    .flex_1()
    .h_full()
    .min_h(0)
    .items_center()
    .justify_center()
    .p(24)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .px(16)
        .py(12)
        .rounded(10)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .child(svg("mods/kanban/icons/spinner.svg").size(16).flex_none().text_color(t.accent).spin(900))
        .child(div().text_size(13).text_color(t.muted).child("Загрузка задач…")),
    );
}

export function renderEmptyState(view, t) {
  const recent = filterRecentForMachine(view.recentFolders, view.on);
  return v_flex()
    .flex_1()
    .h_full()
    .min_h(0)
    .items_center()
    .justify_center()
    .p(24)
    .child(
      v_flex()
        .w_full()
        .max_w(460)
        .p(20)
        .gap(14)
        .rounded(12)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(svg("mods/kanban/icons/kanban.svg").size(20).text_color(t.accent))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(15)
                .font_semibold()
                .text_color(t.foreground)
                .child(view.backlogDir ? "В папке нет эпиков" : "Папка backlog не выбрана"),
            )
            .when(Boolean(view.on), (el) =>
              el.child(badge(view.on, t.accent, alpha(t.accent, "20"))),
            ),
        )
        .child(
          div()
            .text_size(12.5)
            .line_height("18px")
            .text_color(t.muted)
            .child(
              view.error
                ? view.error
                : view.backlogDir
                  ? `В ${view.backlogDir} пока нет .md файлов эпиков. ${view.readOnly ? "Выберите другую папку." : "Создайте первый эпик или выберите другую папку."}`
                  : view.on
                    ? `Плагин автоматически ищет папку backlog/ на ${view.on}. Укажите путь или выберите папку на удалённой машине.`
                    : "Плагин автоматически ищет папку backlog/ в активном space. Выберите папку с .md задачами вручную или откройте недавний проект.",
            ),
        )
        .child(
          h_flex()
            .gap(8)
            .flex_wrap()
            .child(
              h_flex()
                .id("kb-empty-pick")
                .h(32)
                .px(14)
                .gap(7)
                .items_center()
                .rounded(8)
                .bg(t.solid)
                .text_color(t.solid_foreground)
                .text_size(12.5)
                .font_medium()
                .cursor_pointer()
                .hover((s) => s.opacity(0.88))
                .on_click((_e, cx) => view.chooseFolder(cx))
                .child(svg("mods/kanban/icons/folder.svg").size(14))
                .child(view.on ? `Выбрать папку на ${view.on}…` : "Выбрать папку…"),
            )
            .when(Boolean(view.backlogDir) && !view.readOnly, (el) =>
              el.child(
                h_flex()
                  .id("kb-empty-create")
                  .h(32)
                  .px(12)
                  .gap(6)
                  .items_center()
                  .rounded(8)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_color(t.foreground)
                  .text_size(12.5)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => view.toggleCreateEpic(cx, true))
                  .child(svg("mods/kanban/icons/plus.svg").size(13))
                  .child("Создать первый эпик"),
              ),
            ),
        )
        .when(recent.length > 0, (el) =>
          el.child(
            v_flex()
              .pt(6)
              .gap(6)
              .border_t(1)
              .border_color(t.border)
              .child(div().text_size(11).font_medium().text_color(t.dim).child("Недавние папки"))
              .children(
                recent.map((item, idx) =>
                  h_flex()
                    .id(`kb-recent-${idx}`)
                    .h(30)
                    .px(8)
                    .gap(8)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => view.selectFolder(item.dir, cx))
                    .child(svg("mods/kanban/icons/folder.svg").size(13).flex_none().text_color(t.muted))
                    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(item.dir)),
                ),
              ),
          ),
        ),
    );
}

function renderEpicCard(view, epic, colIndex, t) {
  const selected = view.selectedEpicFile === epic.filePath;
  const isDragging = view.drag?.active && view.drag.kind === "epic" && view.drag.epicFile === epic.filePath;
  const cardKey = `epic:${epic.filePath}`;
  const hovered = view.hoveredCard === cardKey;
  const pct = epic.counts.total > 0 ? Math.round((epic.counts.done / epic.counts.total) * 100) : 0;
  const nextTask =
    epic.status === "done"
      ? null
      : epic.tasks.find((tk) => tk.status === "blocked") ??
        epic.tasks.find((tk) => tk.status === "in_progress") ??
        epic.tasks.find((tk) => tk.status === "todo") ??
        null;

  return v_flex()
    .id(`kb-epic-${epic.id}-${epic.filename}`)
    .flex_none()
    .p(10)
    .gap(7)
    .rounded(8)
    .border_1()
    .border_color(selected ? t.accent : t.border)
    .bg(selected ? t.selected : t.background)
    .cursor_pointer()
    .when(isDragging, (el) => el.opacity(0.45))
    .hover((s) => s.bg(selected ? t.selected : t.hover))
    .on_hover((on, cx) => view.setHoveredCard(on ? cardKey : null, cardKey, cx))
    .on_mouse_down("left", (e, cx) =>
      view.startDrag({ kind: "epic", epicFile: epic.filePath, fromStatus: epic.status }, e, cx),
    )
    .on_mouse_down("right", (e, cx) => view.openCardMenu({ kind: "epic", epic }, e, cx))
    .on_click((_e, cx) => view.onCardClick(epic.filePath, null, cx))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().text_size(11).font_semibold().text_color(t.dim).child(epic.id))
        .when(Boolean(epic.priority), (el) =>
          el.child(badge(epic.priority, priorityColor(t, epic.priority), alpha(priorityColor(t, epic.priority), "20"))),
        )
        .child(div().flex_1())
        .when(hovered, (el) =>
          el
            .when(!view.readOnly && colIndex > 0, (b) =>
              b.child(
                iconButton(
                  `kb-mv-l-${epic.id}`,
                  "arrow-left",
                  `Перенести в ${COLUMNS[colIndex - 1].label}`,
                  (_e, cx) => view.moveEpic(epic, COLUMNS[colIndex - 1].id, cx),
                  t,
                  { size: 20, iconSize: 11 },
                ),
              ),
            )
            .when(!view.readOnly && colIndex < COLUMNS.length - 1, (b) =>
              b.child(
                iconButton(
                  `kb-mv-r-${epic.id}`,
                  "arrow-right",
                  `Перенести в ${COLUMNS[colIndex + 1].label}`,
                  (_e, cx) => view.moveEpic(epic, COLUMNS[colIndex + 1].id, cx),
                  t,
                  { size: 20, iconSize: 11 },
                ),
              ),
            )
            .child(
              iconButton(
                `kb-run-${epic.id}`,
                "play",
                "Запустить агента по эпику",
                (_e, cx) => view.launchAgent(epic, null, cx),
                t,
                { size: 20, iconSize: 11, color: t.accent },
              ),
            ),
        ),
    )
    .child(div().text_size(12.8).font_medium().line_height("17px").text_color(t.foreground).child(epic.title))
    .when(epic.counts.total > 0, (el) =>
      el.child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .h(4)
              .rounded(2)
              .bg(t.raised)
              .overflow_hidden()
              .child(
                div()
                  .w(`${pct}%`)
                  .h_full()
                  .rounded(2)
                  .bg(epic.status === "done" ? t.done : t.accent),
              ),
          )
          .child(div().text_size(11).text_color(t.dim).child(`${epic.counts.done}/${epic.counts.total}`))
          .when(epic.counts.blocked > 0, (b) =>
            b.child(badge(`!${epic.counts.blocked}`, t.blocked, alpha(t.blocked, "22"))),
          ),
      ),
    )
    .when(Boolean(nextTask), (el) =>
      el.child(
        h_flex()
          .gap(5)
          .items_center()
          .pt(2)
          .child(statusIcon(t, nextTask.status, 11))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(nextTask.rawTitle)),
      ),
    );
}

function renderTaskCard(view, item, colIndex, t) {
  const { epic, task } = item;
  const cardKey = `task:${epic.filePath}:${task.lineIndex}`;
  const selected = view.selectedEpicFile === epic.filePath && view.selectedTaskLine === task.lineIndex;
  const isDragging =
    view.drag?.active &&
    view.drag.kind === "task" &&
    view.drag.epicFile === epic.filePath &&
    view.drag.taskLineIndex === task.lineIndex;
  const hovered = view.hoveredCard === cardKey;

  return v_flex()
    .id(`kb-task-${epic.id}-${task.lineIndex}`)
    .flex_none()
    .p(10)
    .gap(6)
    .rounded(8)
    .border_1()
    .border_color(selected ? t.accent : t.border)
    .bg(selected ? t.selected : t.background)
    .cursor_pointer()
    .when(isDragging, (el) => el.opacity(0.45))
    .hover((s) => s.bg(selected ? t.selected : t.hover))
    .on_hover((on, cx) => view.setHoveredCard(on ? cardKey : null, cardKey, cx))
    .on_mouse_down("left", (e, cx) =>
      view.startDrag(
        { kind: "task", epicFile: epic.filePath, taskLineIndex: task.lineIndex, fromStatus: task.status },
        e,
        cx,
      ),
    )
    .on_mouse_down("right", (e, cx) => view.openCardMenu({ kind: "task", epic, task }, e, cx))
    .on_click((_e, cx) => view.onCardClick(epic.filePath, task.lineIndex, cx))
    .child(
      h_flex()
        .gap(5)
        .items_center()
        .child(div().text_size(11).font_semibold().text_color(t.dim).child(task.id))
        .child(badge(epic.id, t.muted, t.raised))
        .when(Boolean(epic.priority), (el) =>
          el.child(badge(epic.priority, priorityColor(t, epic.priority), alpha(priorityColor(t, epic.priority), "20"))),
        )
        .child(div().flex_1())
        .when(hovered, (el) =>
          el
            .when(!view.readOnly && task.status !== "done", (b) =>
              b.child(
                iconButton(
                  `kb-tk-done-${epic.id}-${task.lineIndex}`,
                  "check",
                  "Отметить выполненной",
                  (_e, cx) => view.moveTask(epic, task, "done", cx),
                  t,
                  { size: 20, iconSize: 11, color: t.done },
                ),
              ),
            )
            .when(!view.readOnly && colIndex > 0, (b) =>
              b.child(
                iconButton(
                  `kb-tk-l-${epic.id}-${task.lineIndex}`,
                  "arrow-left",
                  `Перенести в ${COLUMNS[colIndex - 1].label}`,
                  (_e, cx) => view.moveTask(epic, task, COLUMNS[colIndex - 1].id, cx),
                  t,
                  { size: 20, iconSize: 11 },
                ),
              ),
            )
            .when(!view.readOnly && colIndex < COLUMNS.length - 1, (b) =>
              b.child(
                iconButton(
                  `kb-tk-r-${epic.id}-${task.lineIndex}`,
                  "arrow-right",
                  `Перенести в ${COLUMNS[colIndex + 1].label}`,
                  (_e, cx) => view.moveTask(epic, task, COLUMNS[colIndex + 1].id, cx),
                  t,
                  { size: 20, iconSize: 11 },
                ),
              ),
            )
            .child(
              iconButton(
                `kb-tk-run-${epic.id}-${task.lineIndex}`,
                "play",
                "Запустить агента по задаче",
                (_e, cx) => view.launchAgent(epic, task, cx),
                t,
                { size: 20, iconSize: 11, color: t.accent },
              ),
            ),
        ),
    )
    .child(div().text_size(12.5).line_height("17px").text_color(t.foreground).child(task.title))
    .when(task.subitems.length > 0, (el) =>
      el.child(div().text_size(11).text_color(t.dim).child(`+${task.subitems.length} подпункт(а/ов)`)),
    );
}

export function renderBoard(view, t) {
  const q = view.query.trim().toLowerCase();
  const prio = view.priorityFilter;

  const filteredEpics = view.epics
    .filter((e) => (prio === "ALL" || e.priority === prio) && matchesQuery(e, null, q))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number);

  const columnsData = COLUMNS.map((col, colIndex) => {
    if (view.mode === "epics") {
      const items = filteredEpics.filter((e) => e.status === col.id);
      const totalTasks = items.reduce((s, e) => s + e.counts.total, 0);
      const doneTasks = items.reduce((s, e) => s + e.counts.done, 0);
      return { col, colIndex, items, totalTasks, doneTasks };
    }

    const items = [];
    const epicsByPrio = view.epics
      .filter((e) => prio === "ALL" || e.priority === prio)
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number);
    for (const epic of epicsByPrio) {
      for (const task of epic.tasks) {
        if (task.status === col.id && matchesQuery(epic, task, q)) {
          items.push({ epic, task });
        }
      }
    }
    return { col, colIndex, items, totalTasks: items.length, doneTasks: 0 };
  });

  const minBoardWidth = COLUMNS.length * 248 + (COLUMNS.length - 1) * 10 + 24;

  return div()
    .flex_1()
    .h_full()
    .min_h(0)
    .min_w(0)
    .relative()
    .child(
      div()
        .id("kanban-board-x")
        .absolute()
        .inset_0()
        .overflow_x_scroll()
        .child(
          h_flex()
            .w_full()
            .min_w(minBoardWidth)
            .h_full()
            .p(12)
            .gap(10)
            .children(
              columnsData.map(({ col, colIndex, items, totalTasks, doneTasks }) => {
                const isDropTarget =
                  view.drag?.active && view.dragOverCol === col.id && view.drag.fromStatus !== col.id;
                const limit = view.mode === "tasks" ? (view.columnLimits[col.id] ?? 50) : items.length;
                const visibleItems = items.slice(0, limit);
                const remaining = items.length - visibleItems.length;

                return v_flex()
                  .id(`kb-col-${col.id}`)
                  .flex_1()
                  .min_w(248)
                  .h_full()
                  .min_h(0)
                  .rounded(10)
                  .border_1()
                  .border_color(isDropTarget ? t.accent : t.border)
                  .bg(isDropTarget ? alpha(t.accent, "14") : t.surface)
                  .on_hover((hovered, cx) => view.onColumnHover(col.id, hovered, cx))
                  .on_mouse_up("left", (_e, cx) => view.onColumnDrop(col.id, cx))
                  .child(
                    h_flex()
                      .h(38)
                      .flex_none()
                      .px(12)
                      .gap(8)
                      .items_center()
                      .border_b(1)
                      .border_color(t.border)
                      .child(statusIcon(t, col.id, 13))
                      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(col.label))
                      .child(badge(String(items.length), statusColor(t, col.id), alpha(statusColor(t, col.id), "20")))
                      .child(div().flex_1())
                      .when(view.mode === "epics" && totalTasks > 0, (el) =>
                        el.child(div().text_size(11).text_color(t.dim).child(`${doneTasks}/${totalTasks}`)),
                      ),
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_h(0)
                      .relative()
                      .child(
                        div()
                          .id(`kb-col-scroll-${col.id}`)
                          .absolute()
                          .inset_0()
                          .overflow_y_scroll()
                          .child(
                            v_flex()
                              .w_full()
                              .p(8)
                              .gap(8)
                              .children(
                                visibleItems.map((item) =>
                                  view.mode === "epics"
                                    ? renderEpicCard(view, item, colIndex, t)
                                    : renderTaskCard(view, item, colIndex, t),
                                ),
                              )
                              .when(remaining > 0, (el) =>
                                el.child(
                                  h_flex()
                                    .id(`kb-more-${col.id}`)
                                    .h(30)
                                    .flex_none()
                                    .items_center()
                                    .justify_center()
                                    .rounded(7)
                                    .border_1()
                                    .border_color(t.border)
                                    .bg(t.raised)
                                    .text_size(11.5)
                                    .text_color(t.muted)
                                    .cursor_pointer()
                                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                    .on_click((_e, cx) => view.showMoreInColumn(col.id, cx))
                                    .child(`Показать ещё (${remaining})`),
                                ),
                              )
                              .when(items.length === 0, (el) =>
                                el.child(
                                  div()
                                    .py(20)
                                    .text_center()
                                    .text_size(12)
                                    .text_color(t.dim)
                                    .child(isDropTarget ? "Отпустите, чтобы перенести" : "Пусто"),
                                ),
                              ),
                          ),
                      )
                      .child(Scrollbar.vertical(`kb-col-scroll-${col.id}`).absolute().inset_0()),
                  );
              }),
            ),
        ),
    )
    .child(Scrollbar.horizontal("kanban-board-x").absolute().inset_0());
}

export function renderContextMenu(view, t) {
  const menu = view.contextMenu;
  if (!menu) return null;

  const currentStatus = menu.kind === "task" ? menu.task.status : menu.epic.status;
  const liveTerminal = view.findTargetTerminal();
  const menuWidth = 228;
  const maxLeft = Math.max(8, (view.size?.width ?? 900) - menuWidth - 12);
  const maxTop = Math.max(8, (view.size?.height ?? 600) - 260);
  const left = Math.max(8, Math.min(menu.x, maxLeft));
  const top = Math.max(8, Math.min(menu.y, maxTop));

  const itemRow = (id, iconName, label, onClick, color = t.foreground) =>
    h_flex()
      .id(id)
      .h(30)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .text_size(12.5)
      .text_color(color)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        view.contextMenu = null;
        onClick(cx);
      })
      .child(svg(`mods/kanban/icons/${iconName}.svg`).size(13).flex_none().text_color(color === t.foreground ? t.muted : color))
      .child(div().flex_1().truncate().child(label));

  return div()
    .id("kb-ctx-backdrop")
    .absolute()
    .inset_0()
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      view.contextMenu = null;
      cx.notify();
    })
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      view.contextMenu = null;
      cx.notify();
    })
    .child(
      v_flex()
        .id("kb-ctx-menu")
        .absolute()
        .left(left)
        .top(top)
        .w(menuWidth)
        .p(5)
        .gap(2)
        .rounded(9)
        .border_1()
        .border_color(t.border)
        .bg(t.popover)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(!view.readOnly, (el) =>
          el
            .child(div().px(8).py(3).text_size(10.5).font_medium().text_color(t.dim).child("Перенести в"))
            .children(
              COLUMNS.filter((c) => c.id !== currentStatus).map((c) =>
                itemRow(
                  `kb-ctx-mv-${c.id}`,
                  c.id === "in_progress" ? "clock" : c.id === "blocked" ? "blocked" : c.id === "done" ? "check" : "circle",
                  c.label,
                  (cx) =>
                    menu.kind === "task"
                      ? view.moveTask(menu.epic, menu.task, c.id, cx)
                      : view.moveEpic(menu.epic, c.id, cx),
                  statusColor(t, c.id),
                ),
              ),
            )
            .child(div().h(1).mx(4).my(3).bg(t.border)),
        )
        .child(
          itemRow(
            "kb-ctx-run",
            "play",
            menu.kind === "task" ? "Запустить агента по задаче" : "Запустить агента по эпику",
            (cx) => view.launchAgent(menu.epic, menu.task ?? null, cx),
            t.accent,
          ),
        )
        .when(Boolean(liveTerminal), (el) =>
          el.child(
            itemRow(
              "kb-ctx-send",
              "terminal",
              `Отправить в ${liveTerminal.name || liveTerminal.program?.name || liveTerminal.address}`,
              (cx) => view.sendToTerminal(menu.epic, menu.task ?? null, liveTerminal.address, cx),
            ),
          ),
        )
        .child(
          itemRow("kb-ctx-copy-prompt", "copy", "Копировать промпт", (cx) =>
            view.copyPrompt(menu.epic, menu.task ?? null, cx),
          ),
        )
        .child(
          itemRow("kb-ctx-copy-path", "folder", "Копировать путь к .md", (cx) =>
            view.copyFilePath(menu.epic, cx),
          ),
        ),
    );
}

export function renderRemoteFolderPicker(view, t) {
  const currentDir = view.remoteBrowseDir || "~";
  const upDir = parentDir(currentDir);
  const canGoUp = Boolean(upDir && upDir !== currentDir);
  const dirs = view.remoteBrowseDirs ?? [];
  const mdFiles = view.remoteBrowseMdFiles ?? [];
  const epicCount = mdFiles.filter(isEpicFilename).length;
  const recent = filterRecentForMachine(view.recentFolders, view.on);
  const modalW = Math.min(560, Math.max(320, (view.size?.width ?? 800) - 48));
  const modalH = Math.min(480, Math.max(280, (view.size?.height ?? 600) - 64));

  return div()
    .id("kb-remote-picker-backdrop")
    .absolute()
    .inset_0()
    .flex()
    .items_center()
    .justify_center()
    .bg(alpha(t.canvas ?? t.background, "cc"))
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      view.closeFolderPicker(cx);
    })
    .child(
      v_flex()
        .id("kb-remote-picker")
        .w(modalW)
        .h(modalH)
        .rounded(12)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(
          h_flex()
            .h(44)
            .flex_none()
            .px(14)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(svg("mods/kanban/icons/folder.svg").size(15).flex_none().text_color(t.accent))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(13.5)
                .font_semibold()
                .text_color(t.foreground)
                .child(`Выбор папки на ${view.on || "удалённой машине"}`),
            )
            .child(
              iconButton(
                "kb-remote-close",
                "x",
                "Закрыть (Esc)",
                (_e, cx) => view.closeFolderPicker(cx),
                t,
                { size: 24, iconSize: 13 },
              ),
            ),
        )
        .child(
          v_flex()
            .flex_none()
            .p(12)
            .gap(8)
            .border_b(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  h_flex()
                    .id("kb-remote-path-box")
                    .flex_1()
                    .h(30)
                    .px(9)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(view.remotePathFocused ? t.accent : t.input)
                    .bg(t.background)
                    .child(Input.new(view.remotePathInput).w_full().h_full().text_size(12.5).text_color(t.foreground)),
                )
                .child(
                  h_flex()
                    .id("kb-remote-go")
                    .h(30)
                    .px(12)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .text_size(12)
                    .font_medium()
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => view.submitRemotePath(cx))
                    .child("Перейти"),
                ),
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  pillButton(
                    "kb-remote-up",
                    "Вверх",
                    false,
                    (_e, cx) => {
                      if (canGoUp) view.browseRemoteDir(upDir, cx);
                    },
                    t,
                    { icon: "arrow-left", height: 24, px: 8, textSize: 11.5 },
                  ),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(t.muted)
                    .child(currentDir),
                )
                .when(epicCount > 0, (el) =>
                  el.child(badge(`Эпиков: ${epicCount}`, t.done, alpha(t.done, "22"))),
                )
                .child(
                  iconButton(
                    "kb-remote-refresh",
                    "refresh",
                    "Обновить список",
                    (_e, cx) => view.browseRemoteDir(currentDir, cx),
                    t,
                    { size: 24, iconSize: 12 },
                  ),
                ),
            )
            .when(Boolean(view.remoteBrowseError), (el) =>
              el.child(
                div()
                  .px(9)
                  .py(6)
                  .rounded(6)
                  .bg(alpha(t.blocked ?? t.ansi1, "18"))
                  .border_1()
                  .border_color(alpha(t.blocked ?? t.ansi1, "55"))
                  .text_size(11.5)
                  .text_color(t.blocked ?? t.ansi1)
                  .child(view.remoteBrowseError),
              ),
            ),
        )
        .child(
          div()
            .flex_1()
            .min_h(0)
            .relative()
            .child(
              div()
                .id("kb-remote-dirs-scroll")
                .absolute()
                .inset_0()
                .overflow_y_scroll()
                .child(
                  v_flex()
                    .w_full()
                    .p(8)
                    .gap(2)
                    .when(view.remoteBrowseLoading && dirs.length === 0, (el) =>
                      el.child(
                        h_flex()
                          .p(12)
                          .gap(8)
                          .items_center()
                          .child(svg("mods/kanban/icons/spinner.svg").size(14).text_color(t.accent).spin(900))
                          .child(div().text_size(12).text_color(t.muted).child("Чтение папок…")),
                      ),
                    )
                    .children(
                      dirs.map((name, idx) => {
                        const full = joinPath(currentDir, name);
                        const isBacklog = name.toLowerCase() === "backlog" || name.toLowerCase() === ".backlog";
                        return h_flex()
                          .id(`kb-remote-dir-${idx}`)
                          .h(30)
                          .px(8)
                          .gap(8)
                          .items_center()
                          .rounded(6)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => view.browseRemoteDir(full, cx))
                          .child(
                            svg("mods/kanban/icons/folder.svg")
                              .size(13)
                              .flex_none()
                              .text_color(isBacklog ? t.accent : t.muted),
                          )
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .text_size(12.5)
                              .when(isBacklog, (el) => el.font_semibold().text_color(t.accent))
                              .when(!isBacklog, (el) => el.text_color(t.foreground))
                              .child(name),
                          )
                          .when(isBacklog, (el) =>
                            el.child(
                              h_flex()
                                .id(`kb-remote-pick-${idx}`)
                                .h(22)
                                .px(8)
                                .items_center()
                                .rounded(5)
                                .bg(alpha(t.accent, "22"))
                                .text_size(11)
                                .font_medium()
                                .text_color(t.accent)
                                .cursor_pointer()
                                .hover((s) => s.bg(alpha(t.accent, "38")))
                                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                .on_click((_e, cx) => {
                                  cx.stop_propagation();
                                  view.selectFolder(full, cx);
                                })
                                .child("Выбрать"),
                            ),
                          )
                          .child(svg("mods/kanban/icons/chevron-right.svg").size(12).flex_none().text_color(t.dim));
                      }),
                    )
                    .when(!view.remoteBrowseLoading && dirs.length === 0 && !view.remoteBrowseError, (el) =>
                      el.child(
                        div()
                          .p(12)
                          .text_size(12)
                          .text_color(t.dim)
                          .child(
                            epicCount > 0
                              ? `Подпапок нет · найдено эпиков: ${epicCount}`
                              : "Подпапок нет",
                          ),
                      ),
                    )
                    .when(recent.length > 0, (el) =>
                      el.child(
                        v_flex()
                          .mt(8)
                          .pt(8)
                          .gap(2)
                          .border_t(1)
                          .border_color(t.border)
                          .child(div().px(8).py(2).text_size(11).font_medium().text_color(t.dim).child("Недавние на этой машине"))
                          .children(
                            recent.map((item, idx) =>
                              h_flex()
                                .id(`kb-remote-recent-${idx}`)
                                .h(28)
                                .px(8)
                                .gap(8)
                                .items_center()
                                .rounded(6)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .on_click((_e, cx) => view.selectFolder(item.dir, cx))
                                .child(svg("mods/kanban/icons/folder.svg").size(12).flex_none().text_color(t.muted))
                                .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(item.dir)),
                            ),
                          ),
                      ),
                    ),
                ),
            )
            .child(Scrollbar.vertical("kb-remote-dirs-scroll").absolute().inset_0()),
        )
        .child(
          h_flex()
            .h(48)
            .flex_none()
            .px(12)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.dim)
                .child(epicCount > 0 ? `Готово к открытию (${epicCount} эпиков)` : "Откройте папку или выберите текущую"),
            )
            .child(
              h_flex()
                .id("kb-remote-cancel")
                .h(30)
                .px(12)
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => view.closeFolderPicker(cx))
                .child("Отмена"),
            )
            .child(
              h_flex()
                .id("kb-remote-select")
                .h(30)
                .px(14)
                .gap(6)
                .items_center()
                .rounded(6)
                .bg(t.solid)
                .text_size(12)
                .font_medium()
                .text_color(t.solid_foreground)
                .cursor_pointer()
                .hover((s) => s.opacity(0.88))
                .on_click((_e, cx) => view.confirmRemoteFolder(currentDir, cx))
                .child(svg("mods/kanban/icons/check.svg").size(12))
                .child("Выбрать эту папку"),
            ),
        ),
    );
}
