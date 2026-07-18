# PROGRESS — состояние миграции Go → TS

> Этот файл — единственный источник истины по прогрессу. Обновляется после каждого рабочего блока.
> Архитектура и детали каждого пункта — в `docs/PLAN.md`. Правила работы — в `CLAUDE.md`.

## Текущее состояние

**Веха:** M1 завершена (2026-07-18). Скелет собран, `ocr version` / `ocr llm providers` работают, ассеты скопированы и проверены пофайловым `cmp` на байтовую идентичность.
**Следующий шаг:** M2.1 — `src/config/appConfig.ts` (чтение `~/.opencodereview/config.json`), затем M2.2 построчный порт `internal/llm/resolver.go`.
**Важно:** Go-тулчейн на машине НЕ установлен — сверка с Go-версией делается по исходникам эталона (и по уже установленному поведению), а не запуском Go-бинарника.

---

## M1 — Скелет + `ocr llm providers` (~0.5 дня) — ✅ ЗАВЕРШЕНА

- [x] M1.1 Скаффолдинг: `package.json` (name `open-code-review-ts`, bin `ocr` → `dist/cli.js`), tsconfig strict ESM, tsup. (eslint отложен — см. журнал решений.)
- [x] M1.2 Копирование ассетов из эталона (байт-в-байт) в `assets/`:
  - `internal/config/template/prompts/*.md` → `assets/prompts/`
  - `internal/config/template/task_template.json`, `scan_template.json`
  - `internal/config/toolsconfig/tools.json`
  - `internal/config/rules/system_rules.json` + `rule_docs/` → `assets/rule_docs/`
  - `internal/config/allowlist/supported_file_types.json`, `default_exclude_patterns.json`
  - `internal/config/testconnection/task.json` → `assets/testconnection.json`
- [x] M1.3 `src/model/index.ts` — доменные типы + zod (эталон: `internal/model/*.go`; точные JSON-имена: `start_line`, `suggestion_code`, enum category/severity, `Preview.files`).
- [x] M1.4 `src/llm/providers.ts` — 15 пресетов 1-в-1 (эталон: `internal/llm/providers.go`; в PLAN.md ошибочно указано 16 — в registry их 15).
- [x] M1.5 CLI-каркас: ручной диспетчер как в `main.go` (НЕ commander — см. журнал), заглушки `review|r`, `scan|s`, `rules`, `config`, `session|sessions`; usage-тексты скопированы из `main.go`/`llm_cmd.go` (без строки viewer).
- [x] M1.6 Рабочие `ocr version`, `ocr llm providers`, `ocr llm` (usage), обработка unknown command (stderr `Error: …`, exit 1). Таблица провайдеров — свой мини-tabwriter (`src/cli/table.ts`).
- **Сверка:** вывод `llm providers` сверен со строками-источниками `llm_cmd.go` + `providers.go` (Go-бинарник собрать нельзя — нет тулчейна); 15 провайдеров, сортировка по имени, формат колонок совпадает.

## M2 — `ocr llm test` (~1 день)

- [ ] M2.1 `src/config/appConfig.ts` — чтение `~/.opencodereview/config.json`, `OCR_CONFIG_PATH` (только чтение). Эталон: `cmd/opencodereview/config_cmd.go` (типы Config/ProviderEntry/LlmConfig).
- [ ] M2.2 `src/llm/resolver.ts` — **построчный порт** `internal/llm/resolver.go`: приоритет config → `OCR_LLM_*` → `ANTHROPIC_*` → shell rc (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`); оверрайды `OCR_LLM_TIMEOUT`, `OCR_LLM_EXTRA_HEADERS`; `OCR_USE_ANTHROPIC` default true; срез суффикса `[Nm]`; нормализация URL (`/v1/messages` vs `/chat/completions`); запрет резервных заголовков.
- [ ] M2.3 `src/llm/tokens.ts` — js-tiktoken (`cl100k_base`; `o200k_base` для o1/o3/o4), кэш энкодеров, fallback `bytes/4`.
- [ ] M2.4 `src/llm/anthropic.ts` — MaxTokens default 8192, auth `authorization`|`x-api-key`, cache_control ephemeral на последний system-блок и последний тул, thinking → reasoning_content, кэш-токены суммируются в prompt_tokens. Эталон: `internal/llm/client.go`.
- [ ] M2.5 `src/llm/openai.ts` — `max_completion_tokens`, extra_body в теле, `reasoning_content` из extra-полей, maxRetries 5, User-Agent `open-code-review/<version>`.
- [ ] M2.6 `src/llm/usage.ts` — dot-пути извлечения usage + правило кэш-токенов Anthropic vs OpenAI. Эталон: `internal/llm/usage_resolver.go`.
- [ ] M2.7 Команды `ocr llm test` (таймаут 30с, max_tokens 2048) и вывод source/URL/model/response.
- **Сверка:** `ocr llm test` на реальном провайдере даёт тот же source/URL/model, что Go-версия, при одинаковых env/config.

## M3 — `ocr review --preview` + `ocr rules check` (~1.5 дня)

- [ ] M3.1 `src/util/path.ts` (`canonicalPath`, `withinBase`) и `src/util/logger.ts` (принтеры `▶/✔/✘`, `[ocr] Summary:`, quiet-режим). Эталоны: `internal/pathutil`, `internal/telemetry/events.go` (только принтеры), `internal/stdout`.
- [ ] M3.2 `src/git/runner.ts` — execa + p-limit(16), методы run/output/split. Эталон: `internal/gitcmd/runner.go`.
- [ ] M3.3 `src/diff/git.ts` — 3 режима (workspace: `git diff HEAD` + untracked как синтетические ханки; commit: `git show`; range: merge-base), флаги `--no-ext-diff --no-textconv --find-renames -U3 --end-of-options`, упрощённый `.gitignore`-матчинг, `ExcludedDirs`. Эталон: `internal/diff/git.go`.
- [ ] M3.4 `src/diff/parser.ts` + `src/diff/hunk.ts` — свой парсер unified diff (НЕ parse-diff), `finalizeDiff` (NewFileContent через `git show ref:path` / диск). Эталоны: `internal/diff/parser.go`, `hunk.go`.
- [ ] M3.5 `src/diff/workspaceFile.ts` — защищённое чтение (traversal/symlink-guard). Эталон: `internal/diff/workspace_file.go`.
- [ ] M3.6 `src/config/allowlist.ts` — picomatch, nocase; расширения + default-exclude. Эталон: `internal/config/allowlist`.
- [ ] M3.7 `src/config/rules.ts` — слоёный резолвер custom → project (`<repo>/.opencodereview/rule.json`) → global (`~/.opencodereview/rule.json`) → system; first-match-wins с сохранением порядка ключей; `merge_system_rule`; guard'ы файла-правила (расширения .md/.txt/.markdown, 512 КБ, traversal). Эталон: `internal/config/rules/system_rules.go`.
- [ ] M3.8 `src/agent/preview.ts` + рендер превью (`statusBadge` A/M/D/R/B/S) + валидация refs (запрет `-…`, `git rev-parse --verify --end-of-options`).
- [ ] M3.9 Команды: `ocr review --preview` (все режимы), `ocr rules check <file>`.
- **Сверка:** `--preview` и `rules check` на эталонном репо дают идентичный Go-версии результат.

## M4 — Полный `ocr review` (~3–4 дня, ядро)

- [ ] M4.1 `src/config/template.ts` — загрузка `task_template.json` + промптов, `ApplyLanguage`, `Validate`. Эталон: `internal/config/template/template.go`.
- [ ] M4.2 `src/config/toolsconfig.ts` — `tools.json`, фильтр по фазам plan/main.
- [ ] M4.3 `src/tools/` — registry (freeze, reserved), `fileRead` (500 строк, `N|line`, IS_TRUNCATED), `codeSearch` (git grep `--untracked`/`-P`/`-F`, лимит 100, retry `--no-index`, запрет `..`), `fileFind` (ls-files/ls-tree + walk-fallback), `fileReadDiff` (DiffMap), `codeComment`, `collector.ts` (Add/Snapshot/Since/ReplaceSince/RemoveByPathAndIndices). Эталон: `internal/tool/*`.
- [ ] M4.4 `src/diff/resolver.ts` — **построчный порт** `internal/diff/resolver.go` (скользящее окно: new-side → old-side → полный файл; нормализация строк).
- [ ] M4.5 `src/diff/relocation.ts` — LLM-fallback RE_LOCATION_TASK. Эталон: `internal/diff/relocation.go`.
- [ ] M4.6 `src/loop/runner.ts` — tool-цикл: бюджет MAX_TOOL_REQUEST_TIMES (30), корректирующее сообщение при пустом ответе, 3 пустых раунда, счётчики токенов, спец-ветка code_comment (инъекция пути, резолв строк, relocation), запись в сессию. Эталон: `internal/llmloop/loop.go`.
- [ ] M4.7 `src/loop/compression.ts` — **построчный порт** `internal/llmloop/compression.go` (зоны frozen/compress/active, пороги 0.60/0.80, `<previous_review_summary>`, фоновое сжатие со snapshotLen).
- [ ] M4.8 `src/loop/pool.ts` — worker-pool p-limit(8) + Await.
- [ ] M4.9 `src/session/` — jsonl-writer (uuid/parentUuid, flush на чекпоинтах), history, типы записей `session_start`/`llm_request`/`llm_response`/`llm_error`/`tool_call`/`review_item_*`/`session_end`; путь `~/.opencodereview/sessions/<encoded-repo>/<uuid>.jsonl` (0700/0600). Эталоны: `internal/session/history.go`, `persist.go`.
- [ ] M4.10 `src/agent/agent.ts` — конвейер Run: DiffMap-инъекция, фильтры + guard 80% MaxTokens, fan-out p-limit(concurrency=8) с таймаутом и изоляцией ошибок, plan-фаза (порог 50 строк), main-фаза, review-filter (id `c-0…`, парсинг индексов, удаление), fingerprint SHA-256 `mode\0oldPath\0newPath\0diff`. Эталон: `internal/agent/agent.go`.
- [ ] M4.11 `src/cli/output.ts` — text (бейджи `[category · severity]`, word-wrap, ANSI-дифф через пакет `diff`, санитизация) + **JSON-схема-контракт** (status, trace_id, message, summary{files_reviewed, comments, total/input/output/cache tokens, elapsed}, tool_calls, comments, warnings, project_summary, resume, session_id). Эталон: `cmd/opencodereview/output.go`.
- [ ] M4.12 `src/cli/backgroundFile.ts` — лимиты 1МБ/2000/8000, санитизация Unicode, `<ocr_user_background>`; автоподстановка background из commit message при `--commit`.
- [ ] M4.13 Полная команда `review` со всеми флагами и валидациями (взаимоисключение режимов, `--from/--to` парой, `--max-tools` ≥ 10, `--preview`+`--resume` конфликт, audience human|agent).
- **Сверка:** `ocr review --commit <sha>` на эталонном Go-репо — сопоставимые находки с Go-версией; `--format json` валиден по схеме.

## M5 — `ocr scan` (~1.5 дня)

- [ ] M5.1 `src/scan/provider.ts` — enumerate (`git ls-files -z` tracked+untracked / walk + .gitignore), NUL-сниффинг бинарников (8000 байт), лимит 2 МиБ. Эталон: `internal/scan/provider.go`.
- [ ] M5.2 `src/scan/batch.ts` (none/by-language/by-directory) + `estimate.ts` (константы 2000/7/700, humanTokens).
- [ ] M5.3 `src/scan/agent.ts` — фильтры → отсев 80% токенов → оценка → батчи (последовательно, файлы параллельно) → PLAN/MAIN → DEDUP на батч → PROJECT_SUMMARY; `--max-tokens-budget`. Эталон: `internal/scan/agent.go`; шаблон `scan_template.json`.
- [ ] M5.4 Команда `scan` со всеми флагами (`--path`, `--batch`, `--no-plan/--no-dedup/--no-summary`, `--max-tokens-budget`, `--preview`).
- **Сверка:** `ocr scan --preview` идентичен Go; живой скан 2–3 файлов даёт вменяемые находки.

## M6 — Конфиг, сессии, MCP (~1.5–2 дня)

- [ ] M6.1 `ocr config set/unset` — полное пространство ключей (provider, model, providers.*, custom_providers.*, mcp_servers.*, llm.*, language; БЕЗ telemetry.*), запись 0600. Эталон: `cmd/opencodereview/config_cmd.go`.
- [ ] M6.2 `ocr config provider` / `config model` — интерактив на @clack/prompts (пресет/кастом/manual → ключ (маска) → модель → сохранение → автотест соединения). Заменяет provider_tui.go.
- [ ] M6.3 `ocr session list/show` (`--repo`, `--json`, `--limit`) — таблица/JSON. Эталон: `internal/session/list.go`, `cmd/opencodereview/session_cmd.go`.
- [ ] M6.4 `--resume` — LoadResumeState (replay JSONL), ValidateOptions (только range/commit, совпадение диапазона), reuse по fingerprint. Эталон: `internal/session/resume.go`.
- [ ] M6.5 `src/mcp/` — @modelcontextprotocol/sdk StdioClientTransport, setup-скрипты (`sh -c`/`cmd /c`), таймаут init 30с, allow-list `tools`, коллизии имён, некритичность падений. Эталоны: `internal/mcp/*`, `cmd/opencodereview/review_cmd.go` (initMCPClients).
- [ ] M6.6 `--audience agent` / quiet-режим для `--format json`.

## M7 — Упаковка (~0.5 дня)

- [ ] M7.1 npm-пакет: bin `ocr`, README (установка, отличия от Go-версии: нет viewer/TUI/telemetry).
- [ ] M7.2 Финальный чек-лист контрактов из `docs/PLAN.md` Часть 4 (пройтись по всем 9 пунктам).
- [ ] M7.3 Полный E2E: review (3 режима + resume) и scan на реальном репо.

---

## Журнал решений

| Дата | Решение |
|---|---|
| 2026-07-18 | Проект — отдельная папка `open-code-review-ts` рядом с Go-репо; Go-репо — только эталон для сверки. |
| 2026-07-18 | Тесты не переносим и не пишем; паритет — ручной прогон против Go-бинарника. |
| 2026-07-18 | Не переносим: bubbletea TUI (→ @clack/prompts), web-viewer, OpenTelemetry (консольные принтеры прогресса сохраняем), npm-дистрибуцию бинарника, VSCode/plugins/pages. |
| 2026-07-18 | Стек: commander, официальные SDK Anthropic/OpenAI, js-tiktoken, picomatch, @modelcontextprotocol/sdk, p-limit, execa, zod, tsup. |
| 2026-07-18 | Три файла портируем построчно: diff/resolver, llmloop/compression, llm/resolver. Ассеты — байт-в-байт. |
| 2026-07-18 | CLI — ручной диспетчер + свой мини-парсер флагов (зеркалим `main.go`/`flags.go`), commander НЕ используем: точное воспроизведение usage-текстов, сообщений об ошибках и семантики коротких флагов важнее удобства фреймворка. |
| 2026-07-18 | eslint отложен: типобезопасность обеспечивает `tsc --noEmit` (strict + noUncheckedIndexedAccess); линтер добавим при необходимости в M7. |
| 2026-07-18 | Go-тулчейна на машине нет → сверка поведения по исходникам эталона, а не прогоном Go-бинарника. |
