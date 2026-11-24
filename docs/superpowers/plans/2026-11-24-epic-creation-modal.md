# Epic Creation Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить верхнюю полосу создания эпика на модальное окно с двумя режимами — ручным и с помощью AI-агента (большое `Textarea` + кнопка запуска агента в новой вкладке со встроенным выбором агента).

**Architecture:** Чистая функция генерации промпта и расчёта следующего номера эпика добавляется в `mods/kanban/parser.js` и покрывается тестами в `tests/parser.test.js`. Состояние модалки (`newEpicMode`, `newEpicPromptInput`, `newEpicAgentPickerOpen`), запуск агента в новой вкладке (`submitAgentEpics`) и обработка `Esc` живут в `mods/kanban/main.js`. UI модального окна `renderNewEpicModal` заменяет `renderNewEpicBar` в `mods/kanban/board.js` по паттерну `renderRemoteFolderPicker`.

**Tech Stack:** JavaScript (ESM), `gpui-kit`, `gpui-base` (`Input`, `InputState`, `Textarea`, `TextareaState`), `herdr` (`run("tab.new", ...)`, `knownAgents`), `bun:test`, `herdr-app check`.

**Spec:** `docs/superpowers/specs/2026-11-24-epic-creation-modal-design.md`

## Global Constraints

- Модальное окно открывается по кнопке `+ Эпик` и клавише `n` только при `!this.readOnly && Boolean(this.backlogDir)`.
- Два режима в модалке: `manual` («Вручную») и `agent` («С агентом»).
- В режиме `agent` используется одно большое многострочное поле `Textarea` (`TextareaState` из `gpui-base`) и кнопка `Создать задачи` со встроенным выбором агента (`getAgentChoices()`, `STORAGE_AGENT`).
- Кнопка `Создать задачи` запускает выбранного агента в новой вкладке (`run("tab.new", ...)`) в корне проекта; если агент не найден — копирует промпт в буфер обмена и показывает предупреждение.
- `mods/kanban/parser.js` остаётся без импортов `herdr` / `gpui-*`, чтобы запускаться в `bun test`.
- Все пользовательские строки интерфейса — на русском языке.

## Review Focus

- Пустое описание в режиме `agent`: нажатие `Создать задачи` при пустом или пробельном тексте не должно запускать вкладку или копировать пустой промпт — должно показывать `notify` с предупреждением.
- Переключение режимов `manual` ↔ `agent`: введённый текст в полях не должен теряться при переключении вкладок внутри открытой модалки, а при повторном открытии модалки поля должны сбрасываться.
- Фокус и `Esc`: при открытой модалке `Esc` закрывает сначала выпадающий список выбора агента (если открыт) или саму модалку, возвращая фокус на `this.handle`, и не закрывает панель деталей или оверлей под модалкой.
- Отсутствие установленных агентов: при `!agent || !agent.installed` промпт копируется в буфер обмена, показывается `notify` (`level: "warning"`), модалка остаётся закрытой или закрывается предсказуемо (закрыть модалку после копирования, чтобы не мешать).
- Нумерация эпиков при наличии `9000+` или нечисловых файлов: `nextEpicNumber` должен игнорировать `number >= 9000` (как `submitNewEpic` сейчас) и возвращать `1` для пустого списка.

---

### Task 1: `nextEpicNumber` и `buildCreateEpicsPrompt` в `mods/kanban/parser.js`

**Files:**
- Modify: `mods/kanban/parser.js:639-679`
- Test: `tests/parser.test.js:257-287`

**Interfaces:**
- Consumes: `parseEpicFile` (для тестов), `PRIORITIES`
- Produces:
  - `nextEpicNumber(epics: Array<{ number: number }>): number`
  - `buildCreateEpicsPrompt(opts: { description: string, backlogDir: string, nextNumber: number, projectRoot?: string | null, project?: string | null }): string`

- [ ] **Step 1: Write the failing tests in `tests/parser.test.js`**

Добавить импорт `nextEpicNumber` и `buildCreateEpicsPrompt` из `../mods/kanban/parser.js` и тесты:

```js
test("nextEpicNumber returns max number < 9000 plus 1, or 1 when empty", () => {
  expect(nextEpicNumber([])).toBe(1);
  expect(nextEpicNumber([{ number: 9999 }])).toBe(1);
  expect(nextEpicNumber([{ number: 1 }, { number: 5 }, { number: 9999 }])).toBe(6);
});

test("buildCreateEpicsPrompt includes description, backlogDir, next EPIC id, project, and format rules", () => {
  const prompt = buildCreateEpicsPrompt({
    description: "Добавить OAuth и страницу профиля",
    backlogDir: "C:/repo/backlog",
    nextNumber: 7,
    projectRoot: "C:/repo",
    project: "Herdr",
  });
  expect(prompt).toContain("Добавить OAuth и страницу профиля");
  expect(prompt).toContain("C:/repo/backlog");
  expect(prompt).toContain("EPIC-007");
  expect(prompt).toContain("007-");
  expect(prompt).toContain("C:/repo");
  expect(prompt).toContain("Herdr");
  expect(prompt).toContain("**Status:** [ ] TODO");
  expect(prompt).toContain("**Priority:**");
  expect(prompt).toContain("## Задачи");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parser.test.js`
Expected: FAIL — `nextEpicNumber` / `buildCreateEpicsPrompt` not exported from `mods/kanban/parser.js`.

- [ ] **Step 3: Implement `nextEpicNumber` and `buildCreateEpicsPrompt` in `mods/kanban/parser.js`**

Реализовать в `mods/kanban/parser.js`:
- `nextEpicNumber(epics = [])`: `epics.reduce((m, e) => (e.number < 9000 ? Math.max(m, e.number) : m), 0) + 1`.
- `buildCreateEpicsPrompt({ description, backlogDir, nextNumber = 1, projectRoot = null, project = null })`: формирует структурированный промпт на русском языке с:
  - описанием задачи/задач (`description.trim()`);
  - инструкцией создать один или несколько `.md` файлов эпиков в `backlogDir` (начиная с `EPIC-${pad3(nextNumber)}` и имени файла `${pad3(nextNumber)}-<slug>.md`);
  - указанием `projectRoot` и `> Проект: **${project}**` (если заданы);
  - шаблоном формата (`# EPIC-NNN — Название`, `**Status:** [ ] TODO`, `**Priority:** P0|P1|P2|P3`, `## Цель`, `## Задачи` с `- [ ] TASK-NNN.1 ...`, `## Definition of Done`, `---`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/parser.test.js`
Expected: PASS (все тесты в `tests/parser.test.js` зелёные).

- [ ] **Step 5: Commit**

```bash
git add mods/kanban/parser.js tests/parser.test.js
git commit -m "feat(kanban): add nextEpicNumber and buildCreateEpicsPrompt helpers"
```

---

### Task 2: Состояние модалки, `TextareaState` и запуск агента в `mods/kanban/main.js`

**Files:**
- Modify: `mods/kanban/main.js:1-62,291-376,1238-1345,1386-1404`

**Interfaces:**
- Consumes: `TextareaState` from `"gpui-base"`, `nextEpicNumber`, `buildCreateEpicsPrompt` from `"./parser.js"`, `renderNewEpicModal` from `"./board.js"`
- Produces on `Kanban`:
  - `this.newEpicMode` (`"manual" | "agent"`)
  - `this.newEpicAgentPickerOpen` (`boolean`)
  - `this.newEpicPromptFocused` (`boolean`)
  - `this.newEpicPromptInput` (`TextareaState`)
  - `setNewEpicMode(mode, cx)`
  - `submitAgentEpics(cx)`

- [ ] **Step 1: Обновить импорты в `mods/kanban/main.js`**

- Добавить `TextareaState` в импорт из `"gpui-base"`.
- Добавить `nextEpicNumber`, `buildCreateEpicsPrompt` в импорт из `"./parser.js"`.
- Заменить `renderNewEpicBar` на `renderNewEpicModal` в импорте из `"./board.js"`.

- [ ] **Step 2: Инициализировать состояние модалки в `Kanban.init`**

- Добавить поля:
  - `this.newEpicMode = "manual";`
  - `this.newEpicAgentPickerOpen = false;`
  - `this.newEpicPromptFocused = false;`
  - `this.newEpicPromptInput = TextareaState.new({ placeholder: "Опишите задачу или список задач — агент разобьёт их на эпики и создаст .md файлы в backlog/…", rows: 8 });`
- Подписаться на `focus` / `blur` у `this.newEpicPromptInput` для обновления `this.newEpicPromptFocused` и `cx.notify()`.

- [ ] **Step 3: Обновить `toggleCreateEpic`, `submitNewEpic`, добавить `setNewEpicMode` и `submitAgentEpics`**

- `toggleCreateEpic(cx, forceState = null)`:
  - При открытии сбрасывает `this.newEpicAgentPickerOpen = false`, очищает `newEpicTitleInput`, `newEpicTaskInput`, `newEpicPromptInput`, и фокусирует `newEpicTitleInput` (если `newEpicMode === "manual"`) или `newEpicPromptInput` (если `newEpicMode === "agent"`).
  - При закрытии сбрасывает `this.newEpicAgentPickerOpen = false` и возвращает фокус на `this.handle`.
- `setNewEpicMode(mode, cx)`:
  - Устанавливает `this.newEpicMode = mode === "agent" ? "agent" : "manual"`, сбрасывает `this.newEpicAgentPickerOpen = false`, переводит фокус на `newEpicPromptInput` или `newEpicTitleInput`, вызывает `cx.notify()`.
- `submitNewEpic(cx)`: использовать `nextEpicNumber(this.epics)` вместо дублирования `reduce`.
- `submitAgentEpics(cx)`:
  - Проверяет `!this.readOnly && Boolean(this.backlogDir)`.
  - Читает `const description = this.newEpicPromptInput.value().trim();`. Если пусто — `notify({ title: "Опишите задачу для агента", level: "warning" })` и `return`.
  - Собирает `prompt = buildCreateEpicsPrompt({ description, backlogDir: this.backlogDir, nextNumber: nextEpicNumber(this.epics), projectRoot: this.projectRoot, project: this.epics.find((e) => e.project)?.project ?? "" })`.
  - Берёт `const agent = this.getSelectedAgent();`.
  - Если `!agent || !agent.installed`: копирует `prompt` в буфер (`cx.write_to_clipboard(prompt)`), показывает `notify({ title: "Агент не найден — промпт скопирован", body: "Вставьте промпт в терминал с агентом", level: "warning" })`, закрывает модалку (`this.toggleCreateEpic(cx, false)`) и `return`.
  - Иначе запускает `run("tab.new", { name: "Новые задачи", ...(space?.id ? { space: space.id } : {}), ...(folder ? { folder } : {}), argv: agent.run, task: prompt })`, показывает `notify({ title: \`Запущен ${agent.name}\`, body: "Создание задач в backlog/", level: "success" })`, закрывает модалку (`this.toggleCreateEpic(cx, false)`). Если `this.isOverlay()`, вызывает `this.closeSelf()`.

- [ ] **Step 4: Обновить `onKeyDown` и `render` в `mods/kanban/main.js`**

- В `onKeyDown`: при `this.creatingEpic` клавиша `escape` сначала закрывает `this.newEpicAgentPickerOpen` (если открыт), иначе закрывает модалку через `this.toggleCreateEpic(cx, false)` и вызывает `cx.stop_propagation()`.
- В `render`: убрать `.when(this.creatingEpic, (el) => el.child(renderNewEpicBar(this, t)))` и добавить `.when(this.creatingEpic, (el) => el.child(renderNewEpicModal(this, t)))` в корневой `v_flex()` (на уровне `renderRemoteFolderPicker`).

- [ ] **Step 5: Verify syntax and tests**

Run: `bun test`
Expected: PASS.

---

### Task 3: Модальное окно `renderNewEpicModal` в `mods/kanban/board.js`

**Files:**
- Modify: `mods/kanban/board.js:1-15,208-326`

**Interfaces:**
- Consumes: `Textarea` from `"gpui-base"`, `pillButton`, `iconButton`, `priorityColor`, `alpha` from `"./ui.js"`, `PRIORITIES` from `"./parser.js"`, методы `Kanban` из Task 2 (`setNewEpicMode`, `toggleCreateEpic`, `submitNewEpic`, `submitAgentEpics`, `getAgentChoices`, `getSelectedAgent`, `selectAgent`).
- Produces: `export function renderNewEpicModal(view, t)`

- [ ] **Step 1: Обновить импорты в `mods/kanban/board.js`**

Добавить `Textarea` в импорт из `"gpui-base"`.

- [ ] **Step 2: Заменить `renderNewEpicBar` на `renderNewEpicModal(view, t)`**

Структура модального окна (по паттерну `renderRemoteFolderPicker`):
- Backdrop `#kb-new-epic-backdrop` (`absolute().inset_0().flex().items_center().justify_center().bg(alpha(t.canvas ?? t.background, "cc"))`), клик по фону закрывает модалку (`view.toggleCreateEpic(cx, false)`).
- Контейнер `#kb-new-epic-modal` (`w(modalW)` до `580px`, `rounded(12)`, `border_1()`, `bg(t.surface)`, `on_mouse_down("left", (_e, cx) => cx.stop_propagation())`).
- **Шапка (`t.chrome`, `border_b(1)`):**
  - Иконка `plus.svg` + заголовок `Новый эпик`.
  - Переключатель режимов: `pillButton("kb-new-mode-manual", "Вручную", view.newEpicMode === "manual", ...)` и `pillButton("kb-new-mode-agent", "С агентом", view.newEpicMode === "agent", ...)`.
  - Кнопка закрытия `iconButton("kb-new-epic-close", "x", "Закрыть (Esc)", ...)`.
- **Тело (режим `manual`):**
  - Выбор приоритета `P0`–`P3` (`kb-new-prio-${p}`).
  - Поле названия эпика (`Input.new(view.newEpicTitleInput)`).
  - Поле первой задачи (`Input.new(view.newEpicTaskInput)`).
- **Тело (режим `agent`):**
  - Подпись с подсказкой: куда будут созданы файлы (`view.backlogDir`) и какой следующий номер (`EPIC-NNN`).
  - Большое поле `Textarea.new(view.newEpicPromptInput).w_full().h(200).text_size(12.5).text_color(t.foreground)` внутри рамки с подсветкой фокуса (`view.newEpicPromptFocused ? t.accent : t.input`).
  - Если `view.newEpicAgentPickerOpen && agentsList.length > 0`: компактная панель выбора агента (`pillButton(\`kb-new-ag-${ag.key}\`, ...)`), вызывающая `view.selectAgent(ag.key, cx)` и закрывающая `view.newEpicAgentPickerOpen = false`.
- **Футер (`t.chrome`, `border_t(1)`):**
  - Подсказка слева (`Enter — создать · Esc — отмена` для `manual`, `Откроет новую вкладку с агентом` для `agent`).
  - Кнопка `Отмена` (`#kb-create-epic-cancel`).
  - В режиме `manual`: кнопка `Создать` (`#kb-create-epic-submit`, вызывает `view.submitNewEpic(cx)`).
  - В режиме `agent`: составная кнопка `Создать задачи` (`#kb-create-agent-submit`, иконка `play.svg` + текст `Создать задачи (${activeAgent.name})` или `Создать задачи`) + при `agentsList.length > 1` пристыкованная кнопка-стрелка `#kb-new-agent-pick` (`chevron-down` / `chevron-right`), переключающая `view.newEpicAgentPickerOpen`.

- [ ] **Step 3: Run tests and Herdr mod check**

Run: `bun test`
Expected: PASS (все тесты проходят).

Run: `herdr-app check mods/kanban` (или путь к моду, если `herdr-app` доступен в PATH)
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add mods/kanban/main.js mods/kanban/board.js
git commit -m "feat(kanban): replace new epic bar with manual/agent modal"
```
