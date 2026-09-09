# 2026-09-09 — повторное ревью L04–L07

Branch: `feat/live-author-studio`

## Что проверено и исправлено

- L04: отдельный тест теперь достигает лимита `64k` символов при допустимых 32 блоках и доказывает отказ `context_too_large` до вызова backend. Ранее сценарий одновременно превышал число блоков и не доказывал символьную границу.
- L05: launcher сериализует launch/close операции, держит не более одного Player на процесс Studio, переиспользует URL только для того же `playtestId` и той же SQLite БД, а при переключении закрывает предыдущие серверы и хендлы. CLI снова соблюдает `LH_PLAYER_PORT` (по умолчанию 4180) и `LH_RUNTIME_PORT`. Некорректные и содержащие лишние поля launch-запросы отклоняются до launcher; занятый порт даёт `listen_failed` без оставшегося Player.
- L06: cancel-сценарий синхронизирован с фактическим получением медленного upstream-запроса и проверяет точный код `AUTHOR_CANCELLED`, без таймера и широкого допуска. До и после invalid JSON / 401 / 429 / cancel сравнивается содержимое frozen snapshot.
- L07: ошибка `context_too_large` получила пользовательскую инструкцию уменьшить квест до 32 блоков или сократить текст. URL, ошибка и spinner Player показываются только для текущего frozen playtest, поэтому результат прежнего запуска не приклеивается к новой версии.
- Дополнительно исправлен teardown Player UI test и Windows-ветка startup/shutdown drill: после принудительной остановки дочерний процесс обязательно дожидается выхода. POSIX CI остаётся проверкой graceful SIGTERM; на win32 drill честно возвращает `skip` после health/Control/SQLite assertions, потому что parent-process signal semantics не позволяют наблюдать exit code 0.

## Проверки

- `npm run typecheck` — exit 0.
- сфокусированный набор L04–L07 — exit 0, 17/17:
  - `apps/server/test/author-context-l04.test.mjs` — 3/3;
  - `packages/player/test/launch.test.mjs` — 2/2;
  - `apps/player/test/player-ui.test.mjs` — 4/4;
  - `apps/studio/test/live-author-player-launch.test.mjs` — 1/1;
  - `apps/studio/test/live-author-full-http-cycle.test.mjs` — 1/1;
  - `apps/studio/test/author-assistant-ui.test.mjs` — 6/6.
- `npm run verify` — exit 0: Studio 62/62, Player 29/29, Server 121/121; release audit 0 advisories; backup/restore, rollback, boundaries and docs checks passed.
- Настоящий браузер: Studio открылась, provider settings сохранились с честным статусом «проверка не запускалась», после reload модель сохранилась, ключ не отображался, Disconnect вернул состояние `not configured`. Платного вызова провайдера не было.

## Ограничения

- L08 остаётся `UNVERIFIED: нет доступа к провайдеру`.
- Локально использован Node `24.18.0`, тогда как проект требует `>=24.19.0 <25`; все перечисленные проверки прошли, но финальный Linux CI на конечном SHA обязателен.
