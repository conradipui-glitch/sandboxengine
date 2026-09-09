# 2026-09-09 — B13.c1 production policy, lost-response reconciliation and verified rollback

Branch: `feat/live-author-studio`

## Реализовано

- `apps/builder-runner/src/production-deployment.ts`:
  - отдельная, более строгая production-политика: immutable policy (target/workflow/ref, smoke URL +
    подстрока, `maxConcurrentDeployments === 1`) + обязательный per-SHA `ProductionGrant`
    (`authorizedBy`, bounded `reason`); без grant деплой невозможен;
  - `ProductionDeploymentAdapter.deploy(grant)` — dispatch фиксированного workflow → сверка рана с
    grant.commitSha → success → smoke; квитанция `production-<runId>` с identity и reason;
  - `reconcileLostResponse(grant, findRunForSha)` — потерянный ответ восстанавливается по SHA:
    если ран уже существует и успешен + smoke прошёл, возвращается та же квитанция БЕЗ нового
    dispatch (повтор не создаёт скрытый второй деплой; T35);
  - `rollback(fromCommitSha, rollbackGrant)` — verified rollback на другой SHA: refusal при
    равенстве SHA, dispatch → сверка → smoke; квитанция `rollback-<runId>` с from/to SHA;
  - все отказы типизированы (`production_*`, `rollback_*`), smoke ≤1 MiB, ошибки bounded.

## Проверки

- `npm run test:builder` — exit 0, 24/24 (+5 тестов c1): happy-path деплой с грантом;
  reconcileLostResponse возвращает существующую квитанцию без нового dispatch и null при
  отсутствии/провале рана; verified rollback на другой SHA + отказ same-SHA; fail closed при
  плохом гранте/провале рана/провале smoke (деплой и rollback); строгая валидация policy;
- полный `npm run verify` и Linux CI — см. итоговый коммит ветки.

## Ограничения

- Фактический production dispatch не выполнялся из этой сессии (production не трогаем без явного
  разрешения оператора на конкретный артефакт); механика доказана на Gateway-интерфейсе и
  идентична проверенному b2-адаптеру.
- Rollback предполагает, что workflow деплоит то, что содержит ref; ответственность за указание
  ref на rollback-коммит несёт вызывающая среда (в GH-сценарии — ref preview/workflow config).
