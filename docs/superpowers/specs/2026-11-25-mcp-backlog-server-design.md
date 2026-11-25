# Контракт MCP-сервера `herdr-kanban` и структура модуля (v1)

**Статус:** Проект контракта (`TASK-002.1`)  
**Связанные эпики:** `EPIC-002` (`backlog/002-mcp-backlog-server.md`), `EPIC-003` (`backlog/003-mcp-mod-integration.md`)

## 1. Цель и границы v1

Предоставить AI-агентам (Claude Code, Codex и другим MCP-клиентам) стандартизированный MCP-интерфейс поверх `stdio` для чтения, поиска, создания и безопасного обновления эпиков и задач в `backlog/*.md` без ручного редактирования Markdown.

### Входит в v1

- Локальный MCP-сервер поверх `stdio` (`@modelcontextprotocol/sdk` + `zod`, runtime Bun).
- Один процесс сервера обслуживает один каталог бэклога.
- 9 MCP tools для чтения, поиска, создания и мутации эпиков/задач.
- 2 статических MCP resource (`backlog://epics`, `backlog://guide`) и 1 resource template (`backlog://epic/{id}`).
- 2 MCP prompts (`decompose_epics`, `execute_epic`).
- Оптимистичная проверка ревизии (`SHA-256`), межпроцессная блокировка каталога и сохранение `CRLF`/`LF`.
- Переиспользование чистых функций из `mods/kanban/parser.js` и `mods/kanban/paths.js`.

### Не входит в v1

- `init_backlog` (инициализация `README.md` и стартового эпика остаётся в UI мода; `create_epic` умеет работать с явно заданным пустым каталогом).
- Удаление или переименование эпиков/задач (`delete_epic`, `delete_task`, `rename`), произвольная запись файлов (`write_file`), запуск агентов (`run_agent`).
- Удалённые SSH-бэклоги (остаются read-only в моде).
- Подписки на ресурсы (`resources/subscribe`) и Streamable HTTP транспорт.

---

## 2. Структура модуля и зависимости

### Дерево файлов

```text
herdr-kanban/
├── package.json                        # private workspace root для bun install / bun test
├── mcp/
│   └── backlog-server/
│       ├── package.json                # ESM-пакет, bin: herdr-kanban-mcp, @modelcontextprotocol/sdk, zod
│       ├── cli.js                      # разбор argv/env/cwd, запуск stdio, логи только в stderr
│       ├── server.js                   # фабрика McpServer, регистрация capabilities (tools/resources/prompts)
│       ├── resolve-backlog.js          # разрешение пути к бэклогу, git root, канонизация и проверка границ ФС
│       ├── repository.js               # чтение каталога, индекс эпиков, поиск по ID, применение чистых мутаций, DTO
│       ├── safe-write.js               # SHA-256 ревизии, межпроцессная блокировка, атомарная запись, EOL/BOM
│       ├── schemas.js                  # Zod-схемы входов и выходов, общие ограничения строк/ID
│       ├── errors.js                   # доменные ошибки, маппинг в MCP tool error и JSON-RPC error.data
│       ├── tools.js                    # тонкие адаптеры 9 MCP tools
│       ├── resources.js                # адаптеры backlog://epics, backlog://epic/{id}, backlog://guide
│       └── prompts.js                  # адаптеры decompose_epics и execute_epic
├── mods/
│   └── kanban/
│       ├── parser.js                   # чистый парсер/сериализатор (без host/UI/Node/Bun/SDK/Zod)
│       └── paths.js                    # чистые path-хелперы (без host/UI/Node/Bun/SDK/Zod)
└── tests/
    ├── mcp-resolve.test.js             # тесты разрешения каталога и безопасности путей
    ├── mcp-safe-write.test.js          # тесты блокировок, конфликтов ревизий и CRLF/LF
    ├── mcp-tools.test.js               # unit-тесты схем, DTO и всех 9 tools
    ├── mcp-resources-prompts.test.js   # тесты resources и prompts
    └── mcp-stdio-e2e.test.js           # сквозной тест через реальный MCP SDK client поверх stdio
```

### Границы зависимостей

- Зависимость строго однонаправленная: `mcp/backlog-server/*` → `mods/kanban/parser.js` и `mods/kanban/paths.js`.
- `mods/kanban/` **ничего не импортирует** из `mcp/backlog-server/`, чтобы `herdr-app check ~/.config/herdr-app/mods/kanban` не тянул серверные зависимости.
- `mods/kanban/parser.js` и `mods/kanban/paths.js` остаются без импортов `herdr`, `gpui-*`, `node:*`, `bun:*`, `@modelcontextprotocol/sdk` и `zod`.
- `mcp/backlog-server/` не импортирует `mods/kanban/main.js` (`writeTextFile`, `watchFolder`, SSH и UI-уведомления принадлежат Herdr).
- Корневой `package.json` (`"private": true`, `"type": "module"`, `"workspaces": ["mcp/backlog-server"]`) позволяет устанавливать зависимости одной командой `bun install` и запускать `bun test` из корня репозитория.

### Контракт интеграции для `EPIC-003`

- Ключ в `.mcp.json` (в активном `projectRoot`): `mcpServers["herdr-kanban"]`.
- Формат записи:
  ```json
  {
    "mcpServers": {
      "herdr-kanban": {
        "command": "bun",
        "args": [
          "<абсолютный путь к mcp/backlog-server/cli.js>",
          "--backlog-dir",
          "<абсолютный путь к активному backlogDir>"
        ]
      }
    }
  }
  ```
- Сервер не создаёт и не редактирует `.mcp.json`.
- Изменения `.md` файлов, сделанные сервером, подхватываются доской через существующий `watchFolder` и резервный опрос; отдельный RPC для обновления UI не требуется.

---

## 3. CLI, конфигурация и разрешение каталога бэклога

### Аргументы и переменные окружения

```sh
bun mcp/backlog-server/cli.js [--backlog-dir <dir>]
```

Приоритет источника пути:
1. Явный CLI-флаг `--backlog-dir <dir>` (или `--backlog-dir=<dir>`).
2. Переменная окружения `HERDR_BACKLOG_DIR`.
3. Автопоиск от `process.cwd()`.

Правила конфигурации:
- Повтор `--backlog-dir`, пустое значение явного флага/переменной или неизвестные позиционные аргументы завершают процесс до запуска `stdio` с сообщением в `stderr` и ненулевым кодом выхода.
- Явный путь указывает **непосредственно каталог эпиков** (не корень проекта). При ошибке явного пути сервер не переключается на автопоиск в другом каталоге.
- `stdout` зарезервирован исключительно под JSON-RPC фреймы MCP; любая диагностика пишется только в `stderr`.

### Алгоритм автопоиска и валидации

1. Раскрытие `~` / `~/` через `expandTilde(p, os.homedir())`; относительные пути разрешаются от стартового `cwd`.
2. Для ФС используются нативные `path.resolve`, `fs.realpath`, `fs.lstat` / `fs.stat`.
3. При автопоиске кандидаты проверяются в порядке, согласованном с `mods/kanban/main.js:510-567`:
   - `<cwd>/backlog`, `<cwd>/docs/backlog`, `<cwd>/.backlog`
   - если `git -C <cwd> rev-parse --show-toplevel` (без shell) вернул отличный от `cwd` корень `<top>`: `<top>/backlog`, `<top>/docs/backlog`, `<top>/.backlog`
   - сам `<cwd>` (в строгом режиме)
4. Канонически одинаковые кандидаты проверяются однократно. Поиск по всему диску, произвольным родителям или `$HOME` (при наличии `cwd`) не выполняется.
5. Критерии принятия кандидата при автопоиске:
   - Именованный кандидат (`backlog`, `docs/backlog`, `.backlog`): содержит хотя бы один файл `isEpicFilename`, либо путь оканчивается на `/backlog` и содержит хотя бы один `.md` файл (например, только `README.md`).
   - Сам `<cwd>`: содержит хотя бы один файл `isNumberedEpicFilename`.
6. Явно заданный существующий пустой каталог допустим: `list_epics` возвращает пустой список, первый `create_epic` создаёт `001-<slug>.md` (`EPIC-001`).
7. Сервер никогда не вызывает `mkdir`. Ошибка прав доступа (`EACCES`/`EPERM`) не маскируется под отсутствие каталога.
8. Если каталог не найден при старте, `initialize`, `tools/list`, `resources/list`, `resources/templates/list` и `prompts/list` работают штатно; вызовы данных возвращают `BACKLOG_NOT_FOUND` (при автопоиске поиск повторяется на следующем запросе). После первого успешного разрешения канонический корень закрепляется на время жизни процесса.
9. Индексируются только непосредственные обычные файлы (`dirent.isFile()`, без следования symlink/junction дочерних файлов) с именем, проходящим `isEpicFilename`. Обращение к файлу выполняется только через проверенный индекс, никогда через `path.join(root, userInput)`.

---

## 4. Модель данных (DTO) и адресация

### Идентификаторы и адресация

- Агент адресует эпики и задачи по ID (`EPIC-NNN`, `TASK-NNN.K`), а не по путям к файлам или `lineIndex`.
- Публичная грамматика ID:
  - `EpicId`: `/^EPIC-[0-9]{1,12}$/`
  - `TaskId`: `/^TASK-[0-9]{1,12}(?:\.[0-9]{1,12})+$/`
  - `Revision`: `/^[0-9a-f]{64}$/` (SHA-256 исходных байтов файла в hex lowercase)
- Сравнение ID сохраняет точное написание, возвращённое `parseEpicFile` (`EPIC-1` не преобразуется молча в `EPIC-001`).
- Задачи без явного ID (которым `parseEpicFile` присваивает `#1`, `#2`) и эпики с нечисловым fallback-ID отображаются в чтении с `addressable: false`, но не могут быть целью мутаций и не имеют URI `backlog://epic/{id}`.
- Если в каталоге обнаружены два файла с одинаковым `epic.id` или внутри эпика две задачи с одинаковым `task.id`, такие сущности помечаются `addressable: false`, а попытка чтения/мутации по этому ID возвращает `AMBIGUOUS_ID`.

### Структуры DTO

```ts
type Status = "todo" | "in_progress" | "blocked" | "done";
type Priority = "P0" | "P1" | "P2" | "P3";

interface TaskCounts {
  total: number;
  todo: number;
  in_progress: number;
  blocked: number;
  done: number;
}

interface EpicRef {
  id: string;
  number: number;
  title: string;
  filename: string;          // только basename, без абсолютного пути
  project: string | null;
  status: Status;            // эффективный статус (explicitStatus ?? inferEpicStatus)
  priority: Priority | null;
  counts: TaskCounts;
  revision: string;          // SHA-256 исходных байтов файла
  addressable: boolean;
}

interface TaskDTO {
  id: string;
  title: string;
  status: Status;
  subitems: string[];
  addressable: boolean;
}

interface EpicDTO extends EpicRef {
  goal: string;              // Markdown без заголовка секции, "" если отсутствует
  dod: string;               // Markdown без заголовка секции, "" если отсутствует
  summary: string;           // Markdown без заголовка секции, "" если отсутствует
  tasks: TaskDTO[];
}

interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

interface SearchHit {
  kind: "epic" | "task";
  epicId: string;
  filename: string;
  taskId: string | null;
  title: string;
  field: "id" | "title" | "project" | "goal" | "dod" | "summary" | "subitems";
  excerpt: string;           // фрагмент вокруг первого совпадения, до 240 символов
  revision: string;
}
```

Порядок сортировки:
- Эпики: по возрастанию `number`, затем по `filename` (лексикографически по кодовым единицам).
- Задачи внутри эпика: в порядке следования в файле.

---

## 5. MCP Tools и Zod-схемы

### Общие примитивы Zod (`schemas.js`)

```js
import { z } from "zod";

export const StrictObject = (shape) => z.object(shape).strict();

export const EpicIdSchema = z.string().regex(/^EPIC-[0-9]{1,12}$/);
export const TaskIdSchema = z.string().regex(/^TASK-[0-9]{1,12}(?:\.[0-9]{1,12})+$/);
export const RevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const StatusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
export const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const SingleLineSchema = (maxLen) =>
  z.string().max(maxLen).regex(/^[^\r\n\u0000]+$/).trim().min(1);

export const TitleSchema = SingleLineSchema(160);

// Запрещаем явный префикс ID (TASK-001.1 и т.п.), чтобы addTaskToEpic всегда генерировал следующий номер.
export const TaskTitleSchema = TitleSchema.refine(
  (s) => !/^[A-Z]+-\d+(?:\.\d+)*\b/.test(s),
  "Task title must not start with an explicit ID prefix",
);

// Порядок нормализации и валидации: сначала ограничиваем длину и проверяем исходную строку
// на отсутствие NUL и одиночного CR (разрешая пары CRLF) до trim(), затем выполняем trim()
// (совместимо с генерацией JSON Schema для tools/list), и после этого проверяем
// структурные заголовки и разделитель на том тексте, который попадёт в .md файл.
export const MarkdownBodySchema = z
  .string()
  .max(16000)
  .regex(/^(?:[^\r\u0000]|\r\n)*$/, "Body must not contain NUL or bare CR")
  .trim()
  .refine(
    (s) =>
      !s
        .replace(/\r\n/g, "\n")
        .split("\n")
        .some((line) => /^#{1,2}\s/.test(line) || line.trim() === "---"),
    "Body must not contain H1/H2 headings or '---' separator lines",
  );

export const NonEmptyMarkdownBodySchema = MarkdownBodySchema.refine(
  (s) => s.length > 0,
  "Body must not be empty after trimming",
);

export const TaskInitSchema = StrictObject({
  title: TaskTitleSchema,
  subitems: z.array(SingleLineSchema(500)).max(32).default([]),
});

export const PaginationShape = {
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};

export const OptimisticEditShape = {
  epicId: EpicIdSchema,
  expectedRevision: RevisionSchema,
};
```

**Инвариант нормализации и валидации:** для всех строковых полей (`SingleLineSchema`, `TitleSchema`, `TaskTitleSchema`, `MarkdownBodySchema`, `NonEmptyMarkdownBodySchema`) запрещённые управляющие символы (`\0`, одиночный `\r`, а для однострочных полей и `\n`) проверяются на исходной строке **до** `.trim()` (при этом пары `\r\n` в `MarkdownBodySchema` разрешены). Затем выполняется `.trim()`, и только после него проверяются структурные ограничения (префикс ID, заголовки `# `/`## `, разделитель `---`, непустота). Переводы строк `\r\n` приводятся к `\n` при проверке и перед передачей в сериализаторы (`createEpicMarkdown`, `updateEpicSummary`, `addTaskAndSyncEpic`), поэтому повторный `.trim()` внутри `parser.js` идемпотентен и не может превратить отступ в структурный заголовок.

### Формат успешного ответа tool

Каждый tool возвращает:
```json
{
  "isError": false,
  "structuredContent": { "ok": true, "data": { ... } },
  "content": [
    { "type": "text", "text": "{\"ok\":true,\"data\":{...}}" }
  ]
}
```
`content[0].text` содержит сериализованный JSON того же объекта `structuredContent`. Для каждого tool объявляется `outputSchema` успешного ответа.

### Спецификация 9 tools

| Tool | Входная Zod-схема | `data` в ответе | Семантика и edge cases |
|---|---|---|---|
| `list_epics` | `StrictObject({ status: StatusSchema.optional(), priority: PrioritySchema.optional(), query: SingleLineSchema(256).optional(), ...PaginationShape })` | `Page<EpicRef>` | Фильтры объединяются по `AND`. `status` сравнивается с эффективным статусом. `priority: null` не совпадает с `P0`–`P3`. `query` ищет литеральную подстроку (NFC + lowercase) по полям эпика и его задач; каждый эпик попадает в выдачу не более одного раза. |
| `get_epic` | `StrictObject({ epicId: EpicIdSchema })` | `{ epic: EpicDTO }` | Читает свежий снимок файла с диска; возвращает цель, задачи с подпунктами, DoD, итог реализации и актуальную `revision`. |
| `search_backlog` | `StrictObject({ query: SingleLineSchema(256), ...PaginationShape })` | `Page<SearchHit>` | Литеральный поиск подстроки (NFC + lowercase, без regex). Поля эпика проверяются в порядке `id`, `title`, `project`, `goal`, `dod`, `summary`; поля задачи — `id`, `title`, `subitems`. Не более одного hit на сущность (`field` — первое совпавшее поле, `excerpt` — до 240 символов вокруг первого совпадения). Внутри эпика сначала hit эпика, затем hits его задач. |
| `create_epic` | `StrictObject({ title: TitleSchema, priority: PrioritySchema.default("P1"), goal: MarkdownBodySchema.default(""), project: SingleLineSchema(160).optional(), tasks: z.array(TaskInitSchema).max(100).default([]), dod: z.array(SingleLineSchema(500)).max(100).default([]) })` | `{ epic: EpicDTO, created: true }` | Под межпроцессной блокировкой вычисляет `nextEpicNumber(epics)` (диапазон `1..8999`, иначе `NUMBER_EXHAUSTED`), генерирует имя через `slugifyEpicFilename`, проверяет отсутствие коллизии по ID и числовому префиксу файла, а также длину basename в байтах. Создаёт файл в UTF-8/LF без перезаписи существующего. Все задачи стартуют в `todo` с ID `TASK-NNN.1..n`. |
| `update_epic_status` | `StrictObject({ ...OptimisticEditShape, status: StatusSchema })` | `{ epic: EpicDTO, changed: boolean }` | Меняет только строку `**Status:**` эпика через `updateEpicStatus`, не каскадирует на задачи. Если статус ранее вычислялся без строки `**Status:**`, установка явного статуса изменяет файл (`changed: true`) даже при совпадении эффективного статуса. |
| `update_epic_priority` | `StrictObject({ ...OptimisticEditShape, priority: PrioritySchema })` | `{ epic: EpicDTO, changed: boolean }` | Обновляет или вставляет `**Priority:**` через `updateEpicPriority`. |
| `update_task_status` | `StrictObject({ ...OptimisticEditShape, taskId: TaskIdSchema, status: StatusSchema })` | `{ epic: EpicDTO, task: TaskDTO, changed: boolean }` | Находит ровно одну задачу по `taskId` в актуальном снимке, передаёт её внутренний `lineIndex` в `updateTaskStatus(raw, lineIndex, status)`. Штатно синхронизирует статус эпика (включая приоритет `blocked`). |
| `add_task` | `StrictObject({ ...OptimisticEditShape, title: TaskTitleSchema, subitems: z.array(SingleLineSchema(500)).max(32).default([]) })` | `{ epic: EpicDTO, task: TaskDTO, changed: true }` | Добавляет одну `todo`-задачу через `addTaskAndSyncEpic(raw, title, epic.id, { subitems })`. Если эпик был явно `done`, переоткрывает его в `in_progress` (при наличии выполненных задач) или `todo`. Повтор с устаревшей `expectedRevision` отклоняется с `WRITE_CONFLICT` и не создаёт дубль. |
| `update_epic_summary` | `StrictObject({ ...OptimisticEditShape, summary: MarkdownBodySchema })` | `{ epic: EpicDTO, changed: boolean }` | **Replace**, не append. Заменяет тело единственной секции итога (`classifySection === "summary"`), сохраняя исходный заголовок. Если секции нет и `summary.trim() !== ""`, вставляет `## Итог реализации` перед `---` / справочным хвостом / EOF. Пустая строка очищает тело существующей секции (или даёт `changed: false`, если секции нет). При наличии нескольких summary-секций возвращает `UNSUPPORTED_FORMAT`. |

---

## 6. MCP Resources и Prompts

### Resources (`resources.js`)

- `resources/list` возвращает 2 статических ресурса (без дублирования каждого эпика из `backlog://epics`).
- `resources/templates/list` возвращает 1 шаблон `backlog://epic/{id}`.
- `resources/read` возвращает `{ contents: [{ uri, mimeType, text }] }`.

| URI | Тип | MIME | Содержимое |
|---|---|---|---|
| `backlog://epics` | Static | `application/json` | `JSON.stringify({ items: EpicRef[], total: number })` — полный упорядоченный индекс эпиков без тел секций. |
| `backlog://guide` | Static | `text/markdown` | Содержимое локального `README.md` в каталоге бэклога; если `README.md` отсутствует в существующем каталоге — результат `createBacklogGuideMarkdown()` без записи на диск. Ошибка чтения/прав не подменяется шаблоном. |
| `backlog://epic/{id}` | Template | `text/markdown` | Исходный Markdown файла эпика целиком (включая прочие секции и справочный хвост после `---`). Допустим только один сегмент `id`, проходящий `EpicIdSchema`; URI с query, fragment, credentials или закодированным `/` отклоняются. |

### Prompts (`prompts.js`)

`prompts/get` возвращает `{ description: string, messages: [{ role: "user", content: { type: "text", text: string } }] }`. Получение prompt не изменяет файлы на диске.

| Имя | Аргументы | Поведение |
|---|---|---|
| `decompose_epics` | `description` (обязательный, `NonEmptyMarkdownBodySchema`), `project` (опциональный, `SingleLineSchema(160)`) | Формирует инструкцию через `buildCreateEpicsPrompt(..., { mode: "mcp" })`: прочитать `backlog://guide`, проверить существующие эпики через `list_epics`/`search_backlog`, разбить описание на непересекающиеся эпики с задачами, подпунктами и DoD и создать их через `create_epic` (без ручного создания `.md` и угадывания номеров). |
| `execute_epic` | `epicId` (обязательный, `EpicIdSchema`), `taskId` (опциональный, `TaskIdSchema`) | Читает актуальный эпик (и проверяет наличие/уникальность `taskId` внутри него). Формирует инструкцию через `buildAgentPrompt(epic, task, projectRoot, { mode: "mcp" })`: работать через `get_epic`, передавать актуальную `expectedRevision` в `update_task_status` / `update_epic_status`, подтверждать выполнение проверками и фиксировать результат через `update_epic_summary`. При переданном `taskId` явно запрещает закрывать весь эпик, если остались другие открытые задачи. |

---

## 7. Формат ошибок и протокол безопасной записи

### Ошибки MCP Tools

При ошибке известного tool возвращается:
```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "{\"ok\":false,\"error\":{\"code\":\"WRITE_CONFLICT\",\"message\":\"...\",\"retryable\":true,\"details\":{\"epicId\":\"EPIC-002\",\"expectedRevision\":\"...\",\"currentRevision\":\"...\"}}}"
    }
  ]
}
```
Правила:
- `structuredContent` при ошибке **не отправляется**, чтобы не нарушать `outputSchema` успешного ответа.
- `details` содержит только публичные поля (`epicId`, `taskId`, `field`, `expectedRevision`, `currentRevision`, `filename`), без stack trace, содержимого файлов и абсолютных путей ФС.
- Ошибки валидации Zod внутри валидного `tools/call` преобразуются в тот же конверт с кодом `INVALID_ARGUMENT` / `INVALID_ID`.
- Некорректный JSON-RPC, неизвестный метод или неизвестный tool остаются ошибками протокола JSON-RPC.

### Ошибки Resources и Prompts

У `resources/read` и `prompts/get` нет `isError`; ошибки возвращаются как JSON-RPC error с тем же объектом `{ code, message, retryable, details }` в `error.data`:
- `-32602` (Invalid params): `INVALID_ARGUMENT`, `INVALID_ID`
- `-32002` (Resource not found): `EPIC_NOT_FOUND`, `TASK_NOT_FOUND`, `BACKLOG_NOT_FOUND`
- `-32000` (Server/domain error): `AMBIGUOUS_ID`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_FILESYSTEM`, `NOT_DIRECTORY`, `PERMISSION_DENIED`, `UNSAFE_PATH`, `BACKLOG_BUSY`, `IO_ERROR`
- `-32603` (Internal error): `INTERNAL_ERROR`

### Каталог кодов ошибок

| Код | `retryable` | Значение |
|---|---|---|
| `INVALID_ARGUMENT` | `false` | Нарушение Zod-схемы, запрещённые символы/заголовки в теле, слишком длинное имя файла. |
| `INVALID_ID` | `false` | Неверный формат `epicId`, `taskId` или URI ресурса. |
| `BACKLOG_NOT_FOUND` | `false` | Каталог бэклога не найден или перестал существовать. |
| `NOT_DIRECTORY` | `false` | Указанный путь существует, но не является каталогом. |
| `PERMISSION_DENIED` | `false` | Отказ ОС в доступе к каталогу или файлу. |
| `UNSAFE_PATH` | `false` | Выход за пределы корня бэклога, symlink/junction на файл или недопустимое имя файла. |
| `EPIC_NOT_FOUND` | `false` | Эпик с указанным `epicId` не найден. |
| `TASK_NOT_FOUND` | `false` | Задача с указанным `taskId` не найдена в указанном эпике. |
| `AMBIGUOUS_ID` | `false` | Дублирующийся `epicId` в каталоге или дублирующийся `taskId` в эпике. |
| `UNSUPPORTED_FORMAT` | `false` | Неподдерживаемая структура/кодировка (например, несколько summary-секций или смешанные EOL). |
| `UNSUPPORTED_FILESYSTEM` | `false` | Файловая система не поддерживает атомарную публикацию временного файла без перезаписи (например, `link`). |
| `WRITE_CONFLICT` | `true` | `expectedRevision` не совпадает с диском, файл изменился/исчез до публикации или коллизия при создании. Требует перечитать `get_epic` и переоценить действие. |
| `BACKLOG_BUSY` | `true` | Истёк таймаут ожидания межпроцессной блокировки каталога. |
| `NUMBER_EXHAUSTED` | `false` | Исчерпан диапазон автонумерации `1..8999`. |
| `IO_ERROR` | `true` | Ошибка ввода-вывода ФС при чтении/записи. |
| `INTERNAL_ERROR` | `false` | Непредвиденная внутренняя ошибка сервера. |

### Алгоритм безопасной записи (`safe-write.js`)

1. **Межпроцессная блокировка:** перед любой мутацией или созданием файла захватывается lock-файл каталога (с ограниченным ожиданием и освобождением в `finally`; чужая блокировка не снимается только по возрасту).
2. **Проверка ревизии до no-op:** под блокировкой читаются актуальные байты файла, вычисляется `currentRevision = sha256(bytes)`. Если `currentRevision !== expectedRevision`, сразу возвращается `WRITE_CONFLICT` (даже если целевое состояние уже достигнуто).
3. **Сохранение кодировки и EOL:**
   - Отдельно сохраняется UTF-8 BOM (если присутствовал).
   - Однородные `LF` или `CRLF` и наличие завершающего перевода строки сохраняются чистыми функциями `parser.js`.
   - При смешанных `CRLF`/`LF` в одном файле мутация отклоняется с `UNSUPPORTED_FORMAT`, чтобы не переформатировать чужой файл.
   - Новые файлы (`create_epic`) создаются в UTF-8 без BOM с `LF`.
4. **No-op:** если итоговые байты совпадают с исходными, запись на диск не выполняется (`changed: false`).
5. **Атомарная публикация:**
   - Запись полного содержимого во временный файл рядом с целевым (имя не оканчивается на `.md`, чтобы не попадать в индекс и `watchFolder` как эпик), сохранение прав доступа существующего файла, сброс буферов и закрытие дескриптора до публикации.
   - Повторная проверка цели перед публикацией (для обновления — повторное чтение байтов и сверка `expectedRevision`; для создания — проверка отсутствия целевого файла).
   - Для обновления: атомарная замена целевого файла (`rename`).
   - Для создания: атомарная публикация уже полностью записанного временного файла операцией без замены существующего имени (например, `link(tempPath, targetPath)` с последующим `unlink(tempPath)` в `finally`, либо платформенный `rename` с флагом `NOREPLACE`). Прямое создание целевого `.md` файла (включая `open(..., "wx")` + запись) и связка `exists` + `rename` **запрещены**, так как `wx` делает целевой `.md` видимым до окончания записи и позволяет читателю увидеть пустой или частичный эпик. При коллизии имени (`EEXIST`) возвращается `WRITE_CONFLICT`. Если файловая система не поддерживает атомарную публикацию без перезаписи (`ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`, `EXDEV`, `EPERM` на `link`), возвращается ошибка `UNSUPPORTED_FILESYSTEM` (`retryable: false`) без перехода на прямую запись.
   - Очистка временного файла и снятие блокировки в `finally`.
6. **Граница гарантии:** межпроцессная блокировка полностью сериализует конкурирующие MCP-процессы; повторное чтение перед публикацией обнаруживает уже сохранённые правки UI/редактора, но не является аппаратным CAS против внешнего процесса, пишущего в окно между последней проверкой и `rename` (при создании `link` гарантирует отсутствие перезаписи существующего файла на уровне ФС).

---

## 8. Карта переиспользования `mods/kanban/parser.js` и `mods/kanban/paths.js`

### Существующие функции

| Модуль | Экспорт | Использование в MCP-сервере |
|---|---|---|
| `parser.js` | `COLUMNS`, `PRIORITIES`, `markToStatus`, `statusToMark`, `statusToLine`, `parseStatusValue`, `inferEpicStatus` | Единая модель статусов, маркеров и приоритетов (без fallback на `todo` при валидации ввода). |
| `parser.js` | `isEpicFilename`, `isNumberedEpicFilename`, `parseEpicFile` | Фильтрация файлов каталога, построение индекса, DTO и повторный парсинг после мутации. |
| `parser.js` | `updateEpicStatus`, `updateEpicPriority`, `updateTaskStatus` | Мутации статуса эпика, приоритета и статуса задачи (с синхронизацией статуса эпика). |
| `parser.js` | `nextTaskId`, `addTaskToEpic`, `addTaskAndSyncEpic` | Добавление задачи с автонумерацией `TASK-NNN.K` и переоткрытием `done`-эпика. |
| `parser.js` | `nextEpicNumber`, `slugifyEpicFilename`, `createEpicMarkdown` | Автонумерация эпиков, генерация имени `NNN-<slug>.md` и шаблона нового эпика. |
| `parser.js` | `createBacklogGuideMarkdown` | Резервное содержимое ресурса `backlog://guide` при отсутствии `README.md`. |
| `parser.js` | `buildAgentPrompt`, `buildCreateEpicsPrompt` | Генерация текстов для MCP prompts `execute_epic` и `decompose_epics`. |
| `paths.js` | `normPath`, `joinPath`, `parentDir`, `expandTilde` | Нормализация путей, построение кандидатов автопоиска и раскрытие `~`. |

### Необходимые минимальные расширения `mods/kanban/parser.js` (для `TASK-002.2`–`TASK-002.5`)

1. **`updateEpicSummary(rawText, summary)`**:
   - Заменяет тело единственной секции `classifySection === "summary"` в пределах первого эпика (до `---` + `# `), сохраняя исходный заголовок, `eol` и `endsWithNewline`.
   - При отсутствии секции и непустом `summary` вставляет `## Итог реализации` перед `---` / справочным хвостом / EOF.
   - При наличии более одной summary-секции выбрасывает ошибку с `code = "UNSUPPORTED_FORMAT"`.
2. **Ограничение области правки первым эпиком**:
   - Выделить внутренний helper границ первого эпика (до `---` + `# `), чтобы `updateEpicStatus`, `updateEpicPriority` и `addTaskToEpic` не затрагивали справочный хвост после `---`.
3. **Расширение `createEpicMarkdown`**:
   - Добавить опциональные поля `tasks = []` (`Array<{ title, subitems? }>`) и `dod = []` (`string[]`).
   - При отсутствии `tasks` и `dod` вывод остаётся побайтно идентичным текущему; одновременная передача непустых `firstTask` и `tasks` считается ошибкой.
4. **Расширение `addTaskToEpic` / `addTaskAndSyncEpic`**:
   - Добавить опциональный параметр `options = { subitems: [] }` для вставки вложенных подпунктов `  - ...` при создании задачи.
5. **Режим `mode` в генераторах промптов**:
   - Добавить опциональный `mode: "markdown" | "mcp"` (по умолчанию `"markdown"`) в `buildAgentPrompt` и `buildCreateEpicsPrompt`, сохраняя обратную совместимость для `mods/kanban/main.js` до реализации `EPIC-003`.

---

## 9. Распределение по задачам `EPIC-002`

- **`TASK-002.2`**: `package.json` (root + `mcp/backlog-server`), `cli.js`, `server.js`, `resolve-backlog.js`, `safe-write.js`, `errors.js`.
- **`TASK-002.3`**: `repository.js` (чтение/индекс/поиск), `schemas.js`, `tools.js` (`list_epics`, `get_epic`, `search_backlog`).
- **`TASK-002.4`**: расширения `mods/kanban/parser.js` (`updateEpicSummary`, `createEpicMarkdown`, `addTaskAndSyncEpic`, границы первого эпика) + `tools.js` (`create_epic`, `update_epic_status`, `update_epic_priority`, `update_task_status`, `add_task`, `update_epic_summary`).
- **`TASK-002.5`**: `resources.js`, `prompts.js`, режим `mode: "mcp"` в `buildAgentPrompt` и `buildCreateEpicsPrompt`.
- **`TASK-002.6`**: unit- и интеграционные тесты в `tests/mcp-*.test.js` (включая сквозной `stdio` тест через MCP SDK client) и документация в `README.md`.

---

## 10. План контрактных тестов

1. **Нормализация и структурная валидация (`schemas.js` + `tools.js`):**
   - `create_epic` с `goal: "  ## Задачи"` → ошибка `INVALID_ARGUMENT` (`isError: true`), новый `.md` файл в каталоге бэклога **не создаётся**.
   - `create_epic` с `goal: "\n  # EPIC-999 — Fake\n"` или `goal: "  ---  "` → `INVALID_ARGUMENT`, файл не создаётся.
   - `update_epic_summary` с `summary: "  ## Задачи"` → `INVALID_ARGUMENT`, существующий файл не изменяется.
   - `update_epic_summary` с `summary: "текст\r"` (и `create_epic` с `goal: "текст\r"`) → `INVALID_ARGUMENT` (одиночный CR отклоняется до `.trim()`), файл не изменяется и не создаётся.
   - Положительный пример с `CRLF`: `create_epic` с `goal: "Первая строка\r\nВторая строка"` и `update_epic_summary` с `summary: "Итог 1\r\nИтог 2"` → успех, текст корректно записывается в файл (с сохранением `LF` для нового файла и исходного `EOL` для существующего).
   - `add_task` с `title: "  TASK-001.1 Дубль"` → `INVALID_ARGUMENT` (проверка префикса ID после `trim()`).
   - `create_epic` с `goal: "  ### Детали\n  Текст  "` → успех, в `## Цель` записывается `"### Детали\n  Текст"`.
2. **Атомарная публикация и конкурентная запись (`safe-write.js`):**
   - `create_epic` пишет полный контент во временный файл (не `.md`), закрывает дескриптор и публикует без перезаписи (`link` + `unlink` или `NOREPLACE`); при коллизии (`EEXIST`) возвращает `WRITE_CONFLICT`.
   - При отказе ФС в атомарной публикации без перезаписи (`ENOTSUP`/`EOPNOTSUPP`/`ENOSYS`) возвращается `UNSUPPORTED_FILESYSTEM` (`retryable: false`) без перехода на `wx` или `exists` + `rename`.
   - Два параллельных `create_epic` получают последовательные номера без перезаписи; два конкурирующих обновления с одной `expectedRevision` дают один успех и один `WRITE_CONFLICT`.
   - Сохранение `CRLF`/`LF`, `endsWithNewline`, UTF-8 BOM и отказ при смешанных EOL (`UNSUPPORTED_FORMAT`).
3. **Разрешение каталога и безопасность путей (`resolve-backlog.js`):**
   - Приоритет `--backlog-dir` → `HERDR_BACKLOG_DIR` → автопоиск (`cwd` и `git rev-parse --show-toplevel`), раскрытие `~`, отказ без fallback при неверном явном пути, игнорирование symlink/junction дочерних файлов (`UNSAFE_PATH`).
4. **Чтение, мутации, ресурсы и промпты (`tools.js`, `resources.js`, `prompts.js`):**
   - Все 9 tools, пагинация, `addressable: false` для `#1` и дубликатов ID (`AMBIGUOUS_ID`), `done` + `add_task`, `update_epic_summary` (replace, вставка, очистка, ошибка при двух summary-секциях).
   - `resources/list`, `resources/templates/list`, `resources/read` (`backlog://epics`, `backlog://guide`, `backlog://epic/{id}`), `prompts/list`, `prompts/get` (`decompose_epics`, `execute_epic`).
5. **Сквозной `stdio` тест (`tests/mcp-stdio-e2e.test.js`):**
   - Реальный MCP SDK client запускает `cli.js` поверх `stdio` во временном каталоге: `initialize` → `tools/list` → `create_epic` → `get_epic` → `update_task_status` → конфликт старой ревизии (`WRITE_CONFLICT`) → `resources/list` → `resources/read` → `prompts/get`.

