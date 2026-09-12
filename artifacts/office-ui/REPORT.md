# OFFICE-UI: приведение Studio к стандартам office-web-ui-system

Ветка: `feat/studio-office-ui` (в worktree `C:/Users/kato55/lhc-design-sync`, база `feat/design-sync-site` @ b96738f).

## Что сделано

### 1. Архетипы экранов (по page-type-playbook)

| Экран | Архетип | Визуальный вес | Регионы (иерархия) |
|---|---|---|---|
| Экран проектов (projects) | CRUD/list | restrained | topbar → заголовок+контекст (`.projects-head`) → action-bar («Новый проект», 48px) → filter-row (поиск+фильтр приёмочных, `.lhp-toolbar.filter-row`) → данные (карточки `.lhp-card`) |
| Редактор миссии (editor/board) | workspace/detail | restrained | topbar (хлебные крошки → статус сохранения → главное действие «Проверить и сыграть» 48px) → sidebar (библиотека миссий) → main (доска/список/сюжет) → panel (инспектор) |
| Панель материалов (materials) | CRUD/list | restrained | заголовок панели → status → upload form → assigned → список материалов (действия в карточках) |
| Панель публикации (publish) | form/wizard | restrained | заголовок → status (роль stage) → проверки → action-bar (главное действие + recheck) → результат/отзыв |
| Настройки проекта и доступа (settings) | form | restrained | заголовок → объяснение прав → access-форма → technical details (details) |
| Панель ИИ-помощника (ai) | form (в панели инспектора) | restrained | вкладка (aria-label) → lead → форма/статус/действия; БЕЗ собственного заголовка |

Иерархия заголовок→действия→фильтры→данные выстроена; данные остаются доминирующим регионом.

### 2. Семантические классы-локаторы (locator-class-contract)

Существующие имена не переименовывались — семантические классы добавлены рядом:

- `layout-shell` — корневая оболочка (`.studio-shell`, `.ed-shell`)
- `layout-topbar` — верхние панели (`.projects-topbar`, `.ed-topbar`, анонимный `.topbar`)
- `layout-topbar-brand` / `layout-topbar-actions` — бренд и кластер действий в topbar
- `layout-sidebar` — библиотека миссий / вход (`.ed-library`, `.sidebar`)
- `layout-main` — рабочая область (`.workspace`, `.ed-main`)
- `layout-panel` — панели и диалоги (`.ed-inspector`, `.ed-utility-panel`, `.modal`, `.publish-panel`, `.projects-empty`)
- `filter-row` — строка поиска/фильтров (`.lhp-toolbar`)
- `action-bar` — кластеры действий (`.projects-head-actions`, `.publish-actions`)
- `ai-panel-flat` — плоская структура вкладки ИИ-помощника
- `data-utility-panel="<имя>"` — какая утилитарная панель открыта
- `data-library="projects"` — корень списка проектов

Новый лист `styles/office-ui.css` подключён в `index.html` (правила `.ed-utility-head`, `.ai-panel-flat`, `.materials-panel > h3`); в `styles/library.css` добавлено правило `.filter-row`; в `styles/materials.css` — защита метки «Назначение» от разрыва внутри слова.

### 3. Исправление «вкладка во вкладке» (панель ИИ)

Было: вкладка инспектора «ИИ-помощник» рисовала свой заголовок `<h2>`, внутри неё панель `ai-panel` рисовала второй `<h2>` — двойной заголовок, вкладка внутри вкладки.

Стало (плоская структура верхнего уровня):
- вкладка инспектора: `<section class="inspector-section ai-panel-flat" aria-label="ИИ-помощник">` — aria-имя вместо заголовка;
- панель: `<section class="ai-panel" data-ai-panel role="region" aria-label="ИИ-помощник">` без `<h2>` и без header-блока (убран и lead-дубль — осталась одна подводка);
- проверено скриншотами: между таб-строкой и контентом ровно один заголовочный уровень.

Аналогично убран внутренний `<h3>«Библиотека материалов»</h3>` панели материалов (дубль её aria-label).

### 4. Единый механизм закрытия оверлеев

В конструкторе StudioApp один document-level обработчик Escape (`document` под.guard'ан на `addEventListener` — тестовые заглушки совместимы): закрывает верхний открытый слой — модалку проекта → модалку карточки → утилитарную панель, по одному слою за нажатие; кнопка «Закрыть»/«Отмена» осталась в каждой панели. Проверено в браузере: Escape закрывает «Материалы» (`closed: true` в metrics.json).

### 5. Темы и плотность

- Тёмная «Петроград» и светлая «Флоренция» через `data-theme` не менялись (токены — source of truth); проверены скриншотами на 1600px и 1280px в обеих темах.
- Горизонтального переполнения нет: `docScrollWidth == viewport` на всех 14 замерах.
- Контролы 40px / главное действие 48px сохранены; в action-bar экрана проектов главное действие явно 48px.

## Проверки

- `npm run typecheck` — зелёный.
- `npm run test:studio` — 535 pass / 0 fail (включая ui-guards; новый тест `office-ui-locators.test.mjs` — 8 проверок).
- `node scripts/office-ui-acceptance.local.mjs` — 14 скриншотов (4 экрана × 2 темы × 2 ширины), 0 ошибок консоли, Escape-закрытие, отсутствие переполнений: `artifacts/office-ui/metrics.json`, `artifacts/office-ui/shots/*.png`.
- Сканер локаторов `scan_ui_locators.py` (с расширенным списком расширений .ts): до — 81 класс в src / 72 в html+css, ключевые `layout-*`, `filter-row`, `action-bar`, `ai-panel-flat` отсутствовали; после — 90/76, все ключевые локаторы присутствуют. JSON: `artifacts/office-ui/scan-before-*.json`, `scan-after-*.json`.

## Файлы

Изменены: `apps/studio/src/app.ts`, `ai-panel.ts`, `library-view.ts`, `materials-panel.ts`, `publish-panel.ts`, `apps/studio/styles.css`, `styles/library.css`, `styles/materials.css`, `apps/studio/index.html`, `apps/studio/test/v01-shell-projects.test.mjs` (регулярка `class="modal"` допускает семантический суффикс — маркер диалога не удалён).
Добавлены: `apps/studio/styles/office-ui.css`, `apps/studio/test/office-ui-locators.test.mjs`, `scripts/office-ui-acceptance.local.mjs` (вне тестового прогона), этот отчёт.
