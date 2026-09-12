# Зона «тур из редактора + кнопка Помощь»: своё доказательство

Работа делалась в отдельном worktree `C:/Users/kato55/lhc-tour-help`
(ветка `fix/tour-and-help`, от `9988323`). Исходный репозиторий не менялся.

## Что починено

1. **Тур из редактора.** Кнопка `data-action="start-tour"` (её же использует
   авто-тур) клала разметку шага в `state.message`, а статусная строка рендерит
   сообщение через `escapeHtml` — в DOM не появлялось ни одного
   `[data-tour-step]`, автор видел экранированный HTML. Кнопки
   `tour-next` / `tour-back` / `tour-skip` обрабатывались в `app.ts`, но их
   никто не рендерил, а `tour-back` вообще не был обработан.
   Теперь шаг тура рендерится в интерфейсе отдельным элементом
   (`renderOnboardingTourCard` → `renderOnboardingTourStep(step, navigation)`)
   с настоящими кнопками перехода; статусная строка получает только текст.

2. **Кнопка «Помощь».** Обработчик `help-projects` писал строку в состояние.
   Теперь он вызывает `openStudioHelp()` из модуля `onboarding.ts` и открывает
   **существующий** диалог справки Studio (`.lh-help-dialog`, `#studio-help-trigger`);
   второй диалог не создаётся. Модуль `onboarding.ts` отдаёт наружу
   `openStudioHelp()` / `closeStudioHelp()` и снимает запись при `dispose`.

## Стенд

- Studio `http://127.0.0.1:4217`, Control `http://127.0.0.1:8927`, CDP `9393`
  (копия базы `stand.sqlite` — реальные Florence-проекты; материалы —
  `C:/Users/kato55/lhc-stand-preview/data/assets`).
- Драйвер: `browser-proof.mjs` (свой headless Chrome на CDP 9393, свой профиль).
  Результат: `browser-proof.json`, скриншоты в `shots/`.

## Файлы доказательств

- `browser-proof.json` — список проверок (все `ok: true`), ошибок консоли нет.
- `shots/tour-dark-1600x1000.png`, `shots/tour-light-1600x1000.png` — шаг тура
  (кнопки Пропустить / Назад / Далее) в тёмной и светлой темах.
- `shots/help-dark-1600x1000.png`, `shots/help-light-1600x1000.png` — открытый
  диалог «Справка Studio» в тёмной и светлой темах.
- `studio.log` — лог стенда, `verify-all.log` — полный прогон `verify-all.mjs`.

## Известная граница (вне зоны этой работы)

Инструмент `scripts/ui-visual-acceptance.mjs` ищет дефект по старому признаку:
экран `tour` помечен маркером «в статусной строке есть текст `lh-tour-step`».
После исправления шаг тура рендерится настоящим элементом, поэтому этот маркер
(намеренно ловивший именно дефект) нужно обновить владельцу инструмента —
например, на `document.querySelector("[data-tour-step]") !== null`.
