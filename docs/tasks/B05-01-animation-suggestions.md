# B05-01 — Automatic animation suggestions in Studio

## Цель

Добавить в авторский интерфейс постановки режим, в котором Studio после ввода авторского промпта или изменения сцены автоматически анализирует доступный `SceneFrame`, разрешённые объекты и каталог presentation-команд, предлагает несколько разных вариантов анимации, даёт мгновенно предпросмотреть каждый вариант и применяет выбранный вариант как обычный валидируемый `PresentationPlan`.

Это **authoring assistance**, а не gameplay logic. Выбор/генерация анимации не меняет `WorldState`, не выполняет игровые эффекты и не участвует в commit игрового действия.

## Пользовательский поток

1. Автор описывает сцену/постановку человеческим текстом либо редактирует уже собранную сцену.
2. Studio определяет доступный контекст: `fromFrame`, целевой `SceneFrame`, появившиеся/исчезнувшие актёры и предметы, изменившиеся выражения, фон, реплики, overlay и аудио.
3. `AnimationSuggester` строит 3–5 **различающихся** кандидатов постановки только из зарегистрированного presentation vocabulary.
4. UI показывает кандидаты карточками с коротким объяснением: что двигается, в каком порядке, общая длительность и характер постановки.
5. Наведение/клик запускает безопасный preview на копии frame; gameplay callbacks не вызываются.
6. Автор выбирает вариант целиком либо применяет его как основу и вручную правит шаги.
7. Выбранный кандидат проходит ту же schema/semantic validation, что ручной `PresentationPlan`, и только после этого сохраняется в draft.

## Варианты по умолчанию

Нужно стремиться не к четырём почти одинаковым fade-вариантам, а к разной режиссуре. Минимальный набор профилей:

- `subtle` — короткие fade/crossfade, минимум движения;
- `cinematic` — последовательный reveal, движение героя/предмета, акцент на реплике;
- `dynamic` — допустимый parallel, slide/move, более быстрый темп;
- `dramatic` — пауза/затемнение/выделение ключевого объекта или реплики;
- `minimal` — почти мгновенный переход, полезен для reduced-motion и информационных сцен.

Профиль не является новым runtime-командным языком. Он лишь помогает выбрать значения и структуру уже разрешённых команд.

## Архитектура

```text
Author prompt / scene diff
        ↓
SuggestionContext Builder
        ↓
AnimationSuggester
   ├─ deterministic recipes
   └─ optional AI proposer
        ↓
PresentationPlan candidates
        ↓
PresentationPlan Validator
        ↓
Preview sandbox
        ↓
Author selects candidate
        ↓
Draft stores ordinary PresentationPlan
```

### `SuggestionContext`

Минимально содержит:

- `fromFrame` и целевой `SceneFrame` либо структурированный diff;
- ID разрешённых actors/items/background/dialogue/audio/overlay;
- зарегистрированные presentation commands;
- зарегистрированные transition/reveal presets;
- duration bounds;
- theme/tone metadata сцены, если автор их задал;
- `prefersReducedMotion`/author preview mode как constraint;
- optional author prompt.

Не передавать suggester секреты, raw storage records, hidden world facts или произвольные DOM/CSS возможности.

### `AnimationSuggestion`

Кандидат должен иметь как минимум:

- stable candidate ID;
- label/short rationale;
- estimated total duration;
- generated `PresentationPlan`;
- provenance: `recipe` либо `model` + model/provider metadata для authoring trace;
- validation result/warnings.

## Два уровня автоматизации

### 1. Deterministic first

До подключения LLM Studio умеет строить варианты по scene diff:

- новый actor → `actor.show` / `actor.move`;
- исчез actor → `actor.hide`;
- новый item → `item.show`;
- background changed → `background.set` + crossfade;
- новая реплика → `dialogue.show`;
- несколько независимых изменений → предложить sequential и bounded parallel варианты.

Это даёт бесплатный, быстрый и полностью воспроизводимый baseline.

### 2. Optional AI proposer

ИИ получает только bounded `SuggestionContext` и должен вернуть несколько структурированных кандидатов. Он **не может**:

- создавать неизвестные command types;
- ссылаться на отсутствующие asset/entity IDs;
- вставлять CSS, JS, DOM selectors или callbacks;
- менять `WorldState`;
- придумывать новые gameplay events/facts;
- завершать plan другим `SceneFrame`, чем заданная целевая сцена.

Любой AI candidate считается недоверенным предложением до schema + semantic validation. Невалидный кандидат отклоняется; Studio продолжает работать на deterministic recipes.

## UX

После промпта/изменения сцены показывать блок **«Предложить анимацию»**. По нажатию — 3–5 карточек, например:

- «Спокойно» — фон crossfade, герой fade, затем реплика;
- «Кинематографично» — герой входит слева, предмет появляется параллельно, затем typewriter;
- «Динамично» — быстрый slide героя и предмета одновременно;
- «Драматично» — короткая пауза, reveal ключевого объекта, затем реплика;
- «Без лишнего движения» — минимальный переход.

На карточке: Preview / Apply / Apply & edit.

После Apply пользователь получает обычный список шагов из SPECIFICATION §10.4. Никакого отдельного «магического» формата после выбора не остаётся.

## Safety / accessibility invariants

- `prefers-reduced-motion` всегда может заменить предложенный plan безопасной минимальной версией.
- Preview не изменяет draft до `Apply`.
- Preview не отправляет gameplay action и не двигает game clock.
- Skip всегда приводит к тому же конечному `SceneFrame`.
- Дубликат turn не должен повторно запускать выбранную постановку.
- Ограничить total duration, node count, nesting depth и parallel width.
- Audio autoplay подчиняется существующей user-interaction policy.

## Acceptance criteria

1. Из одного и того же scene diff deterministic mode выдаёт стабильный набор кандидатов.
2. Минимум три кандидата отличаются структурой/темпом, а не только числом миллисекунд.
3. Каждый candidate либо проходит обычный `PresentationPlan` validator, либо показывается как invalid и не может быть применён.
4. AI candidate с неизвестным actor/command/asset отклоняется.
5. Apply сохраняет обычный `PresentationPlan`, который можно затем редактировать вручную.
6. Preview не меняет draft/game state.
7. Reduced-motion fallback заканчивается тем же целевым `SceneFrame`.
8. При недоступном AI deterministic suggestions продолжают работать.
9. Для одной тестовой сцены есть snapshot/regression на все базовые профили.
10. Автор может выключить автопредложения для проекта/сцены.

## Scope boundary

Не реализовывать эту карточку внутри B04 Runtime HTTP. Она относится к Studio/Presentation work после принятия B04. B04 может только сохранить это как будущую авторскую возможность.

На первом проходе не нужны timeline editor, keyframes, arbitrary easing curves, physics animation, video generation или произвольный user script. Сначала доказать bounded suggestion → preview → apply workflow на существующем `PresentationPlan` contract.
