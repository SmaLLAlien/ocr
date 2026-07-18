# План миграции OpenCodeReview: Go → TypeScript

Цель: переписать на TypeScript **только** функционал код-ревью — сканирование файлов, работу с LLM, ревью диффов, — сохранив CLI-интерфейс вызова и систему настройки. Всё остальное (web-viewer, TUI на bubbletea, телеметрия OpenTelemetry, npm-обёртки над бинарником, VSCode-расширение, сайт) — выпиливается.

Проект небольшой по объёму: ~18 800 строк Go, из которых **ядро ревью ~11 000 строк**, остальное — TUI (2 900), viewer (900), телеметрия (800) и прочая обвязка.

---

## Часть 1. Карта текущего проекта: что делает каждая папка/файл

### 1.1 `cmd/opencodereview/` — CLI-слой (~5 500 строк)

Ручной роутинг команд (без cobra), бинарник `ocr`.

| Файл | Строк | Что делает | Вердикт |
|---|---|---|---|
| `main.go` | 107 | Точка входа, диспетчер команд (`review`/`r`, `scan`/`s`, `rules`, `config`, `llm`, `session`, `viewer`, `version`) | ✅ Переносим (кроме viewer) |
| `review_cmd.go` | 321 | Оркестрация `ocr review`: валидация refs (защита от инъекции через `--from/--to`), автоподстановка background из commit message, resume, сборка tool registry и MCP-клиентов, запуск агента | ✅ Переносим |
| `scan_cmd.go` | 303 | `ocr scan` — полнофайловое ревью без диффа; git не обязателен | ✅ Переносим |
| `flags.go` | 343 | Парсинг флагов + кастомные короткие флаги (`-c` → `--commit`), валидация комбинаций режимов | ✅ Переносим (заменяется commander) |
| `config_cmd.go` | 598 | `ocr config set/unset` — вся модель конфига (`~/.opencodereview/config.json`, права 0600), пространство ключей `provider`, `providers.<name>.*`, `custom_providers.*`, `mcp_servers.*`, `llm.*`, `language`, `telemetry.*` | ✅ Переносим (без telemetry-ключей) |
| `provider_cmd.go` | 398 | Обвязка интерактивных мастеров `config provider` / `config model` + сохранение и тест соединения | ⚠️ Переносим упрощённо |
| `provider_tui.go` | **2 931** | Bubbletea/lipgloss TUI: три вкладки (Official/Custom/Manual), формы, маскировка ключей | ❌ **Не переносим.** Заменяем на простые интерактивные промпты (@clack/prompts, ~200–300 строк) |
| `output.go` | 398 | Рендер результатов: ANSI-текст с бейджами severity, inline-диффы предложений, JSON-схема вывода (`status`, `summary`, `comments`, `session_id`…) | ✅ Переносим (JSON-схема — контракт!) |
| `shared.go` | 321 | Общий bootstrap review/scan: загрузка шаблонов, правил, фильтров, git-runner, LLM runtime; `emitRunResult` | ✅ Переносим |
| `session_cmd.go` | 300 | `ocr session list/show` — таблица/JSON по сохранённым сессиям | ✅ Переносим (нужно для resume) |
| `llm_cmd.go` | 129 | `ocr llm test` (проверка соединения) и `ocr llm providers` (список пресетов) | ✅ Переносим |
| `background_file.go` | 136 | `--background-file`: чтение MD (лимит 1 МБ / 8 000 симв.), санитизация Unicode, обёртка в `<ocr_user_background>` | ✅ Переносим |
| `rules_cmd.go` | 105 | `ocr rules check <file>` — какое правило применится к файлу | ✅ Переносим |
| `viewer_cmd.go` | 56 | Запуск web-viewer | ❌ Не переносим |
| `git.go`, `version.go`, `procattr_*.go`, `shell_*.go` | ~100 | Мелкие git-хелперы, версия, платформенные обёртки для spawn MCP-процессов | ✅ Переносим (упрощённо) |

### 1.2 `internal/agent/` — оркестратор diff-ревью (~1 230 строк) — ✅ ЯДРО

- `agent.go` (993): конвейер `Run`: парсинг диффов → инъекция DiffMap (чтобы LLM мог смотреть диффы других файлов) → фильтрация (бинарные, расширения, глобы, диффы > 80% от MaxTokens) → параллельный запуск по файлу (семафор, по умолчанию 8, изоляция паник, таймауты). Для каждого файла: **Plan-фаза** (если изменение > 50 строк — один LLM-вызов за планом), **Main-фаза** (tool-loop), **Review-filter** (LLM отсеивает заведомо неверные комментарии). Resume по SHA-256-отпечатку диффа. Подстановка плейсхолдеров `{{diff}}`, `{{system_rule}}`, `{{change_files}}` и др.
- `preview.go` (123): dry-run `--preview` — какие файлы попадут в ревью и почему исключены остальные.
- `util.go` (112): регэксп-хелперы, XML-сериализация сообщений, подсчёт токенов.

### 1.3 `internal/llmloop/` — переиспользуемый tool-loop (~900 строк) — ✅ ЯДРО

- `loop.go` (476): цикл «LLM → tool_calls → результаты → LLM» до `task_done` / лимита раундов (30) / 3 пустых раундов. Спец-обработка `code_comment`: принудительная подстановка текущего пути (защита от галлюцинаций), резолв номеров строк по диффу с LLM-fallback (`ReLocationTask`).
- `compression.go` (333): трёхзонное сжатие контекста — frozen (system + первый user) / compress / active; мягкий порог 60% MaxTokens (фоновое сжатие), жёсткий 80% (синхронное). Сжатая история подставляется как `<previous_review_summary>`.
- `pool.go` (93): worker-pool (8) для асинхронного пост-процессинга комментариев.

### 1.4 `internal/tool/` — инструменты LLM (~1 100 строк) — ✅ ЯДРО

Реестр инструментов (Freeze после инициализации) + 6 встроенных: `task_done`, `code_comment` (находки: content, existing_code, suggestion_code, category, severity), `file_read` (до 500 строк, с нумерацией), `code_search` (git grep, лимит 100 совпадений, fallback `--no-index`), `file_read_diff` (диффы других изменённых файлов), `file_find` (поиск по имени через git ls-files). JSON-схемы — в `toolsconfig/tools.json`. Плюс `FileReader` (workspace = диск, range/commit = `git show ref:path`, защита от symlink/traversal) и потокобезопасный `CommentCollector`.

### 1.5 `internal/mcp/` — интеграция MCP (~220 строк) — ✅ ЯДРО

Go SDK MCP, только stdio-транспорт: spawn процесса сервера, ListTools, регистрация в общий реестр (с allow-list и защитой от коллизий имён), конвертация схем в ToolDef.

### 1.6 `internal/llm/` — LLM-слой (~1 950 строк) — ✅ ЯДРО

- `client.go` (771): интерфейс `LLMClient` (один метод, **без стриминга**), два клиента — Anthropic Messages (нормализация URL до `/v1/messages`, auth `authorization`|`x-api-key`, MaxTokens default 8192, **prompt caching**: `cache_control: ephemeral` на последнем system-блоке и последнем туле) и OpenAI Chat Completions (URL до `/chat/completions`, `max_completion_tokens`, extra_body через JSON-патч). Retry — 5 на уровне SDK. Подсчёт токенов tiktoken (`cl100k_base`/`o200k_base`, fallback `len/4`).
- `resolver.go` (647): резолв эндпоинта — **приоритет: config-файл → env `OCR_LLM_*` → env Claude Code (`ANTHROPIC_*`) → парсинг `~/.zshrc`/`~/.bashrc`**. Глобальные оверрайды `OCR_LLM_TIMEOUT`, `OCR_LLM_EXTRA_HEADERS`, срез суффикса модели `[1m]`, `OCR_USE_ANTHROPIC` (default true).
- `providers.go` (288): 16 пресетов провайдеров (anthropic, openai, edenai, dashscope, deepseek, kimi, z-ai, minimax, qianfan…) с base URL, протоколом, env-переменной ключа и списком моделей.
- `usage_resolver.go` (141): извлечение usage из произвольного JSON (десятки путей — прокси-совместимость), правила учёта кэш-токенов Anthropic vs OpenAI.
- `embedded_loader.go`: встроенные BPE-файлы tiktoken для оффлайн-работы.

### 1.7 `internal/model/` — доменные типы (~110 строк) — ✅ ЯДРО

`LlmComment` (path, content, suggestion_code, existing_code, start_line, end_line, category: bug/security/performance/…, severity: critical/high/medium/low), `Diff`, `ScanItem` (+ адаптер `AsDiff`), `Preview`/`PreviewEntry`/`ExcludeReason`. JSON-имена полей — сериализационный контракт.

### 1.8 `internal/scan/` — полнофайловый скан (~1 500 строк) — ✅ ЯДРО

- `provider.go` (313): перечисление файлов — `git ls-files` (tracked + untracked) или обход ФС с учётом `.gitignore`; сниффинг бинарников (NUL в первых 8 000 байт), лимит 2 МиБ на файл.
- `agent.go` (902): конвейер: enumerate → фильтры → отсев файлов > 80% MaxTokens по токенам → оценка стоимости → батчи (`none`/`by-language`/`by-directory`) последовательно, файлы внутри батча параллельно. На файл: PLAN → MAIN (общий llmloop) → на батч: DEDUP (LLM склеивает дубли) → на прогон: PROJECT_SUMMARY. Флаги `--no-plan/--no-dedup/--no-summary`, `--max-tokens-budget`.
- `estimate.go` (120), `batch.go` (116), `preview.go` (55).

### 1.9 `internal/diff/` — работа с git-диффами (~1 000 строк) — ✅ ЯДРО

- `git.go` (339): три режима — workspace (`git diff HEAD` + untracked как синтетические all-added ханки), commit (`git show`), range (`git diff merge-base(from,to)..to`). Флаги `--no-ext-diff --no-textconv --find-renames -U3 --end-of-options`.
- `parser.go` (127): парсинг unified diff в `[]Diff`; `hunk.go` (110): парсинг `@@`-блоков.
- `resolver.go` (237): маппинг `existing_code` комментария на номера строк — скользящее окно по ханкам (new-side, потом old-side), fallback по полному содержимому файла.
- `relocation.go` (104): LLM-fallback переуточнения сниппета, если текстовый матчинг не сработал.
- `workspace_file.go` (60): защищённое чтение файлов (canonical path, WithinBase, symlink-guard).

### 1.10 `internal/config/` — правила, шаблоны, фильтры (~990 строк + ассеты) — ✅ ЯДРО

- `rules/system_rules.go` (558): резолвер правил ревью по пути файла. Слои: `--rule` → `<repo>/.opencodereview/rule.json` → `~/.opencodereview/rule.json` → встроенные. **Порядок ключей JSON важен** (first match wins). ~20 встроенных MD-правил (java, python, ts_js, rust, yaml, github_workflows…). `merge_system_rule` — объединение вместо замены. Ограничения: whitelist расширений файла-правила, 512 КБ, traversal-guard.
- `template/template.go` (225): шаблоны задач — diff-пайплайн (`task_template.json` + 10 файлов промптов: MAIN, PLAN, MEMORY_COMPRESSION, RE_LOCATION, REVIEW_FILTER; MAX_TOKENS=58888, MAX_TOOL_REQUEST_TIMES=30, PLAN_MODE_LINE_THRESHOLD=50) и scan-пайплайн (`scan_template.json`, + DEDUP, PROJECT_SUMMARY, батчинг). `ApplyLanguage` дописывает «Always respond in X» в system-сообщения.
- `allowlist/` (97): ~70 разрешённых расширений + дефолтные exclude-глобы (тесты, `__tests__` и т.п.).
- `toolsconfig/` (54): `tools.json` — JSON-схемы 6 инструментов с флагами `plan_task`/`main_task`.
- `testconnection/` (54): промпт для `ocr llm test`.

### 1.11 `internal/session/` — персистенс сессий (~1 230 строк) — ✅ ЯДРО (нужно для `--resume`)

JSONL-стриминг в `~/.opencodereview/sessions/<encoded-repo>/<uuid>.jsonl` (0700/0600). Записи: `session_start`, `llm_request/response/error`, `tool_call`, `review_item_done/reused/failed` (чекпоинты resume с fingerprint и комментариями), `session_end`. Resume разрешён только для range/commit-режимов и требует совпадения диапазона.

### 1.12 Остальные internal-пакеты

| Пакет | Строк | Что делает | Вердикт |
|---|---|---|---|
| `gitcmd/` | 127 | Семафор на git-подпроцессы (max 16), 4 режима запуска | ✅ Переносим (~50 строк TS) |
| `pathutil/` | 26 | `CanonicalPath`, `WithinBase` — защита от traversal | ✅ Переносим |
| `stdout/` | 40 | Глушение stdout для `--audience agent` | ✅ Переносим (тривиально) |
| `suggestdiff/` | 75 | LCS-дифф для ANSI-рендера предложений в терминале | ✅ Заменяем npm-пакетом `diff` |
| `telemetry/` | ~830 | OpenTelemetry (трейсы + метрики, OTLP/console) + консольные принтеры прогресса (`▶ / ✔ / ✘`, `[ocr] Summary:`) | ❌ OTel выпиливаем. ⚠️ Консольные принтеры прогресса переносим как простой логгер (~100 строк) |
| `viewer/` | ~920 | Локальный web-UI просмотра сессий | ❌ Не переносим |
| `release/` | — | Только тесты консистентности имён релизных артефактов | ❌ Не переносим |

### 1.13 Вне `internal/`

| Папка | Что делает | Вердикт |
|---|---|---|
| `npm/`, `bin/ocr.js`, `scripts/install.js`, `update.js`, `platform.js` | Дистрибуция Go-бинарника через npm (платформенные пакеты, скачивание, checksum, автообновление) | ❌ **Не нужно** — TS-версия сама и есть npm-пакет |
| `pages/` | Сайт/блог | ❌ |
| `extensions/vscode/` | VSCode-расширение (вызывает `ocr` как CLI — продолжит работать и с TS-версией, если сохранить CLI-контракт) | ❌ (не трогаем) |
| `plugins/`, `skills/`, `.claude-plugin/` | Интеграции с Claude Code/Codex (тоже просто зовут `ocr review --audience agent`) | ❌ (не трогаем) |
| `action.yml`, `examples/`, `scripts/github-actions/` | GitHub Action / CI-примеры — зовут `ocr review --format json` | ❌ (совместимы при сохранении контракта) |
| `Makefile`, `install.sh`, `scripts/publish/` | Сборка/релиз Go | ❌ Заменяется на tsup + npm publish |

---

## Часть 2. Целевая архитектура TypeScript

### 2.1 Технологический стек

| Область | Go-решение | TS-решение | Комментарий |
|---|---|---|---|
| Runtime | Go 1.25 | **Node.js ≥ 20**, ESM, TypeScript strict | |
| CLI | ручной switch + flag | **commander** | Короткие флаги (`-c`, `-b`, `-f`, `-p`, `-B`) поддерживаются из коробки; валидации комбинаций — вручную |
| Anthropic | anthropic-sdk-go | **@anthropic-ai/sdk** | `maxRetries: 5`, `cache_control` поддерживается нативно |
| OpenAI | openai-go/v3 | **openai** (официальный) | `maxRetries: 5`, `max_completion_tokens`, extra_body — просто поля запроса |
| Токенизация | tiktoken-go + embedded BPE | **js-tiktoken** | Чистый JS, ранги в пакете, оффлайн из коробки; нужны `cl100k_base` и `o200k_base` |
| Глобы | doublestar + свой expandBraces | **picomatch** (или minimatch) | `**` и `{a,b}` из коробки — свой brace-expander не нужен; `nocase: true` |
| MCP | modelcontextprotocol/go-sdk | **@modelcontextprotocol/sdk** | Официальный TS SDK, `StdioClientTransport` — 1-в-1 замена |
| Параллелизм | goroutines + семафоры | **p-limit** | Всё I/O-bound → промисов достаточно; atomic-счётчики становятся обычными полями (один поток) |
| Git | os/exec | **execa** + свой лимитер (p-limit(16)) | |
| Дифф-рендер | свой LCS | **diff** (npm, `diffLines`) | Заменяет `internal/suggestdiff` целиком |
| Валидация конфигов/JSON | encoding/json руками | **zod** | Схемы config.json, rule.json, tools.json, шаблонов |
| Интерактивный setup | bubbletea (2 900 строк) | **@clack/prompts** | select провайдера → select модели → password-ввод ключа → тест соединения. ~10x меньше кода |
| ANSI-цвета | ручные ESC-коды | **picocolors** | |
| UUID | crypto/rand вручную | `crypto.randomUUID()` | встроено в Node |
| Сборка | make | **tsup** (или tsc) | bin: `dist/cli.js` c shebang |
| Дистрибуция | 6 платформ + checksums | обычный **npm-пакет** | Вся папка `npm/` и скрипты установки исчезают |

### 2.2 Структура нового пакета

```
open-code-review-ts/
├── package.json              # bin: { "ocr": "dist/cli.js" }
├── tsconfig.json
├── assets/                   # скопировать ИЗ Go-репо БЕЗ ИЗМЕНЕНИЙ:
│   ├── prompts/              #   internal/config/template/prompts/*.md
│   ├── task_template.json    #   манифест diff-пайплайна
│   ├── scan_template.json
│   ├── tools.json            #   JSON-схемы инструментов
│   ├── system_rules.json + rule_docs/*.md
│   ├── supported_file_types.json
│   ├── default_exclude_patterns.json
│   └── testconnection.json
├── src/
│   ├── cli/                  # ← cmd/opencodereview
│   │   ├── index.ts          #   commander-программа, диспетчер
│   │   ├── review.ts, scan.ts, config.ts, llm.ts, session.ts, rules.ts
│   │   ├── setup.ts          #   @clack/prompts вместо provider_tui.go
│   │   ├── output.ts         #   text/json рендер (контракт JSON-схемы!)
│   │   ├── shared.ts         #   commonContext / llmRuntime / emitRunResult
│   │   └── backgroundFile.ts
│   ├── model/                # ← internal/model (типы + zod-схемы)
│   ├── llm/                  # ← internal/llm
│   │   ├── client.ts         #   интерфейс LLMClient
│   │   ├── anthropic.ts, openai.ts
│   │   ├── resolver.ts       #   приоритет источников, все env-переменные
│   │   ├── providers.ts      #   16 пресетов
│   │   ├── usage.ts          #   usage_resolver
│   │   └── tokens.ts         #   js-tiktoken + кэш энкодеров + fallback len/4
│   ├── diff/                 # ← internal/diff (git.ts, parser.ts, hunk.ts, resolver.ts, relocation.ts)
│   ├── git/                  # ← internal/gitcmd (лимитированный runner)
│   ├── tools/                # ← internal/tool (registry, fileRead, codeSearch, fileFind, fileReadDiff, codeComment, collector)
│   ├── mcp/                  # ← internal/mcp
│   ├── loop/                 # ← internal/llmloop (runner.ts, compression.ts, pool.ts)
│   ├── agent/                # ← internal/agent (review-оркестратор, preview)
│   ├── scan/                 # ← internal/scan (provider, agent, batch, estimate)
│   ├── config/               # ← internal/config (rules.ts, template.ts, allowlist.ts, toolsconfig.ts, appConfig.ts)
│   ├── session/              # ← internal/session (history, jsonl-writer, list, resume)
│   └── util/                 #   pathutil, stdout-quiet, logger (принтеры ▶/✔/✘)
```

Файлы `*_test.go` из Go-репозитория не переносятся и в объёме миграции не учитываются.

---

## Часть 3. Пофазный план работ

Фазы упорядочены по зависимостям. Тесты (ни перенос Go-тестов, ни написание новых) в объём не входят; проверка — ручной прогон против Go-бинарника в финальной фазе. Оценки — «чистое» время разработки с ИИ-ассистентом.

### Фаза 0 — Скаффолдинг и ассеты (0.5 дня)
1. Инициализировать пакет: tsconfig strict, ESM, tsup, eslint.
2. **Скопировать все ассеты как есть**: промпты, `task_template.json`, `scan_template.json`, `tools.json`, `system_rules.json` + `rule_docs/`, allowlist-JSONы. Это — сердце качества ревью, менять нельзя.
3. Портировать `internal/model` → TS-интерфейсы + zod-схемы с **точными JSON-именами полей** (`start_line`, `suggestion_code`, enum category/severity…).

### Фаза 1 — Утилиты (0.5 дня)
1. `util/path.ts`: `canonicalPath` (realpath), `withinBase` — переиспользуется в 3 местах защиты от traversal.
2. `git/runner.ts`: execa + p-limit(16); методы run/output/split (Stream, скорее всего, не нужен — проверить по использованию).
3. `config/allowlist.ts`: picomatch-матчеры расширений и exclude-путей.
4. `llm/tokens.ts`: js-tiktoken, выбор энкодера по модели (o1/o3/o4 → o200k_base), кэш, fallback `bytes/4`.
5. `util/logger.ts`: принтеры прогресса `▶ / ✔ / ✘`, `[ocr] Summary: ...`, режим quiet для `--format json` / `--audience agent` (замена internal/stdout + telemetry/events.go).

### Фаза 2 — LLM-слой (1.5–2 дня) — критичный контракт
1. `llm/providers.ts`: перенести таблицу 16 пресетов 1-в-1 (имена, URL, env-переменные, списки моделей).
2. `llm/resolver.ts`: **точно воспроизвести приоритет**: config.json → `OCR_LLM_URL/TOKEN/MODEL/AUTH_HEADER` → `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` → парсинг `~/.zshrc`/`~/.bashrc`/`~/.bash_profile`/`~/.profile`. Оверрайды `OCR_LLM_TIMEOUT`, `OCR_LLM_EXTRA_HEADERS`, `OCR_USE_ANTHROPIC` (default **true**), срез суффикса `[Nm]`, нормализация URL (`/v1/messages` vs `/chat/completions`), валидация auth-header, запрет резервных заголовков в extra_headers.
3. `llm/anthropic.ts` + `llm/openai.ts`: единый интерфейс `LLMClient.completions(req)`. Anthropic: MaxTokens default 8192, cache_control на последний system-блок и последний тул, маппинг thinking → reasoning_content, суммирование кэш-токенов в prompt_tokens. OpenAI: `max_completion_tokens`, extra_body в теле запроса, извлечение `reasoning_content`.
4. `llm/usage.ts`: перенести список dot-путей и правило «кэш-токены прибавляются к total только для Anthropic-путей».
5. Проверка: `ocr llm test` и `ocr llm providers` против разных комбинаций env/config.

### Фаза 3 — Diff-слой (1.5 дня)
1. `diff/git.ts`: три режима провайдера (workspace / commit / range c merge-base), синтез ханков для untracked, фильтрация по exclude, упрощённый `.gitignore`-матчинг (для walk-режима).
2. `diff/parser.ts` + `hunk.ts`: **портировать свой парсер**, а не брать `parse-diff` — резолвер строк завязан на точную структуру ханков и на `finalizeDiff` (чтение `NewFileContent` через `git show ref:path`).
3. `diff/resolver.ts`: скользящее окно матчинга `existing_code` (new-side → old-side → полный файл), нормализация строк. Это самый чувствительный к поведению код — портировать близко к оригиналу.
4. `diff/relocation.ts`: LLM-fallback (RE_LOCATION_TASK).
5. `diff/workspaceFile.ts`: защищённое чтение с traversal/symlink-guard.

### Фаза 4 — Инструменты и MCP (1–1.5 дня)
1. `tools/registry.ts`: реестр с freeze-семантикой (в TS достаточно флага), reserved-имена.
2. Портировать 6 провайдеров: `fileRead` (окно 500 строк, формат вывода `N|line`, `IS_TRUNCATED`), `codeSearch` (git grep: `--untracked`/`-P`/`-F`, лимит 100, retry `--no-index`, запрет `..`), `fileFind` (git ls-files/ls-tree + walk-fallback, skip-эвристики), `fileReadDiff` (read-only DiffMap), `codeComment` (парсинг массива комментариев), `task_done`.
3. `tools/collector.ts`: CommentCollector (Add/Snapshot/Since/ReplaceSince/RemoveByPathAndIndices — нужны для dedup и review-filter).
4. `mcp/client.ts` + `mcp/registry.ts`: @modelcontextprotocol/sdk, StdioClientTransport, ListTools с таймаутом 30с, setup-скрипты через `sh -c`/`cmd /c`, allow-list, конвертация InputSchema → ToolDef, некритичность падений сервера.

### Фаза 5 — Tool-loop и сжатие контекста (1.5–2 дня) — сердце системы
1. `loop/runner.ts`: цикл RunPerFile — бюджет `MAX_TOOL_REQUEST_TIMES`, обработка tool_calls, корректирующее сообщение при пустом ответе, лимит 3 пустых раундов, запись в сессию, счётчики токенов/варнингов (обычные поля — однопоточность упрощает Go-код с atomic).
2. Спец-ветка `code_comment`: инъекция пути, резолв строк, LLM-relocation; синхронно или через `loop/pool.ts` (p-limit(8) + Promise.allSettled в Await).
3. `loop/compression.ts`: трёхзонная модель — пороги 0.60/0.80 от MaxTokens, frozen = messages[0:2], `computeActiveZoneSize`, XML-сериализация compress-зоны, `<previous_review_summary>`, фоновое сжатие как обычный Promise со snapshot-семантикой (`snapshotLen`).

### Фаза 6 — Review-агент и сессии (2 дня)
1. `session/`: JSONL-writer (uuid/parentUuid-цепочка, flush после каждого чекпоинта), `history.ts`, `list.ts`, `resume.ts` (replay, `ValidateOptions` — resume только range/commit + совпадение диапазона). Формат файлов и путь `~/.opencodereview/sessions/<encoded-repo>/` сохранить бинарно-совместимым.
2. `agent/agent.ts`: конвейер Run (см. 1.2) — фильтрация, DiffMap, fan-out через p-limit(concurrency) + AbortSignal-таймаут на файл, plan-фаза (порог 50 строк), main-фаза, review-filter (`c-0, c-1…` id-шники, парсинг индексов, удаление), resume по fingerprint (SHA-256 от `mode\0oldPath\0newPath\0diff`), guard 80% MaxTokens.
3. `agent/preview.ts`: `--preview` без LLM.

### Фаза 7 — Scan-агент (1.5 дня)
1. `scan/provider.ts`: enumerate через `git ls-files -z` + untracked, walk-fallback, бинарный сниффинг (NUL в 8 000 байт), лимит 2 МиБ.
2. `scan/agent.ts`: фильтры → отсев по токенам → оценка (`estimate.ts`: константы 2000/7/700) → батчи (`batch.ts`: none/by-language/by-directory) → PLAN/MAIN на файл → DEDUP на батч → PROJECT_SUMMARY. Бюджет `--max-tokens-budget`.
3. Переиспользование `loop/runner` — здесь окупается общий дизайн llmloop.

### Фаза 8 — CLI, конфиг, вывод (2 дня)
1. `cli/index.ts`: commander — команды `review|r`, `scan|s`, `rules check`, `config …`, `llm test|providers`, `session list|show`, `version`. Все флаги из Части 1.1 с теми же именами, короткими формами и дефолтами. Валидации: взаимоисключение режимов, парность `--from/--to`, запрет `--preview`+`--resume`, `--max-tools` ≥ 10, refs не начинаются с `-` + `git rev-parse --verify --end-of-options`.
2. `config/appConfig.ts`: чтение/запись `~/.opencodereview/config.json` (mode 0600), полное пространство ключей `config set/unset` (без `telemetry.*`), `OCR_CONFIG_PATH` только на чтение.
3. `cli/setup.ts`: интерактивный `config provider`/`config model` на @clack/prompts: вкладки → выбор пресета/кастом/manual → ввод ключа (маскируется) → выбор модели → сохранение → автотест соединения. Функциональный паритет с TUI при ~10% кода.
4. `cli/output.ts`: текстовый рендер (бейджи `[category · severity]`, word-wrap по рунам, ANSI-дифф предложений через пакет `diff`, санитизация терминальных управляющих символов) и **JSON-вывод с точной схемой** (`status`, `trace_id` → можно опустить/генерить uuid, `summary{files_reviewed, comments, total/input/output/cache_tokens, elapsed}`, `tool_calls`, `comments`, `warnings`, `project_summary`, `resume`, `session_id`).
5. `cli/backgroundFile.ts`: лимиты 1 МБ/2 000/8 000, санитизация Unicode Cf/управляющих, `<ocr_user_background>`.
6. `config/rules.ts`: слоёный резолвер (custom → project → global → system), **сохранение порядка ключей** (в JS `JSON.parse` сохраняет порядок вставки — проще, чем в Go), merge_system_rule, guard'ы файла-правила.
7. `config/template.ts`: загрузка манифеста + промптов, ApplyLanguage, Validate.

### Фаза 9 — Проверка паритета и упаковка (1 день)
1. **Ручная сверка с Go-бинарником** на одном и том же тестовом репозитории: (a) вывод `--preview`, (b) структура `--format json`, (c) резолв эндпоинтов при разных env (`ocr llm test`), (d) `rules check` для набора путей.
2. E2E-прогон с реальным LLM на маленьком диффе (`ocr review --commit`) и скан пары файлов (`ocr scan --path …`).
3. Упаковка: `npm publish` (bin `ocr`), README с миграционными примечаниями. GitHub Action и plugins продолжают работать без изменений, если CLI-контракт соблюдён.

**Итого: ~10–12 рабочих дней** на функциональный паритет ядра.

---

## Часть 4. Контракты, которые нельзя ломать

1. **CLI-поверхность**: имена команд/алиасов/флагов и их дефолты (Часть 1.1) — на них завязаны GitHub Action, GitLab/GitFlic-примеры, VSCode-расширение, Claude/Codex-плагины (`ocr review --audience agent --format json`).
2. **JSON-вывод** `--format json` — парсится CI-скриптами (`post-review-comments.js`, `post_review.py`).
3. **Env-переменные**: `OCR_LLM_URL/TOKEN/MODEL/AUTH_HEADER/EXTRA_HEADERS/TIMEOUT`, `OCR_USE_ANTHROPIC`, `OCR_CONFIG_PATH`, `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` + все `*_API_KEY` пресетов — и **порядок приоритетов** резолвера.
4. **`~/.opencodereview/config.json`** — формат и пространство ключей `config set`.
5. **`rule.json`** (project/global) — формат, порядок применения, merge_system_rule.
6. **Формат сессий JSONL** — если хочется читать старые сессии и резюмить их; минимум — сохранить схему записей `review_item_*` и fingerprint-алгоритм (SHA-256 от `mode\0oldPath\0newPath\0diff`).
7. **Промпты и tools.json** — переносить байт-в-байт; от них зависит качество ревью.
8. **Плейсхолдеры шаблонов** `{{diff}}`, `{{system_rule}}`, `{{plan_guidance}}` и др. — механизм подстановки простым string replace.
9. **Безопасность**: валидация refs (запрет `-...`), traversal/symlink-guard'ы при чтении файлов, санитизация background-файла и терминального вывода, запрет резервных заголовков, права 0600 на конфиг с ключами.

## Часть 5. Риски и упрощения

- **Параллелизм**: весь Go-параллелизм I/O-bound → p-limit покрывает всё; atomic-счётчики и мьютексы (CommentCollector, Runner, SessionHistory) в однопоточном Node становятся обычными объектами — код заметно упростится.
- **tiktoken**: js-tiktoken ранги ~2–4 МБ в пакете — приемлемо; грузить лениво.
- **Прерывание процессов** (MCP setup, таймауты на файл): в Node — AbortController + `subprocess.kill()`; Windows-нюансы (нет process groups) уже задокументированы в Go-версии как no-op.
- **Паники → исключения**: изоляция паник на файл превращается в try/catch вокруг задачи + Promise.allSettled.
- **Порядок ключей JSON в rule.json**: в JS сохраняется автоматически — риск снят.
- **Стриминга нет** в Go-версии — и не добавляем (упрощает клиентов); можно заложить в интерфейс на будущее.
- **Фоновая компрессия** (goroutine со snapshot): в TS — обычный неawaited Promise; аккуратно с гонкой «сообщения добавлены после снапшота» (логика `snapshotLen` переносится как есть).
- Самые «хрупкие» места, требующие построчного портирования, а не «переписывания по смыслу»: `diff/resolver.go` (матчинг строк), `llmloop/compression.go` (зоны), `llm/resolver.go` (приоритеты источников). Остальное можно переписывать идиоматично.
