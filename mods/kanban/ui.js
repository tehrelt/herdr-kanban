import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export function alpha(hex, aa) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return hex;
  const base = hex.length === 9 ? hex.slice(0, 7) : hex;
  return base.length === 7 ? `${base}${aa}` : hex;
}

export function statusColor(t, status) {
  switch (status) {
    case "in_progress":
      return t.working ?? t.accent;
    case "blocked":
      return t.blocked ?? t.ansi1;
    case "done":
      return t.done ?? t.ansi2;
    default:
      return t.muted ?? t.dim;
  }
}

export function statusLabel(status) {
  switch (status) {
    case "in_progress":
      return "IN PROGRESS";
    case "blocked":
      return "BLOCKED";
    case "done":
      return "DONE";
    default:
      return "TODO";
  }
}

export function statusIconName(status) {
  switch (status) {
    case "in_progress":
      return "clock";
    case "blocked":
      return "blocked";
    case "done":
      return "check";
    default:
      return "circle";
  }
}

export function statusIcon(t, status, size = 12) {
  return svg(`mods/kanban/icons/${statusIconName(status)}.svg`)
    .size(size)
    .flex_none()
    .text_color(statusColor(t, status));
}

export function priorityColor(t, priority) {
  switch (priority) {
    case "P0":
      return t.blocked ?? t.ansi1;
    case "P1":
      return t.working ?? t.ansi3;
    case "P2":
      return t.accent ?? t.ansi4;
    case "P3":
      return t.dim ?? t.muted;
    default:
      return t.dim;
  }
}

export function priorityRank(priority) {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 9;
  }
}

export function badge(text, fg, bg, border = null) {
  return h_flex()
    .flex_none()
    .h(18)
    .px(6)
    .items_center()
    .rounded(5)
    .bg(bg)
    .when(Boolean(border), (el) => el.border_1().border_color(border))
    .text_size(10.5)
    .font_semibold()
    .text_color(fg)
    .child(text);
}

export function iconButton(id, iconName, tip, onClick, t, opts = {}) {
  const size = opts.size ?? 24;
  const iconSize = opts.iconSize ?? 13;
  const fg = opts.color ?? t.muted;
  return div()
    .id(id)
    .size(size)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(6)
    .text_color(fg)
    .cursor_pointer()
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(svg(`mods/kanban/icons/${iconName}.svg`).size(iconSize));
}

export function pillButton(id, label, active, onClick, t, opts = {}) {
  const fg = active ? (opts.activeFg ?? t.foreground) : (opts.fg ?? t.muted);
  const bg = active ? (opts.activeBg ?? t.selected) : (opts.bg ?? t.chrome);
  const border = active ? (opts.activeBorder ?? t.border) : (opts.border ?? t.border);
  return h_flex()
    .id(id)
    .h(opts.height ?? 26)
    .px(opts.px ?? 9)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(border)
    .bg(bg)
    .text_size(opts.textSize ?? 11.5)
    .when(active, (el) => el.font_medium())
    .text_color(fg)
    .cursor_pointer()
    .hover((s) => s.bg(active ? bg : t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .when(Boolean(opts.icon), (el) => el.child(svg(`mods/kanban/icons/${opts.icon}.svg`).size(12).flex_none()))
    .child(label);
}
