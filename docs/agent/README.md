# Контекст для агента

Это короткая точка входа, а не полный Skill. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md).

На bootstrap-этапе публичных HTTP endpoint, генератора API и готового `SKILL.md` для установленного runtime ещё нет. Нельзя выдумывать их по этому файлу. После B01 генератор должен публиковать короткий Skill из фактических схем и реестра реализованных возможностей; planned-операции не попадают в список доступных.

Текущий контрактный экспорт: `@living-history/contracts` предоставляет `ActionStatus`, `ProcessingStatus`, `ActionResultEnvelope` и их runtime-guards. Минимальные правила: делай один bounded-шаг; не изменяй state моделью напрямую; запускай `npm run verify`; сохраняй незавершённость и следующий шаг в handoff.
