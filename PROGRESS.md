# PROGRESS — состояние миграции Go → TS

> Этот файл — единственный источник истины по прогрессу. Обновляется после каждого рабочего блока.
> Архитектура и детали каждого пункта — в `docs/PLAN.md`. Правила работы — в `CLAUDE.md`.

## Текущее состояние

**Веха:** 🏁 МИГРАЦИЯ ЗАВЕРШЕНА — M1–M7 закрыты (2026-07-18). Все команды ядра работают и проверены живыми прогонами. `npm publish` НЕ выполнялся (нужны креды и решение об имени пакета — сейчас `open-code-review-ts`); локально ставится через `npm link`.
**Хвосты для будущих сессий (не блокируют):** живой TTY-прогон `config provider`/`config model`; MCP с реальным сервером; anthropic-протокол живьём; scan dedup-фаза.
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

## M2 — `ocr llm test` (~1 день) — ✅ ЗАВЕРШЕНА

- [x] M2.1 `src/config/appConfig.ts` — типы AppConfig/ProviderEntry/LlmConfig/MCPServerConfig, `defaultConfigPath`, `resolveConfigPath` (OCR_CONFIG_PATH только чтение), `loadAppConfig`/`loadOrCreateConfig`/`saveConfig` (0600).
- [x] M2.2 `src/llm/resolver.ts` — построчный порт `internal/llm/resolver.go`: 4 стратегии в порядке приоритета, все env-переменные, глобальные оверрайды `OCR_LLM_TIMEOUT`/`OCR_LLM_EXTRA_HEADERS`, срез `[Nm]`, `ensureMessagesSuffix`, `normalizeAuthHeader`, `parseExtraHeaders` (+ запрет резервных заголовков), Go-идентичные тексты ошибок.
- [x] M2.3 `src/llm/tokens.ts` — js-tiktoken/lite с lazy-require ранков (cl100k_base; o200k_base для o1/o3/o4), кэш, fallback `bytes/4`. API синхронный, как в Go.
- [x] M2.4 `src/llm/anthropic.ts` — @anthropic-ai/sdk: max_tokens default 8192, auth authorization/x-api-key/кастомный заголовок (с удалением конфликтующих), cache_control ephemeral на последний system-блок и последний тул, буферизация tool-результатов в user-сообщение, thinking → reasoning_content, кэш-токены суммируются в prompt_tokens.
- [x] M2.5 `src/llm/openai.ts` — SDK openai: нормализация URL до `/chat/completions`, `max_completion_tokens`, extraBody merge в params (SDK passthrough), `reasoning_content` из нестандартного поля, maxRetries 5, User-Agent.
- [x] M2.6 `src/llm/usage.ts` — порт usage_resolver.go: те же dot-пути, правило кэш-токенов Anthropic (индексы < 3) vs OpenAI.
- [x] M2.7 `ocr llm test` — резолв, applyLanguage, таймаут из task.json (120с) / 30с default, maxTokens 2048, вывод Source/URL/Model/контент/✓.
- **Сверка:** live-прогон против реального провайдера пользователя (OpenAI-протокол) успешен; негативные кейсы (отсутствие конфига, невалидный OCR_LLM_TIMEOUT) — Go-идентичные ошибки. Anthropic-путь проверен типами/по исходнику, live-прогона не было (нет anthropic-эндпоинта под рукой) — перепроверить при первом review-прогоне.

## M3 — `ocr review --preview` + `ocr rules check` (~1.5 дня) — ✅ ЗАВЕРШЕНА

- [x] M3.1 `src/util/path.ts` (canonicalPath, withinBase) + `src/util/semaphore.ts` (свой семафор вместо p-limit) + `src/util/glob.ts` (picomatch-обёртки: globMatch = doublestar, simpleMatch = filepath.Match, expandBraces). ⚠️ logger отложен в M4.
- [x] M3.2 `src/git/runner.ts` — GitRunner на child_process.spawn + Semaphore(16); run (combined, {out, ok}) / output (stdout, throws) / runSplit. `src/cli/git.ts` — синхронные хелперы (spawnSync) для валидаций.
- [x] M3.3 `src/diff/git.ts` — DiffProvider: 3 режима, те же git-флаги, `.gitignore`-матчинг (directory-only/basename/full-path, negation ignored), ExcludedDirs, фильтрация диффов, синтез all-added ханков для untracked.
- [x] M3.4 `src/diff/parser.ts` (парсер заголовков, rename from/to как авторитетный путь, счёт insertions/deletions, finalizeDiff через `git show ref:path` c 2-мин таймаутом) + `src/diff/hunk.ts` (парсер @@-блоков).
- [x] M3.5 `src/diff/workspaceFile.ts` — все guard'ы из оригинала (abs-запрет, withinBase ×3, symlink → target text).
- [x] M3.6 `src/config/allowlist.ts` — lazy-init, case-insensitive.
- [x] M3.7 `src/config/rules.ts` — слоёный резолвер; порядок ключей path_rule_map сохраняется нативно JSON.parse; merge_system_rule; file-ref правила (.md/.txt/.markdown, 512КБ, traversal-guard, warnings в stderr).
- [x] M3.8 `src/agent/preview.ts` (loadDiffs/whyExcluded/buildPreview/diffStatus/extFromPath) + `src/cli/output.ts` (outputPreviewText, statusBadge, sanitizeTerminal) + validateReviewRefs в `src/cli/review.ts`.
- [x] M3.9 `src/cli/flags.ts` — OcrFlagSet (порт Go flag: --name/-name, =value, короткие флаги, стоп на первом позиционном) + parseReviewFlags со всеми валидациями; команды review (preview-путь) и rules check подключены в диспетчер.
- **Сверка (на эталонном Go-репо):** workspace-превью (untracked → added +276, excluded unsupported_ext), commit-превью (binary excluded), range-превью 21 файл через merge-base, rules check (default для .go, `**/*.{ts,js,tsx,jsx}` для .tsx, `**/pom.xml`), ref-инъекция `--commit "--upload-pack=evil"` отвергнута с Go-идентичным сообщением.

## M4 — Полный `ocr review` (~3–4 дня, ядро) — ✅ ЗАВЕРШЕНА (MCP → M6)

- [x] M4.1 `src/config/template.ts` — манифест + промпты, ScanTemplate, applyLanguage, validate.
- [x] M4.2 `src/config/toolsconfig.ts` — definition в tools.json — плоский FunctionDef; buildToolDefs оборачивает в {type:'function', function} (как agent.BuildToolDefs).
- [x] M4.3 `src/tools/` — registry (freeze/reserved/dynamic), fileReader (workspace/git-show, scanLines с Go-семантикой trailing newline), fileRead, codeSearch (splitN-парсинг вывода, offset при ref), fileFind, fileReadDiff (DiffMap), codeComment (parseComments), collector.
- [x] M4.4 `src/diff/resolver.ts` — построчный порт (new-side → old-side → полный файл со skip пустых строк).
- [x] M4.5 `src/diff/relocation.ts` — RE_LOCATION_TASK с плейсхолдерами {diff}/{existing_code}/{suggestion_content}, extractCodeBlock.
- [x] M4.6 `src/loop/runner.ts` — LoopRunner: бюджет 30 раундов, корректирующее сообщение, 3 пустых раунда, code_comment-ветка (инъекция пути, резолв, relocation, async-путь через pool отвязан от сигнала), MCP-fallback для незарезервированных имён.
- [x] M4.7 `src/loop/compression.ts` — построчный порт зон (frozen=messages[0:2], groupIntoRounds, computeActiveZoneSize, rebuildWithSummary); фоновое сжатие как Promise со snapshotLen-семантикой в runner.
- [x] M4.8 `src/loop/pool.ts` — CommentWorkerPool на Semaphore(8) + await().
- [x] M4.9 `src/session/` — persist.ts (JsonlWriter, все типы записей, uuid/parentUuid, encodeRepoPath с Windows-диском), history.ts (SessionHistory/FileSession/TaskRecord, tiktoken-fallback usage), resume.ts (replay + validateOptions).
- [x] M4.10 `src/agent/agent.ts` — полный конвейер: DiffMap-инъекция до фильтрации, freeze, фильтры + 80%-guard, fan-out Semaphore(8) c AbortSignal-таймаутом и изоляцией ошибок, plan-фаза (порог 50), stripEmptyPlanBlock до подстановки plan_guidance, review-filter (c-N id), fingerprint SHA-256, applyResume.
- [x] M4.11 `src/cli/output.ts` — text-рендер (бейджи, severity-цвета, wrap 100 рун, ANSI-диффы через порт suggestdiff LCS) + JSON-контракт + emitRunResult/QuietHandle в shared.ts.
- [x] M4.12 `src/cli/backgroundFile.ts` — все лимиты и санитизация (Cf через \p{Cf}); автоподстановка commit message.
- [x] M4.13 Полная команда review (все флаги, resume-валидации). ⚠️ MCP-клиенты не подключены (M6.5).
- **Сверка (live, gemini-2.5-flash):** маленький коммит — полный цикл + task_done + сводка; `-f json` — схема-контракт соблюдена; session JSONL — session_start/llm_request/llm_response/review_item_done(fingerprint)/session_end; большой коммит — plan-фазы (1 выполнена), 429-и от квоты провайдера изолированы по файлам (review_item_failed, completed_with_errors).

## M5 — `ocr scan` (~1.5 дня) — ✅ ЗАВЕРШЕНА

- [x] M5.1 `src/scan/provider.ts` — enumerate (git ls-files -z tracked+untracked с dedup / walk + .gitignore), NUL-сниффинг (8000 байт), лимит 2 МиБ, нормализация --path, filterByPaths. Отличие от Go: gitLs использует stdout-only (в Go runner-ветка использует Run/combined — вероятный баг оригинала, взято безопасное поведение).
- [x] M5.2 `src/scan/batch.ts` (none/by-language/by-directory, чанки BatchSize, сортировка ключей) + `estimate.ts` (2000/7/700, humanTokens, estimateFileTokens для budget look-ahead).
- [x] M5.3 `src/scan/agent.ts` — полный конвейер: фильтры → 80%-отсев → оценка стоимости → батчи последовательно/файлы параллельно (Semaphore) → per-file budget gate → PLAN (formatPlanGuidance из JSON-чеклиста) → MAIN через общий LoopRunner (synthetic Diff для резолва строк) → DEDUP на батч (applyDedupGroups с полной проверкой покрытия id) → PROJECT_SUMMARY; preview.
- [x] M5.4 `src/cli/scan.ts` — все флаги и валидации, отдельный scan-шаблон, --batch override, скрытие file_read_diff из tool defs, workspace FileReader.
- **Сверка (live):** превью корректно (тест-файл исключён default_path); скан `internal/pathutil/path.go` дал находку с suggestion-диффом и Project Summary.

## M6 — Конфиг, сессии, MCP (~1.5–2 дня) — ✅ ЗАВЕРШЕНА

- [x] M6.1 `src/cli/config.ts` — set/unset: полное пространство ключей ВКЛЮЧАЯ telemetry.* (решение: принимаются и сохраняются для совместимости, но эффекта не имеют — OTel не портирован); маскировка api_key/auth_token в выводе; provider→авто-создание entry; model→в entry активного провайдера; unset custom_providers/mcp_servers с очисткой активного. Проверено в изолированном HOME (USERPROFILE).
- [x] M6.2 `src/cli/setup.ts` — @clack/prompts: official (пресет → ключ с env-fallback-подсказкой → модель) / custom / manual (legacy llm.*), после сохранения автотест соединения. ⚠️ Живой TTY-прогон не делался.
- [x] M6.3 `src/session/list.ts` + `src/cli/session.ts` — list/ls/show, таблицы tabwriter-стиля, --json/--limit, статусы aborted/completed (N fail). Проверено на реальных сессиях.
- [x] M6.4 `--resume` — живой прогон: reusing 6 / reviewing 5 по fingerprint, reused-комментарии в коллектор, повторные 429 снова записаны failed.
- [x] M6.5 `src/mcp/` — client.ts (StdioClientTransport, init-таймаут 30с, env merge) + registry.ts (registerAll с allow-list и коллизиями, collectToolDefs, initMCPClients с setup-скриптами cmd /c / sh -c); подключено в review с закрытием клиентов в finally. ⚠️ С реальным MCP-сервером не прогонялось.
- [x] M6.6 quiet-режим — реализован в M4 (QuietHandle), подтверждён в agent/json прогонах.

## M7 — Упаковка (~0.5 дня) — ✅ ЗАВЕРШЕНА (кроме npm publish)

- [x] M7.1 README.md (установка через npm link, быстрый старт, отличия от Go-версии); package.json уже с bin `ocr` → dist/cli.js. ⚠️ `npm publish` не выполнялся — требуется решение пользователя об имени пакета и креды.
- [x] M7.2 Чек-лист контрактов (PLAN.md Часть 4): 1) CLI-поверхность ✓ (все команды/флаги, живые прогоны); 2) JSON-вывод ✓ (live); 3) env-переменные и приоритеты ✓ (построчный порт + негативные тесты); 4) config.json ✓ (roundtrip в изолированном HOME); 5) rule.json ✓ (custom-слой + merge_system_rule live: system-правила подшиты под заголовок); 6) сессии JSONL ✓ (формат Go-совместим; кросс-чтение Go-сессий не проверялось — нет Go-бинарника); 7) промпты байт-в-байт ✓ (cmp в M1); 8) плейсхолдеры ✓ (живые промпты работают); 9) безопасность ✓ (ref-инъекция live, traversal/symlink-guard'ы портированы, санитизация background, 0600, запрет резервных заголовков).
- [x] M7.3 E2E по вехам: review workspace/commit/range preview + полный commit-review + resume; scan preview + живой скан с находкой и Project Summary.

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
| 2026-07-18 | Формат сессий JSONL: канонический — формат TS-версии; чтение сессий, записанных Go-бинарником, НЕ поддерживается (решение пользователя). Убрана имитация Go-таймстампов (RFC3339 без мс) — используем стандартный toISOString(); структура записей и полей осталась той же. |
| 2026-07-23 | Расширение реестра пресетов (решение пользователя): добавлен встроенный провайдер `gemini` (Google Gemini через OpenAI-совместимый эндпоинт, env GEMINI_API_KEY, модели gemini-3.1/2.5/2.0). Проверено: llm providers, config set provider/model, резолв эндпоинта с ключом из конфига и из env. |
| 2026-07-23 | Харденинг: все читатели пользовательских JSON (config.json, кастомный tools.json) снимают UTF-8 BOM (util/text.ts stripBom) — Блокнот и PowerShell на Windows пишут BOM, и JSON.parse падал с криптовой ошибкой. rule.json-читатель пока не захаренен (файл rules.ts занят локальными отладками пользователя) — добавить stripBom в readProjectRuleFile при ближайшей правке. |
| 2026-07-31 | Обновлён список моделей пресета `gemini` по актуальной странице ai.google.dev/gemini-api/docs/models: добавлены gemini-3.6-flash, 3.5-flash, 3.5-flash-lite, 3.1-flash-lite; убран gemini-2.0-flash (shut down). Остальные пресеты не трогали — они синхронизированы с Go-реестром. |
| 2026-07-21 | Расширение за пределы паритета с Go (решение пользователя): флаг `--gitlab` у review — встроенная публикация комментариев в GitLab MR (src/publish/gitlab.ts). Инлайн-дискуссия с suggestion-блоком; при отклонённой позиции или отсутствии номера строки — фоллбэк в общую заметку с пометкой «не удалось привязать к строке N». Настройки: флаги --gitlab-url/-project/-mr либо env CI_*, токен только из env (OCR_GITLAB_TOKEN/GITLAB_TOKEN); валидация до запуска LLM. Проверено мок-сервером GitLab API (inline=1/general=2/failed=0). |
