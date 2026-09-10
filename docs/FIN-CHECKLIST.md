# FIN — единый трекер маршрута завершения

Обновлено: 2026-09-11. Первичный план: [PLAN-FIN-RU.md](PLAN-FIN-RU.md) (единственный актуальный указатель; этот файл — его состояние).
Состояния: `TODO` · `IN_PROGRESS` · `LOCAL_PASS` · `HOSTED_PASS` · `UI_PASS` · `PARTIAL` · `BLOCKED`.

| Карточка | Исходные | Статус | Доказательство | Следующее действие |
|---|---|---|---|---|
| FIN-00 контекст и карта | — | LOCAL_PASS | этот файл + SHA ниже | — |
| FIN-01 неизменяемый bundle и rollback | B02, M01/M06 | LOCAL_PASS | `apps/server/test/fin01-release-bundle.test.mjs` 5/5 (до фикса 0/5); Control 106/106, Server 138/138 | hosted-проверка после доставки |
| FIN-02 согласованная публикация/повтор | B03, M06 | TODO | `m06-publish-sync.test.mjs`, `m06-public-catalog.test.mjs` (MemoryStore) — реальная SQLite не покрыта | транзакция/операция pending→committed, CAS+idempotency receipt, SQLite-тесты |
| FIN-03 старые сессии сохраняют ассеты | B04, M03/M06 | TODO | ассеты привязаны к текущей публикации | доступ к ассетам версии через session binding + immutable published objects |
| FIN-04 доставка всех компонентов | B01, R04 | PARTIAL | engine exact-SHA `7e61f98` + supervised `lhc-authored` доставлены (2026-09-11) | B01: Studio `main.ts` держит собственный Control-писатель и публикацию-store; нужен manifest версий процессов/образов и проверка, что старый Control не пишет в общую БД |
| FIN-05 экраны и ручная композиция | M03–M05, F05 | TODO | общий renderer подключён, композиция слоёв не закрыта | слои/transform/анимация/аудио, 3 сцены + 2 финала не-Florence |
| FIN-06 ручной маршрут и права | M06, C18 | PARTIAL | hosted happy-path пройден; C18 роли — нет живых editor/viewer/read-only сессий | capability-матрица + backend negative tests на локальных identities; живые роли — по приглашённым аккаунтам |
| FIN-07 подключения провайдеров | M07.a | TODO | — | «Настройки → ИИ», защищённое хранение ключей |
| FIN-08 каталог моделей и router | M07.b | TODO | — | профили автор/ведущий, live inference отдельно от списка |
| FIN-09 ИИ создаёт полную миссию | M08 | TODO | — | writer + intent-контракт ведущего, две ветви и два финала |
| FIN-10 понятность для новичка | M09 | TODO | — | тур по реальным элементам, русские ошибки с действием |
| FIN-11 сквозная приёмка авторства | M10 | TODO | — | одна воспроизводимая история проверки + E-матрица |
| FIN-12 стикеры и комментарии | V07 | TODO | — | серверные заметки/треды, не localStorage |
| FIN-13 совместная доска | V08 | TODO | — | presence + конкурентное сохранение |
| FIN-14 финальная приёмка и передача | — | TODO | — | пакет передачи: адреса, 2 миссии, инструкции, manifest |

Четыре подтверждённые проблемы повторного аудита M06 и их карточки: B01 → FIN-04, B02 → FIN-01, B03 → FIN-02, B04 → FIN-03.

## Текущее состояние (SHA)

- Engine `C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio`, ветка `feat/b13-acceptance-closure`, вход `97810ea`.
- Site `C:/Temp/lhc-site-audit-20260910`, ветка `feat/florence-vertical-slice`, `db7cbe848…` (checkout не переключать).
- VPS `/opt/lhc/engine` — `7e61f9889724f01a5f5c1c2e511093c177ceac6b`; hosted-фиксы FIN-01 на стенде **не развёрнуты**.
- Runtime проверок: portable Node `24.19.0` (`AppData/Local/Temp/node-v24.19.0-win-x64`); системный `v22.23.2` даёт ложный fail `C17`.

## Не проверено / блокеры

- FIN-01: hosted-проверка rollback требует доставки новой ревизии engine на стенд (не выполнялось в этой карточке).
- FIN-01 известное ограничение: bundle фиксируется при **сборке релиза** (HTTP-маршрут build) или, если pin отсутствует, при первой публикации; релизы, собранные до этой правки, остаются без pin — их mapping берётся из записи публикации, а при невозможности доказать ревизию публикация/rollback отказывают (`LEGACY_PIN_UNPROVABLE`), а не подставляют latest draft.
- FIN-05/FIN-06: живые роли C18 требуют приглашённых Telegram-аккаунтов; gate не ослаблять.
- FIN-04: production-канал и рестарт gate/блога/Ивы без явного разрешения владельца не выполняются.
