# Командное размещение Studio + Engine на VPS (85.137.95.104.sslip.io)

Цель: приглашённые участники работают в Studio через Telegram-подтверждённый вход; движок
постоянно доступен для связки с preview приложения. Блог, Ива, glmbot, n8n, hermes-dashboard
не затрагиваются.

## Размещение (порты на loopback, наружу только через nginx+SSL)

| Сервис | Loopback | Внешний (nginx ssl) | Назначение |
|---|---|---|---|
| Studio (apps/studio) | 127.0.0.1:8740 | :8741 ssl | Авторы: редактор, запуски Player |
| Engine (apps/server) | 127.0.0.1:8742 | :8743 ssl | Runtime API для приложения |
| Player (запускается Studio) | 127.0.0.1:8745 | :8745 ssl (nginx) | Просмотр frozen playtest |
| lhc-gate | 127.0.0.1:8744 | :8741/gate/* | Telegram-аутентификация |

## Telegram-доступ (без пароля, с отзывом)

1. Владелец один раз в @BotFather для бота Ивы/hermes (токен уже на VPS): `/setdomain` →
   `85.137.95.104.sslip.io` (Login Widget привязывается к домену; сама верификация подписи
   выполняется локально HMAC — конфликтов с polling Ивы нет).
2. Владелец: `POST /gate/invite {"telegramId": <id>}` с `x-lhc-master` → одноразовый код, TTL 15 мин.
3. Участник открывает invite-URL → «Log in with Telegram» → `POST /gate/callback` проверяет
   HMAC-подпись Telegram, совпадение `auth.id` с приглашённым id, одноразовость кода.
4. Успех: HMAC-подписанная cookie `lhc_session` (TTL 12h, HttpOnly+Secure).
5. Отзыв: `POST /gate/revoke {sessionId | inviteCode}` — сессия мгновенно недействительна.
6. nginx `auth_request /gate/check` закрывает Studio и Player от неавторизованных.

## Установка (root@conradipui.fvds.ru, docker 29.6.1, node системный 24.18 → движок в контейнере 24.19)

    # 1. Код
    git clone <engine repo> /opt/lhc/engine && cd /opt/lhc/engine
    # 2. Engine в docker (node:24.19-slim), Studio — системный node НЕ подходит (24.18 < engines) → тоже docker
    docker compose -f deploy/vps/docker-compose.yml up -d --build
    # 3. Gate
    LHC_GATE_SECRET=$(openssl rand -hex 32) node deploy/vps/lhc-gate.mjs &   # или systemd unit
    # 4. nginx
    cp deploy/vps/nginx-lhc.conf /etc/nginx/conf.d/lhc.conf && nginx -t && systemctl reload nginx

## Приёмка (сценарий участника)

1. Приглашение владельца → участник открывает `https://…:8741/?invite=…` → Telegram-логин → cookie.
2. Studio: создать проект/квест → сохранить (draft revision 1).
3. Перелогин/повторное открытие: квест на месте (SQLite persist).
4. Freeze → «Открыть в Player» → Player открывается по `https://…:8745/p/<playtestId>` → покраска работает.
5. Внешняя связка: `POST https://living-history-florence-preview.../api/games {runtime:"engine"}` →
   BFF ходит в `ENGINE_RUNTIME_URL=https://85.137.95.104.sslip.io:8743` → сессия движка на VPS.

## Известные ограничения

- `LH_PLAYER_FIXED_PORT=8745` рассчитан на **один активный Player**: запуск второго playtest
  при занятом порту даст честный `listen_failed`. Для параллельных playtest'ов нужен
  порт-менеджер (диапазон портов + динамический nginx map) — отдельная доработка.
- Loopback-контракт Studio (L01) сохранён: nginx нормализует Host/Origin; boundary не ослаблялся.

## Ограничения

- B13.a2 остаётся PARTIAL: размещение на VPS не является изоляцией исполнения.
- Merge #39 и production-деплой в это задание не входят.
- Login Widget требует одноразового `/setdomain` от владельца в @BotFather (существующий токен
  бота используется только для верификации подписи локально; polling Ивы не затрагивается).
