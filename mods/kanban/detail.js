import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, TextView } from "gpui-base";
import { COLUMNS, PRIORITIES } from "./parser.js";
import {
  alpha,
  iconButton,
  pillButton,
  priorityColor,
  statusColor,
  statusIcon,
} from "./ui.js";

function renderMarkdownSection(id, title, content, t) {
  if (!content) return null;
  return v_flex()
    .gap(6)
    .child(div().text_size(11).font_semibold().text_color(t.dim).child(title))
    .child(
      div()
        .p(10)
        .rounded(8)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .text_size(12.5)
        .line_height("18px")
        .text_color(t.foreground)
        .child(TextView.markdown(id, content).selectable(true)),
    );
}

export function renderDetail(view, epic, t, fullWidth = false) {
  if (!epic) return null;

  const agentsList = view.getAgentChoices();
  const activeAgent = view.getSelectedAgent(agentsList);
  const liveTerminal = view.findTargetTerminal();
  const pct = epic.counts.total > 0 ? Math.round((epic.counts.done / epic.counts.total) * 100) : 0;
  const panelWidth = fullWidth
    ? "100%"
    : Math.min(480, Math.max(340, Math.round((view.size?.width ?? 1100) * 0.38)));

  return v_flex()
    .id("kb-detail")
    .when(fullWidth, (el) => el.size_full())
    .when(!fullWidth, (el) => el.w(panelWidth).h_full().flex_none().border_l(1).border_color(t.border))
    .min_h(0)
    .bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(
      v_flex()
        .flex_none()
        .p(14)
        .gap(10)
        .bg(t.chrome)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .when(fullWidth, (el) =>
              el.child(
                pillButton(
                  "kb-detail-back",
                  "К доске",
                  false,
                  (_e, cx) => view.closeDetail(cx),
                  t,
                  { icon: "arrow-left", height: 24, px: 8, textSize: 11.5 },
                ),
              ),
            )
            .child(div().text_size(12).font_semibold().text_color(t.accent).child(epic.id))
            .child(
              h_flex()
                .gap(3)
                .items_center()
                .children(
                  PRIORITIES.map((p) => {
                    const active = epic.priority === p;
                    const c = priorityColor(t, p);
                    return h_flex()
                      .id(`kb-det-prio-${p}`)
                      .h(20)
                      .px(6)
                      .items_center()
                      .rounded(5)
                      .border_1()
                      .border_color(active ? alpha(c, "88") : t.border)
                      .bg(active ? alpha(c, "24") : t.background)
                      .text_size(10.5)
                      .font_semibold()
                      .text_color(active ? c : t.dim)
                      .when(!view.readOnly, (el) =>
                        el
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover).text_color(c))
                          .on_click((_e, cx) => view.changeEpicPriority(epic, p, cx)),
                      )
                      .child(p);
                  }),
                ),
            )
            .child(div().flex_1())
            .child(
              iconButton(
                "kb-detail-close",
                "x",
                "Закрыть панель (Esc)",
                (_e, cx) => view.closeDetail(cx),
                t,
                { size: 24, iconSize: 13 },
              ),
            ),
        )
        .child(div().text_size(15).font_semibold().line_height("20px").text_color(t.foreground).child(epic.title))
        .child(
          h_flex()
            .flex_wrap()
            .gap(5)
            .items_center()
            .children(
              COLUMNS.map((col) => {
                const active = epic.status === col.id;
                const c = statusColor(t, col.id);
                return h_flex()
                  .id(`kb-det-st-${col.id}`)
                  .h(24)
                  .px(8)
                  .gap(5)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(active ? alpha(c, "88") : t.border)
                  .bg(active ? alpha(c, "22") : t.background)
                  .text_size(11)
                  .when(active, (el) => el.font_semibold())
                  .text_color(active ? c : t.muted)
                  .when(!view.readOnly, (el) =>
                    el
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_click((_e, cx) => view.moveEpic(epic, col.id, cx)),
                  )
                  .child(statusIcon(t, col.id, 11))
                  .child(col.label);
              }),
            ),
        )
        .child(
          h_flex()
            .flex_wrap()
            .gap(6)
            .items_center()
            .child(
              h_flex()
                .id("kb-det-launch")
                .h(28)
                .px(10)
                .gap(6)
                .items_center()
                .rounded(7)
                .bg(t.solid)
                .text_color(t.solid_foreground)
                .text_size(12)
                .font_medium()
                .cursor_pointer()
                .hover((s) => s.opacity(0.88))
                .on_click((_e, cx) => view.launchAgent(epic, null, cx))
                .child(svg("mods/kanban/icons/play.svg").size(12).flex_none())
                .child(activeAgent ? `Запустить ${activeAgent.name}` : "Запустить агента"),
            )
            .when(agentsList.length > 1, (el) =>
              el.child(
                iconButton(
                  "kb-det-agent-pick",
                  view.agentPickerOpen ? "chevron-down" : "chevron-right",
                  "Выбрать агента",
                  (_e, cx) => {
                    view.agentPickerOpen = !view.agentPickerOpen;
                    cx.notify();
                  },
                  t,
                  { size: 28, iconSize: 13 },
                ),
              ),
            )
            .when(Boolean(liveTerminal), (el) =>
              el.child(
                pillButton(
                  "kb-det-send-term",
                  "В терминал",
                  false,
                  (_e, cx) => view.sendToTerminal(epic, null, liveTerminal.address, cx),
                  t,
                  { icon: "terminal", height: 28, px: 9, textSize: 11.5 },
                ),
              ),
            )
            .child(
              iconButton(
                "kb-det-copy-prompt",
                "copy",
                "Копировать промпт для агента",
                (_e, cx) => view.copyPrompt(epic, null, cx),
                t,
                { size: 28, iconSize: 13 },
              ),
            ),
        )
        .when(view.agentPickerOpen && agentsList.length > 0, (el) =>
          el.child(
            h_flex()
              .flex_wrap()
              .gap(4)
              .pt(2)
              .children(
                agentsList.map((ag) =>
                  pillButton(
                    `kb-ag-${ag.key}`,
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
    )
    .child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .child(
          div()
            .id("kb-detail-scroll")
            .absolute()
            .inset_0()
            .overflow_y_scroll()
            .child(
              v_flex()
                .w_full()
                .p(14)
                .gap(14)
                .when(Boolean(epic.goal), (el) =>
                  el.child(renderMarkdownSection(`kb-goal-${epic.id}`, "ЦЕЛЬ", epic.goal, t)),
                )
                .child(
                  v_flex()
                    .gap(8)
                    .child(
                      h_flex()
                        .gap(8)
                        .items_center()
                        .child(div().text_size(11).font_semibold().text_color(t.dim).child("ЗАДАЧИ"))
                        .child(
                          div()
                            .text_size(11)
                            .text_color(t.muted)
                            .child(`${epic.counts.done}/${epic.counts.total} (${pct}%)`),
                        )
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
                        ),
                    )
                    .children(
                      epic.tasks.map((task) => {
                        const isFocusedTask = view.selectedTaskLine === task.lineIndex;
                        const taskKey = `${epic.filePath}:${task.lineIndex}`;
                        const hovered = view.hoveredTask === taskKey;
                        const stColor = statusColor(t, task.status);

                        return v_flex()
                          .id(`kb-det-task-${epic.id}-${task.lineIndex}`)
                          .p(8)
                          .gap(4)
                          .rounded(7)
                          .border_1()
                          .border_color(isFocusedTask ? t.accent : t.border)
                          .bg(isFocusedTask ? t.selected : t.surface)
                          .hover((s) => s.bg(isFocusedTask ? t.selected : t.hover))
                          .on_hover((on, cx) => {
                            const next = on ? taskKey : null;
                            if (view.hoveredTask !== next && (on || view.hoveredTask === taskKey)) {
                              view.hoveredTask = next;
                              cx.notify();
                            }
                          })
                          .child(
                            h_flex()
                              .gap(8)
                              .items_start()
                              .child(
                                h_flex()
                                  .id(`kb-det-chk-${epic.id}-${task.lineIndex}`)
                                  .mt(1)
                                  .size(18)
                                  .flex_none()
                                  .items_center()
                                  .justify_center()
                                  .rounded(4)
                                  .border_1()
                                  .border_color(task.status === "todo" ? t.input : alpha(stColor, "88"))
                                  .bg(task.status === "todo" ? t.background : alpha(stColor, "22"))
                                  .when(!view.readOnly, (el) =>
                                    el
                                      .cursor_pointer()
                                      .tooltip("Переключить статус задачи")
                                      .hover((s) => s.bg(alpha(stColor, "33")))
                                      .on_click((_e, cx) => {
                                        cx.stop_propagation();
                                        const next = task.status === "done" ? "todo" : "done";
                                        view.moveTask(epic, task, next, cx);
                                      }),
                                  )
                                  .when(task.status !== "todo", (el) => el.child(statusIcon(t, task.status, 11))),
                              )
                              .child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .gap(2)
                                  .child(
                                    h_flex()
                                      .gap(6)
                                      .items_center()
                                      .when(task.hasExplicitId, (el) =>
                                        el.child(div().text_size(11).font_semibold().text_color(t.dim).child(task.id)),
                                      )
                                      .child(div().flex_1())
                                      .when(hovered || isFocusedTask, (el) =>
                                        el
                                          .when(!view.readOnly && task.status !== "in_progress", (b) =>
                                            b.child(
                                              iconButton(
                                                `kb-det-prog-${epic.id}-${task.lineIndex}`,
                                                "clock",
                                                "В работу [-]",
                                                (_e, cx) => view.moveTask(epic, task, "in_progress", cx),
                                                t,
                                                { size: 20, iconSize: 11, color: t.working },
                                              ),
                                            ),
                                          )
                                          .when(!view.readOnly && task.status !== "blocked", (b) =>
                                            b.child(
                                              iconButton(
                                                `kb-det-blk-${epic.id}-${task.lineIndex}`,
                                                "blocked",
                                                "Заблокирована [!]",
                                                (_e, cx) => view.moveTask(epic, task, "blocked", cx),
                                                t,
                                                { size: 20, iconSize: 11, color: t.blocked },
                                              ),
                                            ),
                                          )
                                          .child(
                                            iconButton(
                                              `kb-det-run-${epic.id}-${task.lineIndex}`,
                                              "play",
                                              "Запустить агента по этой задаче",
                                              (_e, cx) => view.launchAgent(epic, task, cx),
                                              t,
                                              { size: 20, iconSize: 11, color: t.accent },
                                            ),
                                          ),
                                      ),
                                  )
                                  .child(
                                    div()
                                      .text_size(12.5)
                                      .line_height("17px")
                                      .text_color(task.status === "done" ? t.muted : t.foreground)
                                      .child(task.title),
                                  ),
                              ),
                          )
                          .when(task.subitems.length > 0, (el) =>
                            el.child(
                              v_flex()
                                .pl(26)
                                .gap(2)
                                .children(
                                  task.subitems.map((sub) =>
                                    div().text_size(11.5).line_height("16px").text_color(t.dim).child(`• ${sub}`),
                                  ),
                                ),
                            ),
                          );
                      }),
                    )
                    .when(epic.tasks.length === 0, (el) =>
                      el.child(div().text_size(12).text_color(t.dim).child("В этом эпике пока нет задач.")),
                    )
                    .when(!view.readOnly, (el) =>
                      el.child(
                        h_flex()
                          .pt(4)
                          .gap(6)
                          .items_center()
                          .child(
                            div()
                              .flex_1()
                              .h(30)
                              .px(9)
                              .flex()
                              .items_center()
                              .rounded(7)
                              .border_1()
                              .border_color(view.newTaskFocused ? t.accent : t.input)
                              .bg(t.surface)
                              .child(Input.new(view.newTaskInput).w_full().h_full().text_size(12).text_color(t.foreground)),
                          )
                          .child(
                            h_flex()
                              .id("kb-add-task-btn")
                              .h(30)
                              .px(10)
                              .gap(4)
                              .items_center()
                              .rounded(7)
                              .border_1()
                              .border_color(t.border)
                              .bg(t.raised)
                              .text_size(12)
                              .text_color(t.foreground)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => view.submitNewTask(epic, cx))
                              .child(svg("mods/kanban/icons/plus.svg").size(12))
                              .child("Добавить"),
                          ),
                      ),
                    ),
                )
                .when(Boolean(epic.dod), (el) =>
                  el.child(renderMarkdownSection(`kb-dod-${epic.id}`, "DEFINITION OF DONE", epic.dod, t)),
                )
                .when(Boolean(epic.summary), (el) =>
                  el.child(renderMarkdownSection(`kb-sum-${epic.id}`, "ИТОГ РЕАЛИЗАЦИИ", epic.summary, t)),
                )
                .when(Boolean(epic.other), (el) =>
                  el.child(renderMarkdownSection(`kb-oth-${epic.id}`, "ДОПОЛНИТЕЛЬНО", epic.other, t)),
                ),
            ),
        )
        .child(Scrollbar.vertical("kb-detail-scroll").absolute().inset_0()),
    )
    .child(
      h_flex()
        .flex_none()
        .h(34)
        .px(14)
        .gap(8)
        .items_center()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(epic.filename))
        .child(
          pillButton(
            "kb-det-copy-path",
            "Копировать путь",
            false,
            (_e, cx) => view.copyFilePath(epic, cx),
            t,
            { icon: "copy", height: 22, px: 7, textSize: 11 },
          ),
        ),
    );
}
