# open-code-review-ts

TypeScript-порт [alibaba/open-code-review](https://github.com/alibaba/open-code-review) — AI-код-ревью CLI (`ocr`). Читает git-диффы или целые файлы, отправляет их LLM-агенту с инструментами (чтение файлов, поиск по коду, диффы соседних файлов) и выдаёт построчные комментарии ревью.

Портировано ядро Go-версии 1-в-1 по поведению: команды, флаги, env-переменные, формат `~/.opencodereview/config.json` и схема JSON-вывода совместимы. Промпты и правила ревью скопированы байт-в-байт. Сессии (`~/.opencodereview/sessions/*.jsonl`) пишутся в собственном формате этой версии; чтение сессий, записанных оригинальным Go-бинарником, не поддерживается.

**Не портировано** (сознательно выпилено): web-viewer (`ocr viewer`), OpenTelemetry-телеметрия (ключи `telemetry.*` принимаются для совместимости, но эффекта не имеют), bubbletea-TUI (заменён на промпты @clack), npm-дистрибуция Go-бинарника.

## Установка

```bash
npm install    # зависимости
npm run build  # → dist/cli.js
npm link       # даёт глобальную команду ocr
```

## Быстрый старт

```bash
# настроить провайдера (интерактивно)
ocr config provider

# или неинтерактивно
ocr config set provider anthropic
ocr config set providers.anthropic.api_key "$ANTHROPIC_API_KEY"
ocr config set model claude-opus-4-8

# проверить соединение
ocr llm test

# ревью незакоммиченных изменений
ocr review

# ревью диапазона / коммита
ocr review --from main --to feature-branch
ocr review -c abc123

# что попадёт в ревью (без LLM)
ocr review --preview

# полнофайловый скан
ocr scan --path src/core

# JSON для CI
ocr review --from origin/main --to HEAD --format json --audience agent
```

Полная документация по флагам: `ocr review -h`, `ocr scan -h`, `ocr config`, `ocr session -h`.

## Конфигурация

- `~/.opencodereview/config.json` — провайдеры/модели/MCP-серверы (`ocr config set …`).
- `<repo>/.opencodereview/rule.json` и `~/.opencodereview/rule.json` — свои правила ревью (`ocr rules check <file>` покажет, какое правило применится).
- Env-переменные: `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL` / `OCR_USE_ANTHROPIC` / `OCR_LLM_AUTH_HEADER` / `OCR_LLM_EXTRA_HEADERS` / `OCR_LLM_TIMEOUT`; также распознаются `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` (Claude Code) и shell-rc экспорты.
- Сессии: `~/.opencodereview/sessions/…` (`ocr session list`, `ocr review --resume <id>`).

## Разработка

- `npm run typecheck` — строгая проверка типов.
- `npm run dev -- <args>` — запуск из исходников (tsx).
- `PROGRESS.md` — состояние миграции; `docs/PLAN.md` — полный план и карта соответствия исходникам Go.
