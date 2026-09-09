# Установка Scroll Craft — 2026-09-07

По запросу владельца проекта установлен public skill Scroll Craft как project-level Codex skill.

## Источник и целостность

- Репозиторий: https://github.com/nateherkai/scroll-craft
- Зафиксированный upstream commit: `0b816225945e45380397d6a0487efa3c98916858`.
- Исходная папка: `plugins/nateherk-design/skills/scroll-craft/`.
- Папка назначения: `.agents/skills/scroll-craft/`.
- Скопирована вся папка: **24 файла**, каталоги `engine`, `references`, `scripts`, `templates`.
- Списки файлов и каталогов сверены с полным Git tree upstream; Git blob SHA-1 каждого файла совпадает с upstream. Содержимое skill не изменено.
- Исходный MIT LICENSE с copyright Nate Herk сохранён отдельно в `docs/licenses/scroll-craft-LICENSE`; его Git blob hash также совпадает с upstream.
- База установки: `a08f343` (`main` на момент клонирования). Рабочая ветка: `codex/install-scroll-craft-skill`.

## Проверки

На Windows выполнена команда из корня проекта:

```text
node .agents/skills/scroll-craft/scripts/doctor.mjs
```

Результат: **exit code 0**, `Ready, with 3 optional item(s) missing`.

- Node.js `v24.18.0` — OK для skill (требуется >=18).
- Полная сборка FFmpeg — OK, 588 строк в выводе списка фильтров; libwebp — present.
- Chrome — найден.
- Workspace — успешно определяется относительно корня проекта.
- `playwright-core` — отсутствует, нужен для браузерной проверки будущих страниц.
- `KIE_AI_API_KEY` — не задан, нужен только для генерации изображений через KIE.
- Реестр сборок — ещё не создан; инициализируется при использовании skill.

Дополнительно проверено окружение репозитория:

- `npm ci --no-audit --no-fund` — exit 0, с EBADENGINE: проект требует Node `>=24.19.0 <25`, локально `24.18.0`; npm локально `11.16.0`, в packageManager проекта `11.9.0`.
- `npm run verify` — **exit 1**. Typecheck и группы contracts (37), core (55), ai (12), storage (20), control (14), server (10) прошли. Studio: 12 passed / 3 failed (HTTP 404 вместо 200 при выдаче browser bundle). После Studio последовательный verify остановился, Player в этом запуске не выполнялся.
- Отдельный `node scripts/docs-check.mjs` — **exit 0**, 10 navigation documents и 5 generated contracts актуальны.
- Отдельный `node scripts/check-boundaries.mjs` — **exit 1**, Windows ENOENT с дублированным диском `C:\C:\...` при преобразовании file URL. Этот скрипт не изменён установкой.

Установочный doctor прошёл; полный Windows verify проекта зелёным не объявляется. Исправления runtime, Studio, зависимостей и Windows-путей в эту установку не включены.

## Добавленные файлы

- `.agents/skills/scroll-craft/CHANGELOG.md`
- `.agents/skills/scroll-craft/SKILL.md`
- `.agents/skills/scroll-craft/engine/scrollcraft.css`
- `.agents/skills/scroll-craft/engine/scrollcraft.js`
- `.agents/skills/scroll-craft/references/approved-collection.md`
- `.agents/skills/scroll-craft/references/assets.md`
- `.agents/skills/scroll-craft/references/device-diag.html`
- `.agents/skills/scroll-craft/references/devices.md`
- `.agents/skills/scroll-craft/references/feel.md`
- `.agents/skills/scroll-craft/references/hero-depth.md`
- `.agents/skills/scroll-craft/references/taste.md`
- `.agents/skills/scroll-craft/references/template.html`
- `.agents/skills/scroll-craft/references/uniqueness.md`
- `.agents/skills/scroll-craft/references/verify.md`
- `.agents/skills/scroll-craft/references/worldflight.md`
- `.agents/skills/scroll-craft/references/worlds.md`
- `.agents/skills/scroll-craft/scripts/doctor.mjs`
- `.agents/skills/scroll-craft/scripts/encode.sh`
- `.agents/skills/scroll-craft/scripts/kie.mjs`
- `.agents/skills/scroll-craft/scripts/serve.mjs`
- `.agents/skills/scroll-craft/scripts/shoot.mjs`
- `.agents/skills/scroll-craft/scripts/workspace.mjs`
- `.agents/skills/scroll-craft/scripts/worldflight-assert.mjs`
- `.agents/skills/scroll-craft/templates/FINGERPRINTS.md`
- `docs/licenses/scroll-craft-LICENSE`
- `docs/worklog/2026-09-07-scroll-craft-install.md` (этот отчёт)

Итого: **26 новых файлов в репозитории**. Existing tracked files не изменены.

## Глобальная установка и продолжение

По дополнительному запросу владельца такая же полная копия установлена локально в `%CODEX_HOME%/skills/scroll-craft/` (при стандартной конфигурации `~/.codex/skills/scroll-craft/`). Лицензия сохранена рядом как `scroll-craft.LICENSE`. Все 24 файла глобальной копии также совпадают с upstream.

Doctor глобальной копии запущен из рабочей папки этой задачи: exit 0, те же три необязательных предупреждения. Это проверка локального окружения, а не результат CI GitHub.

Глобальный skill доступен со следующего хода Codex. В проекте обнаружение skill применяется к checkout, содержащему `.agents/skills/scroll-craft/`. Установка подготовлена в отдельной ветке; слияние в `main` этим журналом не заявляется. Следующий шаг — проверить и слить PR установки. Работа над B06 остаётся отдельной задачей.
