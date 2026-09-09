# 2026-09-09 — Командное размещение Studio + Engine на VPS (приёмка)

Цель: приглашённые участники работают в Studio по HTTPS с Telegram-подтверждённым входом;
движок постоянно доступен; preview приложения связан с этим движком.

## Инфраструктура (VPS 85.137.95.104 / conradipui.fvds.ru)

- Docker (node:24.19-slim): lhc-engine (8742 generic runtime + 8746 authored runtime),
  lhc-studio (8740 Studio + 8745 Player), lhc-gate (8744 Telegram-гейт);
- nginx+certbot: :8741 ssl Studio (auth_request через гейт), :8743 ssl Engine API;
- host network: продуктовые loopback-границы (L01) не ослаблялись — nginx нормализует Host/Origin;
- блог, Ива, glmbot, n8n, hermes-dashboard не затронуты (порты 8080/8730/8731/8723/5678/9119 нетронуты).

## Telegram-доступ (без пароля, с отзывом)

1. Владелец: `POST /gate/invite {telegramId}` (x-lhc-master) → одноразовый код, TTL 15 мин;
2. Участник: invite-URL → «Log in with Telegram» (widget @glmbot_bot; верификация HMAC локально,
   polling Ивы не затрагивается; до /setdomain в @BotFather кнопка не отрисуется — браузерный вход
   требует одного действия владельца, API-путь приёмки не требует);
3. `POST /gate/callback` — проверка подписи + совпадение telegram id + одноразовость кода;
4. Cookie `lhc_session` (HMAC, TTL 12h, HttpOnly+Secure);
5. Отзыв: `POST /gate/revoke {sessionId|inviteCode}`.
Доказано живьём: invite → callback → check ok → Studio 200 (без cookie — страница входа).

## Приёмка участника (сценарий через публичный HTTPS)

1. create project/quest (blocks) → 201;
2. validate → freeze (playtest-1) → 201;
3. переоткрытие: GET quests → квест на месте (SQLite persist);
4. `POST /local/launch-player` → 200, Player на 8745, публичный путь `/p/playtest-1`;
5. игровой smoke через публичный путь: create 201 (ink=3) → paint executed (ink 3→2, 60s) →
   resume (rev=1, clock=60) → идемпотентный replay (тот же turnId).
PASS.

## Внешняя связка preview ↔ движок VPS

- движок: canon Florence (B11 authored scenario, examples/florence) опубликован в SQLite
  (seed-florence.mjs: createRelease+publishRelease), authored-runtime на 8746, HTTPS :8743;
- preview (sandbox repo): merge main (engine-bff.ts) в ветку + vars ENGINE_* (без --keep-vars,
  т.к. keep-vars замещал vars конфига) → деплой success `55504e7` (run `34344285781`);
- доказательство: preview-сессия создаётся с КАНОНИЧЕСКИМИ engine-опциями (draft/healer/close —
  опции движка, не legacy), счётчик сессий движка 14→15 при создании;
- игровой прогон через связку: create turn=1 → prepared 'draft' turn=2 («Люди и доказательства») →
  resume turn=2 → идемпотентный 'healer' (turn не растёт при replay).
PASS — внешняя связка доказана именно как продуктовый путь (BFF → HTTPS engine → VPS SQLite).

## Статус по правилам

- Командное размещение + доступ + приёмка участника: DONE;
- Внешняя связка preview→движок: DONE;
- B13.a2 изоляция: PARTIAL (не изменилось — CI runner остаётся обязательной изолированной средой);
- Для живых участников: widget требует одного /setdomain в @BotFather от владельца (домен
  85.137.95.104.sslip.io); API-путь (invite/callback/check) уже полностью работает.

## Ресурсы

- Движок-хостинг не потребовал новых ресурсов: VPS пользователя, docker, certbot-сертификат.
