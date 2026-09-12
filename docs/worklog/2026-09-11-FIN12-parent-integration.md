# FIN-12 (схема): parent-привязка сообщений — проверка ветки и интеграция

Дата: 2026-09-11. Основание: `eb361ef` (база волны), ветка субагента `feat/lhc-fin12-parent` (`b7f8f84`).

## Что сделал субагент (проверено)

- Схема: `control_collaboration_messages.parent_message_id TEXT NULL` + табличная составная FK
  `(project_id, quest_id, thread_id, parent_message_id) -> (…, message_id)`. `CONTROL_SCHEMA_VERSION` 5 → 6,
  миграция v5 перестраивает таблицу (RENAME → CREATE → INSERT…SELECT → DROP) в одной транзакции.
- Причина отклонения от задания: SQLite отказывает в одноколоночном `REFERENCES` на составной PK — проверено
  прямым запуском `node:sqlite`; `ALTER TABLE` не умеет добавлять табличную FK, поэтому перестройка.
- Валидация родителя в `addMessage`/`createThread`: существует + тот же тред + не tombstone, иначе `invalid_request`
  без записи и без съедания idempotency-ключа.
- Тесты: `packages/control/test/collaboration-parent.test.mjs` на **файловых** БД, включая легаси-файл, собранный
  по старому DDL.

## Независимая проверка (не по отчёту)

| Проверка | Результат |
|---|---|
| `git ls-remote origin refs/heads/feat/lhc-fin12-parent` vs локальный HEAD | совпадает, `b7f8f84` |
| дерево worktree | чистое |
| `npx tsc -b --force` | exit 0 |
| `node --test packages/control/test/*.test.mjs` | 122/122, exit 0 |
| мутация «не писать родителя» (`input.replyToMessageId ?? null` → `null`) | 1 pass / 2 fail, exit 1 |
| откат мутации | 3/3 зелёные, `src/**` чист |

## Интеграция (сделана оркестратором)

- `apps/server/src/control-server.ts`, маршрут `POST /comments/:threadId/messages`: `replyKeys` допускает
  `replyToMessageId` в двух комбинациях, форма id проверяется регуляркой (400), структурно неверный родитель даёт
  422 `INVALID_COLLABORATION_REQUEST` из стора.
- Новый `apps/server/test/fin12-parent-http.test.mjs` — родитель доезжает по HTTP, сохраняется, читается после
  повторного открытия БД; лишние ключи по-прежнему 400; кривой id 400; несуществующий родитель 422 и ничего не пишет.
- Мутация маршрута (снят `replyToMessageId` из ключей и из тела) → тест 0/1, откат → 1/1.
- `apps/studio/styles.css`: полоса присутствия переведена на перенос строк — многоточия запрещены правилом продукта,
  это ловит `apps/studio/test/fin12-notes-ui.test.mjs`.

## Итоги прогонов после вливания

- server: 175 tests / 174 pass / 0 fail / 1 skipped, exit 0
- studio: 183 tests / 182 pass / 0 fail / 1 skipped, exit 0
- contracts: 57/57, exit 0
- control: 122/122, exit 0

## Что НЕ проверено

- Живой UI-рендер ответа «на конкретное сообщение» (Studio не рисует parent-связь: `CollaborationMessageView`
  и `collaboration.ts` не тронуты).
- Миграция из v1…v4 с уже существующей таблицей сообщений — прогнан только v5 и свежая БД.
- Параллельные записи двух соединений в момент перестройки таблицы.
