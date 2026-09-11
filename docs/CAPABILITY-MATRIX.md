# Capability matrix (FIN-06 / C18)

Что проверяет этот файл: какие роли есть в Control, что каждая из них может, и чем это
подтверждено. Матрица составлена по коду `apps/server/src/control-server.ts`
(`requireProjectRole` / `authorizeProject`) и проверена на живом HTTP-сервере набором
`apps/server/test/fin06-role-matrix-http.test.mjs`.

## Роли

`CONTROL_ROLES = owner | editor | tester` (`packages/control/src/security.ts`).
Ранг строгий: `owner > editor > tester`, роль выдаётся участнику проекта
(`getProjectRole`) и проверяется на сервере на каждом маршруте.

- **owner** — владелец проекта: редактирует, публикует, управляет участниками.
- **editor** — автор: редактирует, собирает релизы, запускает проверки. Не публикует и не управляет составом.
- **tester** — участник без права записи: читает всё, что видит проект, и запускает неразрушающие проверки (валидация, playtest). Роль **является** read-only/viewer ролью продукта: отдельной роли `viewer` в модели нет, и это осознанно — отдельная роль потребовала бы миграции схемы безопасности без новой возможности.

Две ветки отказа различаются намеренно:

- **не участник проекта** → `404` (существование проекта не подтверждается);
- **участник с недостаточной ролью** → `403 CONTROL_FORBIDDEN`.

Любая mutation дополнительно требует CSRF-доказательство сессии
(`x-csrf-token`): без него `403 CONTROL_CSRF_REQUIRED`, с неверным — `403 CONTROL_CSRF_INVALID`.
Заголовки вида `x-lh-user-id`/`x-user-role` роль не повышают.

## Матрица маршрутов

Сессия требуется на всех маршрутах `/control/v1/*`; ниже — минимальная роль.

| Маршрут | Метод | Роль |
|---|---|---|
| `/control/v1/projects/{p}/members` | GET, POST, PATCH, DELETE | owner |
| `/control/v1/projects/{p}/quests` | GET | tester |
| `/control/v1/projects/{p}/quests` | POST (создание миссии) | editor |
| `/control/v1/projects/{p}/quests/{q}/draft` | GET | tester |
| `/control/v1/projects/{p}/quests/{q}/draft/changes` | POST | editor |
| `/control/v1/projects/{p}/quests/{q}/board` | GET | tester |
| `/control/v1/projects/{p}/quests/{q}/board/changes` | POST | editor |
| `/control/v1/projects/{p}/quests/{q}/collaboration/**` | GET | tester |
| `/control/v1/projects/{p}/quests/{q}/collaboration/**` | POST (заметки, треды, статусы) | editor |
| `/control/v1/projects/{p}/quests/{q}/mission` | GET | tester |
| `/control/v1/projects/{p}/quests/{q}/mission` | POST (сохранение документа) | editor |
| `.../mission/sessions` | POST | editor |
| `.../mission/sessions/{id}` | GET | tester |
| `.../mission/sessions/{id}/turns` | POST | editor |
| `/control/v1/projects/{p}/assets` | GET | tester |
| `/control/v1/projects/{p}/assets?all=1` | GET (включая черновики) | editor |
| `/control/v1/projects/{p}/assets` | POST (загрузка) | editor |
| `/control/v1/projects/{p}/assets/{a}` | GET | tester |
| `.../validations` | POST | tester |
| `.../releases` | GET | tester |
| `.../releases` | POST (сборка релиза) | editor |
| `.../publish` | POST | owner |
| `.../rollback` | POST | owner |
| `.../publication/unpublish` | POST | owner |
| `.../playtests` | POST | tester |
| `.../playtests/{id}` , `.../playtests/{id}/trace` | GET | tester |

Публичный контур `/public/v1/*` сессии не требует и отдаёт только опубликованное;
неопубликованный черновик в каталог не попадает.

## Чем подтверждено

`apps/server/test/fin06-role-matrix-http.test.mjs` — 3 теста, 13 разрешённых и
20 отказных проверок на реальном сервере с четырьмя локальными identities
(owner, editor, tester, посторонний): матрица по маршрутам, немедленное действие
смены роли и отзыва членства, отзыв сессии, CSRF, подделка identity-заголовков,
публичный контур.

Несущая способность набора проверена мутациями исходников: снятие требования
`owner` на `publish` (editor получает доступ → тест краснеет) и снятие требования
CSRF-токена (ответ `CONTROL_CSRF_INVALID` вместо `CONTROL_CSRF_REQUIRED` → тест краснеет).
Мутации откачены.

## Открытые вопросы (решение владельца, не дефект)

1. **Отдельная роль `viewer`.** Сейчас read-only обеспечивает `tester`. Если владелец хочет
   различать «смотрит» и «играет проверочный прогон», это отдельная роль + миграция.
2. **Комментарии для `tester`.** Запись в collaboration требует `editor`. Нужно решить,
   может ли read-only участник комментировать (FIN-12 оставляет это на capability-матрицу).
3. **Подтверждённый numeric Telegram ID.** Привязку прав к подтверждённому числовому
   Telegram ID и приглашение по username нужно проверить на живых приглашённых аккаунтах
   (live C18) — локальными identities это не доказывается.
