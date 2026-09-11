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

## Telegram-вход (бот-управляемый, без паролей и ручных кодов)

1. Отдельный бот **@living_history_gate_bot** (polling getUpdates в процессе lhc-gate;
   токен на VPS в `deploy/vps/.env` как `LHC_TELEGRAM_BOT_TOKEN`, в git НЕ коммитится).
2. Владелец задан серверной настройкой `LHC_OWNER_TELEGRAM_ID` (самоназначение невозможно —
   такого API/команды нет). Меню владельца: «Добавить участника», «Участники»,
   «Отозвать доступ», «Открыть Studio».
3. Участникам — одна ссылка на бота. `/start` допущенного показывает «Открыть Studio»,
   недопущенного — понятное сообщение + запрос владельцу на подтверждение.
4. Добавление: числовой Telegram ID — сразу права; @username — предзаявка, права
   появляются, когда человек с таким username пишет `/start` (фиксируется числовой ID).
5. Кнопка «🎭 Открыть Studio» в боте создаёт персональный тикет (одноразовый,
   TTL 90 сек, привязан к числовому ID) и отдаёт ссылку `…/?ticket=…`.
   Браузер показывает «Войти в мастерскую», один клик — `POST /gate/ticket/consume`
   ставит cookie. Без обмена тикета сессии нет; тикет доставляется личным
   сообщением Telegram проверенному аккаунту — это и есть аутентификация.
6. Сессии серверные: cookie `lhc_session` HttpOnly+Secure+SameSite=Lax без Max-Age
   (живёт до закрытия браузера), серверная запись — 90 суток или до отзыва.
   Права действуют до отзыва; закрытие браузера = повторный вход через бота
   без нового приглашения; отзыв убивает активные сессии.
7. Старые пути входа (`/gate/invite`, `/gate/callback`, `/gate/revoke`, `/gate/login/*`)
   удалены (отвечают 410). Страница входа: `deploy/vps/login.html` → `/var/www/lhc/login.html`.
8. Тесты: `node --test deploy/vps/lhc-gate.test.mjs`. Живая приёмка с людьми —
   по `deploy/vps/ACCEPTANCE-checklist.md` (автоматике недоступны чужие аккаунты).

## Установка (root@conradipui.fvds.ru, docker 29.6.1, node системный 24.18 → движок в контейнере 24.19)

    # 1. Код
    git clone <engine repo> /opt/lhc/engine && cd /opt/lhc/engine
    # 2. Engine в docker (node:24.19-slim), Studio — системный node НЕ подходит (24.18 < engines) → тоже docker
    docker compose -f deploy/vps/docker-compose.yml up -d --build
    # 3. Gate
    LHC_GATE_SECRET=$(openssl rand -hex 32) node deploy/vps/lhc-gate.mjs &   # или systemd unit
    # 4. nginx
    cp deploy/vps/nginx-lhc.conf /etc/nginx/conf.d/lhc.conf && nginx -t && systemctl reload nginx

## Согласованная доставка (FIN-04)

Доставка выполняется **на стенде** из корня репозитория и работает fail-closed:
до первой записи проверяется, что полный 40-символьный SHA — потомок текущего
удалённого head, дерево чистое, а прочитанный обратно HEAD равен pin.

    # доставить Engine + authored + Studio (Site не трогается)
    deploy/vps/deliver-all.sh <full-40-hex-sha>

    # то же, плюс сайт из отдельного репозитория
    deploy/vps/deliver-all.sh <full-40-hex-sha> --site --site-root /opt/lhc/site

    # напечатать всю последовательность и ничего не выполнить
    deploy/vps/deliver-all.sh <full-40-hex-sha> --dry-run

Откат на прежний SHA с пересборкой только названных образов:

    deploy/vps/deliver-rollback.sh <full-40-hex-sha> --images engine,authored,studio

Секреты берутся только из `deploy/vps/.env` на стенде (`--env-file`); скрипты
знают имена переменных, но не значения. gate, блог и Ива этими скриптами не
перезапускаются. Без `--site` Site честно печатается как «пропущено». Тесты:
`node --test apps/server/test/fin04-delivery-script.test.mjs`.

## Приёмка

Автоматика: `node --test deploy/vps/lhc-gate.test.mjs` (гейт и бот: права, тикеты,
подтверждения, отзыв, миграция v2→v3). Вживую с людьми — по
`deploy/vps/ACCEPTANCE-checklist.md`: вход владельца, вход участника, неизвестный,
повтор ссылки, вход без бота, отзыв активной сессии.

## Известные ограничения

- `LH_PLAYER_FIXED_PORT=8745` рассчитан на **один активный Player**: запуск второго playtest
  при занятом порту даст честный `listen_failed`. Для параллельных playtest'ов нужен
  порт-менеджер (диапазон портов + динамический nginx map) — отдельная доработка.
- Loopback-контракт Studio (L01) сохранён: nginx нормализует Host/Origin; boundary не ослаблялся.

## Ограничения

- B13.a2 остаётся PARTIAL: размещение на VPS не является изоляцией исполнения.
- Merge #39 и production-деплой в это задание не входят.
