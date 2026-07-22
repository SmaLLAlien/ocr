# open-code-review-ts

**AI-код-ревью в командной строке.** TypeScript-порт [alibaba/open-code-review](https://github.com/alibaba/open-code-review) (`ocr`) — инструмент, который читает git-диффы или целые файлы, отдаёт их LLM-агенту с набором инструментов (чтение файлов, поиск по коду, диффы соседних файлов) и возвращает построчные комментарии ревью с категорией, серьёзностью и предложением исправления.

Работает с любым LLM-провайдером: Anthropic, OpenAI, DeepSeek, Qwen, Gemini, локальные модели через OpenAI-совместимые эндпоинты.

---

## Содержание

- [Как это работает](#как-это-работает)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Команды](#команды)
  - [ocr review](#ocr-review--ревью-диффа)
  - [ocr scan](#ocr-scan--полнофайловый-скан)
  - [ocr config](#ocr-config--настройка)
  - [ocr llm](#ocr-llm--утилиты-llm)
  - [ocr rules](#ocr-rules--правила-ревью)
  - [ocr session](#ocr-session--история-сессий)
- [Форматы вывода](#форматы-вывода)
- [Конфигурация](#конфигурация)
  - [Провайдеры и модели](#провайдеры-и-модели)
  - [Переменные окружения](#переменные-окружения)
  - [Свои правила ревью (rule.json)](#свои-правила-ревью-rulejson)
  - [MCP-серверы](#mcp-серверы)
- [Инструменты, доступные LLM](#инструменты-доступные-llm)
- [Какие файлы попадают в ревью](#какие-файлы-попадают-в-ревью)
- [Сессии и resume](#сессии-и-resume)
- [Использование в CI](#использование-в-ci)
- [Отличия от Go-версии](#отличия-от-go-версии)
- [Разработка](#разработка)

---

## Как это работает

`ocr` — это не «отправить дифф в чат». Это агентный конвейер с детерминированной обвязкой:

```
git diff / файлы
      │
      ▼
 Фильтрация ──── бинарные, неподдерживаемые расширения, тестовые файлы,
      │          include/exclude-правила, слишком большие диффы (>80% бюджета токенов)
      ▼
 Правила ─────── к каждому файлу подбирается своё правило ревью
      │          (java.md / ts_js.md / yaml.md / … или ваши собственные)
      ▼
 Plan-фаза ───── для крупных изменений (>50 строк) отдельный LLM-вызов
      │          строит план: на что смотреть в этом файле
      ▼
 Tool-loop ───── LLM итеративно вызывает инструменты: читает файлы,
      │          ищет по коду, смотрит диффы соседних файлов — и оставляет
      │          комментарии; до 30 раундов на файл, файлы параллельно
      ▼
 Сжатие ──────── при заполнении контекста на 60%/80% история диалога
      │          автоматически суммаризируется (трёхзонная компрессия)
      ▼
 Review-filter ─ отдельный LLM-проход отсеивает комментарии,
      │          опровергаемые самим диффом (ложные срабатывания)
      ▼
 Резолв строк ── каждый комментарий привязывается к точным номерам строк
      │          текстовым матчингом по ханкам диффа (+ LLM-fallback)
      ▼
 Вывод ───────── терминал (ANSI) или JSON для CI; сессия пишется на диск
                 и может быть продолжена через --resume
```

Каждый файл ревьюится в изолированной задаче: паника/ошибка/таймаут одного файла не роняет остальные.

---

## Установка

Требования: **Node.js ≥ 20**, **git ≥ 2.41**.

```bash
cd open-code-review-ts
npm install
npm run build
npm link          # создаёт глобальную команду ocr
```

Проверка: `ocr version`.

Без глобальной установки: `node <путь>/dist/cli.js <команда>`.
Удаление: `npm unlink -g open-code-review-ts`.

---

## Быстрый старт

```bash
# 1. Настроить провайдера (интерактивный мастер)
ocr config provider

# 2. Проверить соединение
ocr llm test

# 3. Посмотреть, что попадёт в ревью (без трат на LLM)
cd мой-проект
ocr review --preview

# 4. Ревью
ocr review                     # незакоммиченные изменения
ocr review -c abc123           # конкретный коммит
ocr review --from main --to feature-branch
```

---

## Команды

Общий вид: `ocr <команда> [флаги]`. Все длинные флаги принимаются и как `--flag value`, и как `--flag=value`; короткие формы — только точные (`-c`, `-f`, `-b`, `-B`, `-p`). `-h`/`--help` у каждой команды.

| Команда | Алиас | Назначение |
|---|---|---|
| `review` | `r` | Ревью git-диффа (workspace / коммит / диапазон веток) |
| `scan` | `s` | Ревью целых файлов, дифф не нужен |
| `config` | — | Настройка провайдеров, моделей, MCP |
| `llm` | — | Проверка соединения, список провайдеров |
| `rules` | — | Отладка правил ревью |
| `session` | `sessions` | История прошлых запусков |
| `version` | `-V` | Версия |

Код выхода: `0` — успех, `1` — ошибка (текст в stderr с префиксом `Error:`).

---

### `ocr review` — ревью диффа

Три режима, определяются флагами:

| Режим | Как вызвать | Что ревьюится |
|---|---|---|
| **workspace** (по умолчанию) | `ocr review` | Незакоммиченные изменения: staged + unstaged + untracked-файлы |
| **commit** | `ocr review -c <hash\|tag>` | Один коммит относительно родителя |
| **range** | `ocr review --from <ref> --to <ref>` | Дифф `merge-base(from,to)..to` — классический «ревью ветки против базы» |

Все флаги:

```
--from string            исходный ref диапазона (обязателен вместе с --to)
--to string              конечный ref диапазона
-c, --commit string      один коммит или тег
--resume string          продолжить прошлую сессию по её id (только commit/range-режимы)
-p, --preview            показать какие файлы попадут в ревью, БЕЗ вызовов LLM
-f, --format string      формат вывода: text (по умолчанию) | json
--audience string        human (прогресс в терминал, по умолчанию) | agent (только итог)
-b, --background string  бизнес-контекст задачи, попадает в промпт
-B, --background-file    то же из Markdown-файла (лимит 1 МБ / 8000 символов,
                         санитизация невидимых символов; совмещается с -b)
--model string           разовая смена модели (валидируется по списку провайдера)
--rule string            путь к своему rule.json (высший приоритет правил)
--exclude string         доп. exclude-глобы через запятую ('**/gen/**,**/*.min.js')
--concurrency int        параллельных файлов (по умолчанию 8)
--timeout int            таймаут на файл, минут (по умолчанию 10; 0 = без)
--max-tools int          лимит раундов инструментов на файл (0 = из шаблона: 30; мин 10)
--max-git-procs int      лимит одновременных git-подпроцессов (16)
--tools string           свой tools.json вместо встроенного
--repo string            корень репозитория (по умолчанию: текущая папка;
                         автоматически поднимается до корня git при запуске из подпапки)
--gitlab                 опубликовать комментарии в GitLab MR после ревью
--gitlab-url string      GitLab API v4 (по умолчанию: env CI_API_V4_URL)
--gitlab-project string  id проекта или URL-encoded путь (по умолчанию: env CI_PROJECT_ID)
--gitlab-mr string       IID merge request'а (по умолчанию: env CI_MERGE_REQUEST_IID)
                         токен — только из env: OCR_GITLAB_TOKEN или GITLAB_TOKEN
```

Особенности поведения:

- **Защита от инъекций:** значения `--from/--to/--commit` не могут начинаться с `-` и проверяются через `git rev-parse --verify` до любых других git-вызовов.
- **Автоконтекст коммита:** при `--commit` без `--background` в качестве контекста автоматически берётся сообщение коммита.
- **Ограничение размера:** файл, чей дифф сам по себе больше 80% токен-бюджета, пропускается с предупреждением.
- При падении ревью CLI печатает id сессии и готовую команду для повтора: `retry with: --resume <id>`.

Пример вывода превью (`-p`):

```
Preview: 15 file(s) changed  |  +1323  -15

Will review (11):
  [M]  src/api/handler.ts        +120  -3
  [A]  src/api/limits.ts         +88   -0
  ...

Excluded from review (4):
  [B]  assets/logo.png            (binary)
  [M]  src/api/handler_test.ts   (default_path)
```

Бейджи статуса: `[A]` added, `[M]` modified, `[D]` deleted, `[R]` renamed, `[B]` binary, `[S]` scan. Причины исключения: `binary`, `unsupported_ext`, `default_path` (тестовые файлы и т.п.), `user_exclude` (ваши правила), `deleted`.

Пример вывода комментария (text-режим):

```
─── src/api/handler.ts:42-45 ───
[bug · high] Переменная rateLimit читается до инициализации при
холодном старте: init() вызывается асинхронно, а handler может
быть вызван раньше её завершения.

-  const limit = rateLimit.current;      ← красный фон
+  const limit = await ensureInit();     ← зелёный фон
```

и в конце сводка:

```
[ocr] Summary: 11 file(s) reviewed, 3 comment(s), ~46203 token(s) used
      (input: ~43351, output: ~2852), cache(read: ~18538, write: ~0), 1m13s elapsed
```

---

### `ocr scan` — полнофайловый скан

Ревью **целых файлов**, а не диффов. Git не обязателен — в обычной папке используется обход файловой системы с учётом `.gitignore`.

```
ocr scan                                # весь репозиторий
ocr scan --path src/core                # одна папка
ocr scan --path a.ts,b.ts               # конкретные файлы
ocr scan --preview                      # что будет сканироваться (без LLM)
```

Флаги (сверх общих с review: `--rule`, `--exclude`, `--format`, `--audience`, `--background`, `--model`, `--concurrency`, `--timeout`, `--max-tools`, `--max-git-procs`, `--tools`, `--repo`, `-p`):

```
--path string             какие папки/файлы сканировать (через запятую; пусто = весь репо)
--batch string            стратегия батчей: none | by-language | by-directory
--no-plan                 пропустить PLAN-фазу (быстрее, менее сфокусировано)
--no-dedup                пропустить дедупликацию находок по батчу
--no-summary              пропустить итоговое резюме по проекту
--max-tokens-budget int   жёсткий потолок токенов на весь скан (0 = без лимита)
```

Конвейер скана: перечисление файлов (`git ls-files` tracked+untracked либо обход ФС) → фильтры (бинарные по NUL-сниффингу первых 8 КБ, лимит 2 МиБ на файл, расширения, правила) → **оценка стоимости до старта**:

```
[ocr] estimated cost: ~34 file(s), est. 1.2M input + 180K output ≈ 1.4M total tokens
      (rough; actual reported after run)
```

→ батчи (последовательно, файлы внутри батча параллельно) → на файл: PLAN (LLM строит JSON-чеклист фокус-зон) + MAIN (тот же tool-loop, что в review) → на батч: DEDUP (LLM склеивает дубли находок; при любом сомнении оригиналы сохраняются) → в конце: **PROJECT SUMMARY** — markdown-резюме по всем находкам:

```
──────── Project Summary ────────

### Top Issues
1. **Potential Path Traversal**: WithinBase() сравнивает пути без resolve симлинков...

### Module Hotspots
* `internal/pathutil/` — критично из-за уязвимости сравнения путей

### Quick Wins
* Добавить resolve симлинков перед сравнением путей
```

При заданном `--max-tokens-budget` перед каждым файлом делается прогноз: если потраченное + оценка следующего файла превышает бюджет — оставшиеся файлы пропускаются с предупреждением `token_budget_reached`.

---

### `ocr config` — настройка

Всё хранится в `~/.opencodereview/config.json` (права 0600, ключи маскируются при выводе).

**Интерактивно:**

```
ocr config provider     # мастер: пресет / кастомный / ручной эндпоинт
                        # → API-ключ (скрытый ввод) → модель → автотест соединения
ocr config model        # смена модели текущего провайдера из списка
```

**Скриптуемо — `config set <ключ> <значение>`:**

```bash
# официальный пресет
ocr config set provider anthropic
ocr config set providers.anthropic.api_key sk-ant-xxx      # или через env ANTHROPIC_API_KEY
ocr config set model claude-opus-4-8

# свой OpenAI-совместимый эндпоинт (Gemini, Ollama, корпоративный гейтвей...)
ocr config set provider my-gw
ocr config set custom_providers.my-gw.url https://gw.local/v1
ocr config set custom_providers.my-gw.protocol openai       # openai | anthropic
ocr config set custom_providers.my-gw.api_key $KEY
ocr config set custom_providers.my-gw.model llama-3-70b
ocr config set custom_providers.my-gw.models '["llama-3-70b","llama-3-8b"]'

# тонкая настройка (у providers.* и custom_providers.*)
... .auth_header x-api-key                    # x-api-key | authorization (anthropic-протокол)
... .extra_headers 'X-Team=review,X-Env=ci'   # свои HTTP-заголовки
... .extra_body '{"thinking":{"type":"disabled"}}'   # свои поля в теле запроса
... .timeout_sec 300

# язык ответов ревью
ocr config set language Russian

# MCP-сервер (см. раздел MCP)
ocr config set mcp_servers.codegraph.command npx
ocr config set mcp_servers.codegraph.args '["-y","@acme/codegraph-mcp"]'

# устаревший «ручной» блок (без системы провайдеров)
ocr config set llm.url https://api.example.com/v1/messages
ocr config set llm.auth_token xxx
ocr config set llm.model claude-opus-4-8
ocr config set llm.use_anthropic true
```

**Удаление:** `ocr config unset custom_providers.<имя>` / `ocr config unset mcp_servers.<имя>`. При удалении активного провайдера `provider`/`model` сбрасываются с предупреждением.

Ключи `telemetry.*` принимаются для совместимости с Go-версией, но эффекта не имеют (телеметрия не портирована).

---

### `ocr llm` — утилиты LLM

```
ocr llm test         # резолвит эндпоинт, шлёт тестовый диалог, печатает
                     # Source / URL / Model / ответ модели / ✓
ocr llm providers    # таблица встроенных пресетов: имя, протокол, base URL
```

`llm test` — главный диагностический инструмент: он показывает, **откуда** взялась конфигурация (`Source: OCR config file` / `provider:anthropic` / `OCR environment` / `Claude Code environment` / `Shell rc file`).

---

### `ocr rules` — правила ревью

```
ocr rules check <путь-к-файлу> [--rule custom.json] [--repo dir]
```

Показывает, какое правило ревью применится к файлу: текст правила, слой-источник (`Custom (--rule)` / `Project` / `Global` / `System built-in`) и сматчившийся глоб-паттерн. Незаменимо при отладке своих rule.json.

---

### `ocr session` — история сессий

Каждый запуск review/scan пишет журнал в `~/.opencodereview/sessions/<репо>/<id>.jsonl`.

```
ocr session list [--limit 20] [--json] [--repo dir]
ocr session show <id> [--json] [--repo dir]
```

`list` — таблица: id, режим (workspace/commit/range/full_scan), диапазон, файлы (в т.ч. reused), комментарии, статус (`completed` / `completed (N fail)` / `aborted`), время старта.

`show` — детали: модель, ветка, длительность, счётчики LLM-ошибок и пофайловая таблица (done/reused/failed с текстом ошибки).

---

## Форматы вывода

### `--format text` (по умолчанию)

Прогресс в stdout (`[ocr] ...`, `▶/✔/✘` для вызовов инструментов), комментарии с ANSI-цветами, сводка. `--audience agent` глушит прогресс и оставляет только результат — удобно, когда ocr вызывает другой AI-агент.

### `--format json`

Единственный stdout-вывод — JSON-объект (прогресс глушится автоматически):

```jsonc
{
  "status": "success",              // success | completed_with_warnings |
                                    // completed_with_errors | skipped
  "message": "...",                 // при отсутствии комментариев
  "summary": {
    "files_reviewed": 11,
    "comments": 3,
    "total_tokens": 46203,
    "input_tokens": 43351,
    "output_tokens": 2852,
    "cache_read_tokens": 18538,     // опционально
    "cache_write_tokens": 0,        // опционально
    "elapsed": "1m13s"
  },
  "tool_calls": { "total": 17, "by_tool": { "file_read": 9, "code_search": 5, "code_comment": 3 } },
  "comments": [
    {
      "path": "src/api/handler.ts",
      "content": "Переменная rateLimit читается до инициализации...",
      "existing_code": "const limit = rateLimit.current;",
      "suggestion_code": "const limit = await ensureInit();",
      "start_line": 42,
      "end_line": 45,
      "category": "bug",            // bug | security | performance | maintainability |
                                    // test | style | documentation | other
      "severity": "high"            // critical | high | medium | low
    }
  ],
  "warnings": [                     // опционально
    { "file": "a.ts", "type": "subtask_error", "message": "..." }
  ],
  "project_summary": "...",         // markdown, только у scan
  "resume": {                       // только при --resume
    "resumed_from": "<id>", "reused_files": 6, "rerun_files": 5
  },
  "session_id": "f850c21f-..."
}
```

---

## Конфигурация

### Провайдеры и модели

Встроенные пресеты (`ocr llm providers`): `anthropic`, `openai`, `edenai`, `dashscope`, `dashscope-tokenplan`, `volcengine`, `deepseek`, `tencent-tokenhub`, `hy-tokenplan`, `kimi`, `z-ai`, `z-ai-coding`, `mimo`, `minimax`, `baidu-qianfan`. У каждого — base URL, протокол, env-переменная для ключа и список моделей.

**Два протокола** (формата API): `openai` (Chat Completions — его поддерживает почти любой провайдер, включая Gemini через OpenAI-совместимый эндпоинт Google) и `anthropic` (Messages API — для api.anthropic.com и совместимых прокси; автоматически включается prompt caching через `cache_control: ephemeral`). Любой не-пресетный эндпоинт подключается через `custom_providers` с указанием протокола.

### Переменные окружения

Резолвер ищет эндпоинт по строгому приоритету — **первый источник, где есть URL + токен + модель, побеждает**:

1. **`~/.opencodereview/config.json`** — секция провайдера либо legacy-блок `llm`
2. **OCR env**: `OCR_LLM_URL`, `OCR_LLM_TOKEN`, `OCR_LLM_MODEL`, `OCR_LLM_AUTH_HEADER`, `OCR_USE_ANTHROPIC` (по умолчанию true)
3. **Claude Code env**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`
4. **Shell rc**: экспорты `ANTHROPIC_*` из `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`

Поверх любого источника действуют глобальные оверрайды: `OCR_LLM_TIMEOUT` (секунды), `OCR_LLM_EXTRA_HEADERS` (`key=value,key2="a,b"`; заголовки authorization/x-api-key/content-type/user-agent запрещены). Суффикс модели вида `[1m]` автоматически срезается. `OCR_CONFIG_PATH` подменяет путь конфига **только для чтения** (записи всегда идут в стандартный путь — защита от подмены).

Ключи пресетов из env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY` и т.д. — используются, когда `api_key` в конфиге не задан.

### Свои правила ревью (rule.json)

Правило — это текст, который подставляется в промпт для конкретного файла. Четыре слоя, первый сматчившийся паттерн побеждает, слои по приоритету:

1. **custom** — файл из `--rule path.json`
2. **project** — `<репо>/.opencodereview/rule.json`
3. **global** — `~/.opencodereview/rule.json`
4. **system** — встроенные правила (per-language: java, kotlin, python, rust, c/cpp, ts/js, и для конфигов: yaml, json, package.json, pom.xml, github workflows, …)

Формат:

```jsonc
{
  "rules": [
    {
      "path": "**/*.{ts,tsx}",                  // глоб: **, *, {a,b}; регистронезависимо
      "rule": "Проверяй отсутствие any и ...",  // текст ПРАВИЛА или путь к .md/.txt файлу
      "merge_system_rule": true                 // true = добавить к системному правилу,
    },                                          // false/нет = заменить его
    { "path": "**/api/**", "rule": "docs/api-review-rules.md" }
  ],
  "include": ["src/**"],       // если задан — ревьюим ТОЛЬКО совпавшее
  "exclude": ["**/legacy/**"]  // всегда исключить (плюс --exclude из CLI)
}
```

Ссылки на файлы правил: только `.md/.txt/.markdown`, до 512 КБ, пути не могут выходить за пределы репозитория. Проверка результата: `ocr rules check <файл>`.

### MCP-серверы

К встроенным инструментам LLM можно добавить свои через [Model Context Protocol](https://modelcontextprotocol.io) (stdio-транспорт):

```bash
ocr config set mcp_servers.codegraph.command npx
ocr config set mcp_servers.codegraph.args '["-y","@acme/codegraph-mcp"]'
ocr config set mcp_servers.codegraph.env '["TOKEN=xxx"]'
ocr config set mcp_servers.codegraph.tools '["find_references"]'   # allow-list (пусто = все)
ocr config set mcp_servers.codegraph.setup 'npm ci'                # shell-команда перед стартом
```

При `ocr review` серверы запускаются (init-таймаут 30 с), их инструменты добавляются к встроенным и становятся доступны LLM наравне с ними. Конфликты имён со встроенными пропускаются с предупреждением; падение сервера не прерывает ревью — оно продолжается без него.

---

## Инструменты, доступные LLM

Во время ревью модель самостоятельно вызывает:

| Инструмент | Что делает |
|---|---|
| `file_read` | Читает файл (окно до 500 строк, с нумерацией). В commit/range-режиме читает состояние файла **на ревьюируемом ref** через `git show`, не рабочую копию |
| `code_search` | Поиск текста/regex по репозиторию через `git grep` (до 100 совпадений; в scan-режиме работает и вне git) |
| `file_find` | Поиск файлов по имени через `git ls-files`/`ls-tree` |
| `file_read_diff` | Диффы **других** изменённых файлов — для проверки кросс-файловых гипотез |
| `code_comment` | Оставить находку: content + existing_code + suggestion_code + category + severity. Путь файла принудительно подставляется системой (защита от галлюцинаций), номера строк резолвятся текстовым матчингом с LLM-fallback |
| `task_done` | Завершить ревью файла |

Все вызовы видны в терминале (`▶ file_read "src/x.ts"` … `✔ file_read (12ms)`) и подсчитываются в `tool_calls` JSON-вывода.

---

## Какие файлы попадают в ревью

Порядок фильтров (причину для конкретного файла покажет `--preview`):

1. **Бинарные** — по эвристике git (NUL-байт) — исключаются.
2. **`exclude` пользователя** (rule.json + `--exclude`) — исключаются.
3. **`include` пользователя** — если задан, совпавшие файлы проходят дальше без проверки расширений.
4. **Allowlist расширений** — ~70 поддерживаемых (`.ts .js .py .go .java .rs .c .cpp .cs .swift .sql .yaml .json .tf` и т.д.); прочие исключаются как `unsupported_ext`. Заметно: `.md` в списке нет — документация не ревьюится.
5. **Стандартные исключения** — тестовые файлы (`**/*_test.go`, `**/*.spec.ts`, `**/__tests__/**`, `**/*Test.java`, …) как `default_path`.
6. **Служебные каталоги** — `.git`, `node_modules`, `vendor`, `target`, `.idea` и т.п. плюс `.gitignore`.
7. **Размер** — дифф/файл больше 80% токен-бюджета (и файл >2 МиБ в scan) — исключаются с предупреждением.
8. Удалённые файлы показываются в превью, но не ревьюятся.

---

## Сессии и resume

Каждый запуск пишет JSONL-журнал: параметры запуска, каждый LLM-запрос/ответ (с точным расходом токенов), вызовы инструментов и **чекпоинты по файлам** — отпечаток диффа (SHA-256) + собранные комментарии, с немедленным сбросом на диск.

Это даёт:

- **`ocr session list/show`** — полная история и разбор любого прошлого запуска;
- **`--resume <id>`** — если ревью упало (квота провайдера, сеть, таймаут), повторный запуск с тем же диапазоном переиспользует готовые файлы и переревьюит только упавшие:

```
[ocr] Resume f850c21f: reusing 6 file(s), reviewing 5 file(s)
```

Resume доступен для commit/range-режимов (workspace изменчив — отпечатки не совпадут) и валидируется: режим и диапазон должны совпадать с исходной сессией. Даже полностью упавший запуск финализируется и остаётся резюмируемым.

Формат сессий — собственный формат этой версии; чтение журналов, записанных оригинальным Go-бинарником, не поддерживается.

---

## Использование в CI

### GitLab — встроенная публикация (`--gitlab`)

В GitLab CI достаточно одного флага: адрес API, проект и IID MR подхватываются из
стандартных переменных пайплайна (`CI_API_V4_URL`, `CI_PROJECT_ID`,
`CI_MERGE_REQUEST_IID`), токен — из `GITLAB_TOKEN` (или `OCR_GITLAB_TOKEN`).

```yaml
ocr-review:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    OCR_LLM_URL: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
    OCR_LLM_MODEL: gemini-2.5-flash
    OCR_USE_ANTHROPIC: "false"
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - git clone <url-репозитория-ocr> /tmp/ocr && (cd /tmp/ocr && npm ci && npm run build && npm link)
    - export OCR_LLM_TOKEN="$GEMINI_KEY"          # секреты проекта (masked)
    - export GITLAB_TOKEN="$OCR_BOT_TOKEN"        # PAT/Project token со scope api
    - >
      ocr review
      --from "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
      --to "$CI_COMMIT_SHA"
      --audience agent --gitlab
```

Как публикуется: каждый комментарий сначала пробуем поставить **инлайн** в дифф MR
(с нативным suggestion-блоком — кнопка «Apply suggestion»); если GitLab отверг
позицию (строка не входит в дифф MR) или у комментария нет номера строки —
комментарий публикуется **общей заметкой** с пометкой
`📍 path:line — не удалось привязать комментарий к строке N в диффе MR, публикую как общий`.
Неполные настройки (`--gitlab` без токена/MR) отсекаются **до** запуска ревью, чтобы
не жечь LLM-токены впустую. Локально можно указать цель явно:
`--gitlab-url … --gitlab-project … --gitlab-mr …`.

### Другие платформы (JSON-паттерн)

```bash
export OCR_LLM_URL=...   OCR_LLM_TOKEN=$SECRET   OCR_LLM_MODEL=...
export OCR_USE_ANTHROPIC=false        # если эндпоинт OpenAI-совместимый

ocr review --from origin/main --to $CI_COMMIT_SHA \
  --format json --audience agent > result.json

# дальше — распарсить result.json и создать инлайн-комментарии
# через API вашей платформы (path + start_line/end_line + content)
```

`status` в JSON различает `success` / `completed_with_warnings` / `completed_with_errors` / `skipped` — удобно для политики фейла пайплайна. `session_id` можно логировать для последующего разбора через `ocr session show`.

---

## Отличия от Go-версии

Портировано 1-в-1 по поведению: все команды и флаги, промпты и встроенные правила (байт-в-байт), приоритеты резолвера конфигурации, схема JSON-вывода, формат `config.json` и `rule.json`, защита от ref-инъекций и path-traversal.

Сознательно **не** портировано:

| Что | Почему / замена |
|---|---|
| `ocr viewer` (web-UI истории сессий) | Вырезано; данные доступны через `ocr session list/show --json` |
| OpenTelemetry-телеметрия | Вырезано; ключи `telemetry.*` принимаются, но игнорируются. Консольные принтеры прогресса сохранены |
| Bubbletea-TUI настройки | Заменён на промпты `@clack/prompts` с тем же функционалом |
| npm-дистрибуция Go-бинарника | Не нужна — сам проект и есть npm-пакет |
| Чтение сессий Go-бинарника | Формат сессий канонизирован за этой версией |

---

## Разработка

```bash
npm run typecheck     # строгий tsc
npm run build         # tsup → dist/cli.js
npm run dev -- <cmd>  # запуск из исходников без сборки (tsx)
```

Карта проекта:

```
assets/          промпты, tools.json, встроенные правила — копия Go-ассетов, не редактировать
src/cli/         команды, флаги, вывод (порт cmd/opencodereview)
src/llm/         резолвер эндпоинтов, клиенты anthropic/openai, токенизация, пресеты
src/agent/       оркестратор diff-ревью (plan → tool-loop → review-filter)
src/scan/        полнофайловый скан (перечисление, батчи, оценка, dedup, summary)
src/loop/        общий tool-loop + трёхзонная компрессия контекста + worker-pool
src/tools/       6 встроенных инструментов LLM + реестр + коллектор комментариев
src/diff/        git-диффы: 3 режима, парсер ханков, резолвер номеров строк
src/session/     JSONL-журналы, история, resume
src/config/      rule-резолвер, шаблоны задач, allowlist, config.json
src/mcp/         подключение MCP-серверов (stdio)
```

`PROGRESS.md` — журнал миграции и решения; `docs/PLAN.md` — полный план порта с картой соответствия исходникам Go-версии.
