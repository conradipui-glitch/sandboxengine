# 2026-09-09 — B13.b2 single preview deployment adapter

Branch: `feat/live-author-studio`

## Реализовано

- `apps/builder-runner/src/preview-deployment.ts`:
  - один deployment path: `PreviewDeploymentPolicy` фиксирует target (repository/workflow file/ref),
    artifact identity (exact 40-hex SHA), smoke URL и ожидаемую подстроку;
  - `PreviewDeploymentAdapter.deploy()` — dispatch фиксированного workflow → сверка рана с тем же
    SHA (drift ref между push и dispatch отклоняется, а не деплоится) → success run → HTTP smoke
    (≤1 MiB, ожидаемая подстрока); квитанция `deploymentId=preview-<runId>` + SHA + smoke URL;
  - `deployment_not_authorized` при попытке деплоить другой SHA; `deployment_reconciliation_failed`
    при failed run; `smoke_failed` при недоступности/несовпадении ответа;
  - `createGhPreviewDeploymentGateway(repositoryId)` — реализация Gateway через `gh` fixed argv
    (workflow run / run list / run view), environment без лишних секретов, bounded timeouts;
    Cloudflare-токены остаются только в CI, модуль их не получает;
  - policy-валидация: owner/repo shape, имя workflow-файла, ref без `..`, exact SHA, http(s)
    smoke URL, bounded substring — всё fail closed.

## Проверки

- `npm run test:builder` — exit 0, 19/19 (+3 теста b2: happy path с квитанцией; отказ при drift
  SHA/failed run/smoke mismatch/smoke connection error; 6 вариантов malformed policy);
- реальный preview deploy намеренно НЕ запускался из этой сессии: dispatch workflow
  `Deploy Florence Preview` в `conradipui-glitch/sandbox` выполняется на ref
  `feat/florence-vertical-slice` чужой вертикали; адаптер доказан на интерфейсе Gateway,
  живой прогон фиксируется как отдельный шаг приёмки B13 (по решению оператора).

## Ограничения

- Адаптер не создаёт, не меняет и не удаляет workflows; он только dispatch'ит уже существующий.
- Smoke-подстрока и URL происходят из immutable policy; среда не может подменить их на лету.
