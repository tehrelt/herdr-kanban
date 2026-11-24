import { expect, mock, test } from "bun:test";

mock.module("gpui-kit", () => ({ View: class {}, div() {}, svg() {} }));
mock.module("gpui-base", () => ({
  Input: {}, InputState: {}, Textarea: {}, TextareaState: {}, Scrollbar: {}, TextView: {},
  h_flex() {}, v_flex() {},
}));
mock.module("herdr", () => ({
  agents: () => [{ space: "remote", program: { key: "claude" } }],
  spaces: () => [{ id: "local", machine: null }, { id: "remote", machine: "ssh" }],
  knownAgents: async () => [{ key: "claude", run: ["claude"], installed: false }],
  exec: async () => ({ code: 1 }),
  panes() {}, focused() {}, terminals() {}, hc() {}, home() {}, readTextFile() {},
  writeTextFile() {}, watchFolder() {}, pickFolder() {}, run() {}, closeOverlay() {},
  notify() {}, theme() {}, props() {}, nextCommand() {}, checking() {}, window() {},
  shared() {}, setShared() {}, settings() {},
}));

const { default: Kanban } = await import("../mods/kanban/main.js");

test("удалённый агент не считается установленным локально", async () => {
  const view = Object.assign(new Kanban(), {
    on: null, knownAgentsList: [], extraInstalledKeys: new Set(),
  });
  const cx = { notify() {}, spawn(task) { this.pending = task(this); } };
  view.loadAgents(cx);
  await cx.pending;
  expect(view.getAgentChoices()[0].installed).toBe(false);
});

test("смена проекта закрывает черновик эпика", () => {
  const view = Object.assign(new Kanban(), {
    contextKey: "project-a", resolveContext: () => ({ key: "project-b", on: null }),
    creatingEpic: true, newEpicAgentPickerOpen: true, handle: { focus() {} },
  });
  view.refresh({ spawn() {}, notify() {} });
  expect(view.creatingEpic).toBe(false);
  expect(view.newEpicAgentPickerOpen).toBe(false);
});

test("общая команда создания не открывает форму без доступной папки", () => {
  for (const state of [{ readOnly: true, backlogDir: "/remote" }, { backlogDir: null }, { backlogDir: "/old", loading: true }]) {
    const view = Object.assign(new Kanban(), { creatingEpic: false, ...state });
    view.toggleCreateEpic({ notify() {} }, true);
    expect(view.creatingEpic).toBe(false);
  }
});
