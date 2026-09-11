// Живой приёмочный прогон новой миссии в Studio через CDP (FIN-05/FIN-11).
//
// Управляемый сценарий на headless Chrome по Chrome DevTools Protocol: проходит
// главный авторский маршрут и проверяет его ровно там, где его видит автор —
// в DOM Studio и в публичном каталоге Control.
//
//   node scripts/live-acceptance/new-mission-journey.mjs \
//     --studio-url http://127.0.0.1:4185 --control-url http://127.0.0.1:8788
//
// Маршрут (каждое действие — шаг с ожиданием и записью результата):
//   S0 CDP-транспорт → S1 открыть Studio → S2 создать проект → S3 создать миссию →
//   S4 открыть доску → S5 добавить узлы → S6 связать узлы → S7 открыть доску сюжета →
//   S8 добавить сцену и финал → S9 два выбора → S10 экраны → S11 материалы →
//   S12 проверка → S13 публикация → S14 проверки в каталоге сайта.
//
// EXIT CODES
//   0 — каждый шаг реально выполнен, дождался своего условия и записал результат ok:true;
//   1 — любой провал шага, пустой прогон (ни одного шага) или фатальная ошибка;
//   2 — режим --plan (печатает план, ничего не проверяет: невыполненный прогон — не успех).
// Код выхода считается ТОЛЬКО по фактическим результатам (computeExitCode), как в
// scripts/l07-cdp.mjs: шаг без ожидания или без записи результата считается провалом.
//
// ГРАНИЦЫ. Скрипт ходит только на loopback-адреса, переданные через CLI: чужой
// VPS/прод/gate, чужие сессии, учётные данные и доступы не используются, словом,
// вход в чужие аккаунты и секреты в коде отсутствуют (см. тест
// apps/server/test/live-acceptance-journey.test.mjs).
// Chrome может отсутствовать: тогда шаги честно помечаются «не выполнено» с
// причиной, а результаты не выдумываются.
//
// ЖУРНАЛ НЕУДОБСТВ: расхождения между ожидаемым и наблюдаемым печатаются в
// stdout и пишутся в docs/worklog/live-acceptance-<дата>.md (генерируемый файл).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

export const DEFAULT_STUDIO_URL = "http://127.0.0.1:4185";
export const DEFAULT_CONTROL_URL = "http://127.0.0.1:8788";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9339";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_PLAN_ONLY = 2;

export const OFFLINE_REASON = "не выполнено: браузер/CDP недоступен — результат не выдумывается";

// Хосты, к которым скрипту разрешено обращаться. Всё остальное (VPS, прод, gate,
// любые внешние сервисы) — запрещённая цель, и это проверяется до первого запроса.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopback(rawUrl, label) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error(`${label}: не URL: ${String(rawUrl)}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label}: разрешён только loopback-адрес (127.0.0.1/localhost), получено '${host}'`);
  }
  return url;
}

// --- код возврата (чистая функция, как computeExitCode в l07-cdp.mjs) ---------

// Прогон успешен, только если КАЖДЫЙ записанный шаг явно ok:true. Пустой список
// шагов — не успех: ничего не проверено.
export function computeExitCode(results) {
  if (!Array.isArray(results) || results.length === 0) return EXIT_FAILED;
  return results.every((entry) => entry && entry.ok === true) ? EXIT_OK : EXIT_FAILED;
}

export function summarize(results) {
  const counts = { ok: 0, failed: 0 };
  for (const entry of results) {
    if (entry && entry.ok === true) counts.ok += 1;
    else counts.failed += 1;
  }
  return { total: results.length, ...counts };
}

// --- фазы маршрута -----------------------------------------------------------

export const PHASES = Object.freeze([
  Object.freeze({ id: "transport", title: "CDP-транспорт" }),
  Object.freeze({ id: "studio", title: "Открыть Studio" }),
  Object.freeze({ id: "project", title: "Создать проект" }),
  Object.freeze({ id: "mission", title: "Создать миссию" }),
  Object.freeze({ id: "board", title: "Открыть доску" }),
  Object.freeze({ id: "nodes", title: "Добавить узлы и связь" }),
  Object.freeze({ id: "story", title: "Два выбора и два финала" }),
  Object.freeze({ id: "screens", title: "Экраны" }),
  Object.freeze({ id: "materials", title: "Материалы" }),
  Object.freeze({ id: "validation", title: "Проверка" }),
  Object.freeze({ id: "publication", title: "Публикация" }),
  Object.freeze({ id: "catalog", title: "Проверки в каталоге сайта" })
]);

export function phaseTitle(id) {
  return PHASES.find((phase) => phase.id === id)?.title ?? id;
}

// --- журнал неудобств: известные расхождения (из чтения кода Studio) ---------
// Эти пункты — факты исходников, они не выдаются за результат живого прогона и
// помечены отдельным разделом в journal-файле.

export const KNOWN_INCONVENIENCES = Object.freeze([
  Object.freeze({
    title: "Доска и доска сюжета не имеют data-action на узлах и рёбрах",
    detail:
      "Карточки и связи ищутся по классу и атрибуту ('.board-node[data-node-id]', '.board-edge[data-edge-id]', "
      + "'.story-node[data-node-id]', '.story-edge[data-edge-id]'); кнопки «Связать» и «Вписать всё» — вообще только по тексту "
      + "(story-dom.ts создаёт их без data-action). Сценарий вынужден искать кнопки по textContent, а не по стабильному контракту.",
    source: "код: apps/studio/src/board-dom.ts, apps/studio/src/story-dom.ts"
  }),
  Object.freeze({
    title: "Связь на доске не создаётся кликом: нужен синтез PointerEvent",
    detail:
      "board-dom.ts слушает 'pointerdown' на вьюпорте, а 'pointermove'/'pointerup' — на карточке-источнике; цель определяется "
      + "через document.elementFromPoint(clientX, clientY). Инструмент click из scripts/l07-cdp.mjs (element.click()) здесь "
      + "неприменим: дисплей-клик не порождает pointerdown, пришлось синтезировать PointerEvent и отправлять pointerup на источник.",
    source: "код: apps/studio/src/board-dom.ts (onPointerDown/startConnectDrag/capturePointer)"
  }),
  Object.freeze({
    title: "Связь на доске сюжета — трёхшаговый режим",
    detail:
      "Сначала включается режим «Связать», затем клик по сцене-источнику, затем по цели, и только потом Studio открывает диалог "
      + "с подписью выбора. Один «шаг связи» в UI — это три действия плюс модальная форма; в сценарии разложено на подшаги.",
    source: "код: apps/studio/src/app.ts (hint «Связать»), story-dom.ts (connectMode)"
  }),
  Object.freeze({
    title: "Форма запуска выпуска появляется только после valid-проверки",
    detail:
      "renderReleaseBuildForm возвращает подсказку вместо формы, пока нет valid validation точно текущей revision и content hash. "
      + "Шаг публикации обязан сначала дождаться проверки; «просто нажать Опубликовать» после правок нельзя.",
    source: "код: apps/studio/src/versions.ts (renderReleaseBuildForm), apps/studio/src/app.ts (prepareReleaseBuild)"
  }),
  Object.freeze({
    title: "Форма добавления слоя спрятана в закрытом <details>",
    detail:
      "Композиция слоя ('data-form=\"screen-layer-add\"') лежит внутри <details class=\"screen-layer-add\">; в закрытом details "
      + "элементы не отрисовываются, поэтому перед заполнением сценарий обязан раскрыть details — иначе клик/ввод промахивается.",
    source: "код: apps/studio/src/app.ts (renderScreenEditor)"
  }),
  Object.freeze({
    title: "Настоящий asset для фона требует assetId И sha256 из 64 hex",
    detail:
      "Фон/музыка/слой принимаются только парой (assetId, hash), а слой без asset допустим. Живой фон требует реальной библиотеки "
      + "материалов, которой в срезе FIN-05 нет, поэтому шаг «экраны» правит документированный inheritBackground, а «материалы» "
      + "добавляют текстовый слой без asset — без подделки хешей.",
    source: "код: apps/studio/src/app.ts (renderScreenEditor), apps/studio/src/screen-model.ts"
  }),
  Object.freeze({
    title: "Публичный каталог недоступен через origin Studio",
    detail:
      "Studio-прокси обслуживает только '/control/*'; '/public/v1/missions' через него отдаёт 404 (serveStatic). Проверка каталога "
      + "сайта поэтому идёт вторым, отдельным CLI-адресом Control — иначе шаг «каталог» недостижим из браузерной сессии Studio.",
    source: "код: apps/studio/src/dev-server.ts (serveStatic/proxyControl)"
  }),
  Object.freeze({
    title: "Сид миссии уже содержит выбор и финал",
    detail:
      "createMission создаёт вход → выбор «Завершить» → финал. Буквальные «два выбора и два финала» недостижимы без удаления "
      + "сид-выбора, поэтому после двух добавленных связей в сюжете фактически три выбора и два финала; расхождение фиксируется, "
      + "а не подгоняется.",
    source: "код: apps/studio/src/app.ts (createMission)"
  })
]);

// --- параметры CLI -----------------------------------------------------------

export function parseArgs(argv = []) {
  const options = {
    studioUrl: DEFAULT_STUDIO_URL,
    controlUrl: DEFAULT_CONTROL_URL,
    cdpEndpoint: DEFAULT_CDP_ENDPOINT,
    chromePath: null,
    userDataDir: null,
    plan: false,
    json: false,
    noJournal: false,
    date: null,
    worklogPath: null,
    viewport: { width: 1440, height: 900 }
  };
  const valueOf = (arg, next) => {
    if (next === undefined || next.startsWith("--")) throw new Error(`${arg}: требуется значение`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--studio-url") options.studioUrl = valueOf(arg, argv[++index]);
    else if (arg === "--control-url") options.controlUrl = valueOf(arg, argv[++index]);
    else if (arg === "--cdp-endpoint") options.cdpEndpoint = valueOf(arg, argv[++index]);
    else if (arg === "--chrome") options.chromePath = valueOf(arg, argv[++index]);
    else if (arg === "--user-data-dir") options.userDataDir = valueOf(arg, argv[++index]);
    else if (arg === "--worklog") options.worklogPath = valueOf(arg, argv[++index]);
    else if (arg === "--date") options.date = valueOf(arg, argv[++index]);
    else if (arg === "--plan") options.plan = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-journal") options.noJournal = true;
    else if (arg === "--width") options.viewport.width = Number(valueOf(arg, argv[++index]));
    else if (arg === "--height") options.viewport.height = Number(valueOf(arg, argv[++index]));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`неизвестный аргумент '${arg}' — см. --help`);
  }
  // Адреса не могут быть чему-то «навязаны» снаружи: только loopback из CLI.
  assertLoopback(options.studioUrl, "--studio-url");
  assertLoopback(options.controlUrl, "--control-url");
  assertLoopback(options.cdpEndpoint, "--cdp-endpoint");
  if (options.help) return options;
  if (options.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("--date: ожидается YYYY-MM-DD");
  }
  if (!Number.isFinite(options.viewport.width) || !Number.isFinite(options.viewport.height)) {
    throw new Error("--width/--height: ожидаются числа");
  }
  return options;
}

export function usageText() {
  return [
    "usage: node scripts/live-acceptance/new-mission-journey.mjs [options]",
    "",
    "  --studio-url <url>     адрес Studio (по умолчанию http://127.0.0.1:4185)",
    "  --control-url <url>    адрес Control для проверок каталога (http://127.0.0.1:8788)",
    "  --cdp-endpoint <url>   endpoint DevTools работающего Chrome (http://127.0.0.1:9339)",
    "  --chrome <path>        запустить headless Chrome этим бинарём, если CDP не отвечает",
    "  --user-data-dir <dir>  профиль Chrome для запуска (по умолчанию временный каталог)",
    "  --width/--height <n>   размер окна (по умолчанию 1440x900)",
    "  --plan                 напечатать план шагов и выйти с кодом 2 (ничего не проверено)",
    "  --date <YYYY-MM-DD>    дата для имени журнала (по умолчанию — сегодняшняя)",
    "  --worklog <path>       путь journal-файла (по умолчанию docs/worklog/live-acceptance-<дата>.md)",
    "  --no-journal           не писать journal-файл (журнал всё равно печатается)",
    "  --json                 напечатать машинный отчёт прогона",
    "",
    "Скрипт не берёт адреса и учётные данные из окружения: только CLI, только loopback."
  ].join("\n");
}

// --- шаги -------------------------------------------------------------------

// Шаг = { id, phase, title, waitsFor, run(api, state) }.
// Шаг считается выполненным (ok:true) только если: run() не бросил, каждый
// expect() прошёл, был хотя бы один waitFor* (ожидание) и хотя бы один expect
// (запись результата). Это и есть «шаг с ожиданием и записью результата».
export const JOURNEY_STEPS = Object.freeze([
  Object.freeze({
    id: "S0",
    phase: "transport",
    title: "CDP-транспорт к Chrome установлен",
    waitsFor: "успешное подключение к /json/version и Runtime.enable",
    async run(api, state) {
      const version = await api.waitForExpr("navigator.userAgent", {
        label: "CDP отвечает на Runtime.evaluate",
        predicate: (value) => typeof value === "string" && value.length > 0
      });
      api.expect(typeof version === "string" && version.length > 0, "CDP не вернул userAgent — транспорт не поднят");
      api.record("userAgent", String(version));
      await api.driver.deviceMetrics(state.viewport.width, state.viewport.height);
      state.userAgent = String(version);
    }
  }),
  Object.freeze({
    id: "S1",
    phase: "studio",
    title: "Studio открывается и рисует экран проектов",
    waitsFor: ".projects-screen или .ed-shell в #app (boot-заглушка уходит)",
    async run(api, state) {
      await api.driver.navigate(`${state.studioUrl}/`);
      await api.waitForSelector("#app .projects-screen, #app .ed-shell", { label: "Studio отрисовала рабочий экран" });
      const anonymous = await api.evaluate("Boolean(document.querySelector('form[data-form=\"login\"]'))");
      api.record("anonymous", anonymous === true);
      api.expect(anonymous !== true, "Studio требует вход: контроль доступа анонимный, маршрут недостижим без чужих учётных данных");
      const boot = await api.evaluate("document.querySelector('#app').textContent.includes('Загружаем Living History Studio')");
      api.record("bootPlaceholder", boot === true);
      state.studioOpened = true;
    }
  }),
  Object.freeze({
    id: "S2",
    phase: "project",
    title: "Проект создаётся из формы «Новый проект»",
    waitsFor: "форма data-form=\"project-new\" → редактор .ed-shell с названием проекта",
    async run(api, state) {
      await api.click("[data-action=\"new-project\"]");
      await api.waitForSelector("form[data-form=\"project-new\"]", { label: "модалка нового проекта" });
      await api.fill("form[data-form=\"project-new\"] input[name=\"title\"]", state.projectTitle);
      await api.submit("form[data-form=\"project-new\"]");
      await api.waitForSelector(".ed-shell", { label: "редактор проекта открылся после создания" });
      const named = await api.evaluate(`[...document.querySelectorAll('.crumbs span, .rail-item strong, .project-card strong')].some((el) => el.textContent.includes(${JSON.stringify(state.projectTitle)}))`);
      api.expect(named === true, `созданный проект «${state.projectTitle}» не найден на экране после создания`);
      api.record("projectTitle", state.projectTitle);
    }
  }),
  Object.freeze({
    id: "S3",
    phase: "mission",
    title: "Миссия создаётся в библиотеке проекта",
    waitsFor: "карточка миссии в .rail-list и заголовок .draft-header h1",
    async run(api, state) {
      await api.waitForSelector("form[data-form=\"quest\"]", { label: "форма «Новая миссия» в библиотеке" });
      await api.fill("form[data-form=\"quest\"] input[name=\"title\"]", state.missionTitle);
      await api.submit("form[data-form=\"quest\"]");
      const missions = await api.waitForCount("[data-action=\"select-quest\"]", { min: 1, label: "миссия появилась в библиотеке" });
      await api.waitForSelector(".draft-header h1", { label: "заголовок черновика отрисован" });
      const title = await api.textOf(".draft-header h1");
      api.record("missionsInLibrary", missions);
      api.record("draftTitle", title);
      api.expect(title === state.missionTitle, `заголовок черновика '${title}' не совпал с введённым '${state.missionTitle}'`);
      state.missionCreated = true;
    }
  }),
  Object.freeze({
    id: "S4",
    phase: "board",
    title: "Доска миссии открывается",
    waitsFor: "переключатель вида «Доска» и карточка входа .board-host .board-node",
    async run(api, state) {
      await api.click("[data-action=\"board-view\"][data-view=\"board\"]");
      await api.waitForSelector(".board-host", { label: "хост доски отрисован" });
      const cards = await api.waitForCount(".board-host .board-node", { min: 1, label: "карточка входа «start» на доске" });
      api.expect(cards >= 1, `на доске нет ни одной карточки (получено ${cards})`);
      api.record("cardsBefore", cards);
      state.cardsBefore = cards;
    }
  }),
  Object.freeze({
    id: "S5",
    phase: "nodes",
    title: "На доске добавляются узлы: персонаж, ресурс, действие",
    waitsFor: "три карточки в .board-host .board-node после трёх модалок data-form=\"block-add\"",
    async run(api, state) {
      const add = async (kind, title) => {
        await api.click(`[data-action="add-block"][data-block-kind="${kind}"]`);
        await api.waitForSelector(`form[data-form="block-add"][data-block-kind="${kind}"]`, { label: `модалка добавления «${kind}»` });
        await api.fill(`form[data-form="block-add"][data-block-kind="${kind}"] input[name="title"]`, title);
        await api.submit(`form[data-form="block-add"][data-block-kind="${kind}"]`);
        await api.waitForSelector(`form[data-form="block-add"][data-block-kind="${kind}"]`, { label: `модалка «${kind}» закрылась`, gone: true });
      };
      await add("character", "Наблюдатель");
      await add("resource", "Краска");
      await add("action", "Рисовать");
      const cards = await api.waitForCount(".board-host .board-node", { min: state.cardsBefore + 3, label: "карточки персонажа, ресурса и действия" });
      api.expect(cards >= state.cardsBefore + 3, `на доске не стало на три карточки больше (${state.cardsBefore} → ${cards})`);
      api.record("cardsAfter", cards);
      state.cardsAfter = cards;
    }
  }),
  Object.freeze({
    id: "S6",
    phase: "nodes",
    title: "Узлы связываются: персонаж→место и действие→ресурс",
    waitsFor: "два ребра .board-edge[data-edge-id] на доске",
    async run(api, state) {
      const drag = async (fromSelector, toSelector, label) => {
        const started = await api.dragSourceToTarget(fromSelector, toSelector);
        api.expect(started === true, `перетаскивание связи «${label}» не началось: не найдены порт или цель`);
        await api.sleep(250);
      };
      const character = await api.cardIdByKind("character");
      const action = await api.cardIdByKind("action");
      const location = await api.cardIdByKind("location");
      const resource = await api.cardIdByKind("resource");
      api.expect(character !== null && action !== null && location !== null && resource !== null, "не найдены карточки для связи (character/action/location/resource)");
      await drag(`.board-node[data-node-id="${character}"] .board-port--out`, `.board-node[data-node-id="${location}"]`, "character→location");
      await drag(`.board-node[data-node-id="${action}"] .board-port--out`, `.board-node[data-node-id="${resource}"]`, "action→resource");
      const edges = await api.waitForCount(".board-edge[data-edge-id], [data-edge-id]", { min: 2, label: "две связи на доске" });
      api.record("edges", edges);
      api.note("связь доски", "Связь создана только синтезом PointerEvent (pointerdown → pointermove ×2 → pointerup на источнике) с попаданием в цель по elementFromPoint; element.click() связь не создаёт.");
      state.edges = edges;
    }
  }),
  Object.freeze({
    id: "S7",
    phase: "story",
    title: "Доска сюжета открывается, документ миссии создаётся",
    waitsFor: ".story-panel и хотя бы один .story-node (сид: вход + финал)",
    async run(api, state) {
      await api.click("[data-action=\"board-view\"][data-view=\"story\"]");
      await api.waitForSelector(".story-panel", { label: "панель сюжета отрисована" });
      const seedForm = await api.exists("form[data-form=\"story-mission-create\"]");
      api.record("storySeedForm", seedForm === true);
      if (seedForm === true) {
        await api.fill("form[data-form=\"story-mission-create\"] input[name=\"title\"]", state.missionTitle);
        await api.submit("form[data-form=\"story-mission-create\"]");
      }
      const scenes = await api.waitForCount(".story-node-scene", { min: 1, label: "входная сцена в сюжете" });
      const endings = await api.waitForCount(".story-node-ending", { min: 1, label: "сид-финал в сюжете" });
      api.expect(scenes >= 1 && endings >= 1, `в сюжете нет базовых узлов (сцен ${scenes}, финалов ${endings})`);
      api.record("seedScenes", scenes);
      api.record("seedEndings", endings);
      state.sceneCount = scenes;
      state.endingCount = endings;
    }
  }),
  Object.freeze({
    id: "S8",
    phase: "story",
    title: "Добавляются сцена и второй финал",
    waitsFor: ".story-node-scene ≥ 2 и .story-node-ending ≥ 2",
    async run(api, state) {
      const addNode = async (kind, title) => {
        await api.click(`[data-action="story-add"][data-kind="${kind}"]`);
        await api.waitForSelector(`form[data-form="story-node-create"][data-kind="${kind}"]`, { label: `диалог нового узла «${kind}»` });
        await api.fill(`form[data-form="story-node-create"][data-kind="${kind}"] input[name="title"]`, title);
        await api.submit(`form[data-form="story-node-create"][data-kind="${kind}"]`);
        await api.waitForSelector(`form[data-form="story-node-create"][data-kind="${kind}"]`, { label: `диалог «${kind}» закрылся`, gone: true });
      };
      await addNode("scene", "Сцена Б");
      await addNode("ending", "Финал Б");
      const scenes = await api.waitForCount(".story-node-scene", { min: state.sceneCount + 1, label: "вторая сцена на доске сюжета" });
      const endings = await api.waitForCount(".story-node-ending", { min: state.endingCount + 1, label: "второй финал на доске сюжета" });
      api.expect(scenes >= state.sceneCount + 1 && endings >= state.endingCount + 1, `сюжет не получил новые узлы (сцен ${state.sceneCount} → ${scenes}, финалов ${state.endingCount} → ${endings})`);
      api.record("scenes", scenes);
      api.record("endings", endings);
      state.sceneCount = scenes;
      state.endingCount = endings;
    }
  }),
  Object.freeze({
    id: "S9",
    phase: "story",
    title: "Задаются два выбора (два решения с подписями)",
    waitsFor: "диалог data-form=\"story-choice-create\" → подпись → новое ребро .story-edge",
    async run(api, state) {
      const edgeSelector = ".story-edges [data-edge-id], [data-edge-id]";
      const before = await api.count(edgeSelector);
      const connect = async (sourceId, targetId, label) => {
        await api.clickText(".story-toolbar", "Связать");
        await api.pointerDownNode(sourceId);
        await api.pointerDownNode(targetId);
        await api.waitForSelector("form[data-form=\"story-choice-create\"]", { label: `диалог выбора для «${label}»` });
        await api.fill("form[data-form=\"story-choice-create\"] input[name=\"label\"]", label);
        await api.submit("form[data-form=\"story-choice-create\"]");
        await api.waitForSelector("form[data-form=\"story-choice-create\"]", { label: `диалог выбора «${label}» закрылся`, gone: true });
      };
      const entry = await api.storyEntryNodeId();
      const sceneIds = await api.storyNodeIds("scene");
      const endingIds = await api.storyNodeIds("ending");
      api.expect(entry !== null, "не найдена входная сцена сюжета");
      const extraScene = sceneIds.find((id) => id !== entry) ?? null;
      const lastEnding = endingIds[endingIds.length - 1] ?? null;
      api.expect(extraScene !== null && lastEnding !== null, "не найдены добавленные сцена и финал для связи");
      await connect(entry, extraScene, "На второй путь");
      await connect(entry, lastEnding, "Сразу к финалу");
      const edges = await api.waitForCount(edgeSelector, { min: before + 2, label: "два подписанных выбора на доске сюжета" });
      api.record("storyEdges", edges);
      api.note("два выбора", `Связь «Связать» требует трёх действий (режим → источник → цель) и модального диалога подписи; добавлено 2 выбора, в сюжете всего ${edges} ребра из-за сид-выбора «Завершить».`);
      state.storyEdges = edges;
    }
  }),
  Object.freeze({
    id: "S10",
    phase: "screens",
    title: "Экран узла настраивается и сохраняется",
    waitsFor: "форма data-form=\"screen-save\" и рост ревизии черновика после сохранения",
    async run(api, state) {
      const nodeId = await api.storyEntryNodeId();
      api.expect(nodeId !== null, "не найден выбранный узел сюжета для настройки экрана");
      await api.waitForSelector(`form[data-form="screen-save"][data-node-id="${nodeId}"]`, { label: "форма оформления экрана выбранного узла" });
      const revisionBefore = await api.draftRevision();
      api.expect(revisionBefore >= 0, "не удалось прочитать ревизию черновика до сохранения экрана");
      await api.setCheckbox(`form[data-form="screen-save"][data-node-id="${nodeId}"] input[name="inheritBackground"]`, true);
      await api.submit(`form[data-form="screen-save"][data-node-id="${nodeId}"]`);
      const revisionAfter = await api.waitForExpr(
        "(() => { const codes = document.querySelectorAll('.draft-meta code'); return codes.length > 1 ? Number(codes[1].textContent) : -1; })()",
        { label: `ревизия черновика выросла относительно r${revisionBefore}`, predicate: (value) => Number(value) > revisionBefore }
      );
      api.record("revisionBefore", revisionBefore);
      api.record("revisionAfter", Number(revisionAfter));
      api.expect(Number(revisionAfter) > revisionBefore, `сохранение экрана не изменило ревизию черновика (${revisionBefore} → ${revisionAfter})`);
      api.note("экраны", "Живой фон требует пары assetId+SHA-256 из реальной библиотеки материалов, поэтому шаг правит документированный inheritBackground, а не подставляет выдуманный хеш.");
      state.screenNodeId = nodeId;
    }
  }),
  Object.freeze({
    id: "S11",
    phase: "materials",
    title: "Материал (слой экрана) добавляется",
    waitsFor: "строка .screen-layer-row после формы data-form=\"screen-layer-add\"",
    async run(api, state) {
      const nodeId = state.screenNodeId;
      await api.expandDetails(".screen-layer-add");
      const form = `form[data-form="screen-layer-add"][data-node-id="${nodeId}"]`;
      await api.waitForSelector(form, { label: "форма добавления слоя раскрыта" });
      await api.fill(`${form} input[name="id"]`, "overlay-journey");
      await api.fill(`${form} input[name="name"]`, "Слой приёмки");
      await api.selectOption(`${form} select[name="kind"]`, "text");
      await api.submit(form);
      const layers = await api.waitForCount(".screen-layer-row", { min: 1, label: "слой в списке материалов экрана" });
      api.expect(layers >= 1, `слой не появился в списке материалов (получено ${layers})`);
      api.record("layers", layers);
      api.note("материалы", "Форма слоя спрятана в закрытом <details>: сценарий обязан раскрыть details до заполнения, иначе элементы не отрисованы.");
      state.layers = layers;
    }
  }),
  Object.freeze({
    id: "S12",
    phase: "validation",
    title: "Проверка черновика даёт valid",
    waitsFor: ".validation-result (валидность и отсутствие блокера выпуска)",
    async run(api, state) {
      await api.click("[data-action=\"validate\"]");
      await api.waitForSelector(".validation-result", { label: "панель результата проверки" });
      const valid = await api.waitForSelector(".validation-result.valid", { label: "проверка отметила миссию готовой" });
      const blocked = await api.exists("[data-release-blocked]");
      const message = await api.textOf(".validation-result");
      api.record("validationValid", valid === true);
      api.record("releaseBlocked", blocked === true);
      api.record("validationText", String(message).slice(0, 400));
      api.expect(blocked !== true, "проверка валидна, но выпуск собрать нельзя (data-release-blocked) — целевой маршрут «проверил → собрал → опубликовал» нарушен");
      state.validation = true;
    }
  }),
  Object.freeze({
    id: "S13",
    phase: "publication",
    title: "Выпуск собирается и публикуется",
    waitsFor: "form data-form=\"release-build\" → confirm-release-build → prepare-publish → confirm-publication → .publication-receipt",
    async run(api, state) {
      await api.click("[data-action=\"toggle-editor-menu\"]");
      await api.click("[data-action=\"open-utility-panel\"][data-panel=\"versions\"]");
      await api.waitForSelector("form[data-form=\"release-build\"]", { label: "форма release build (появляется только после valid-проверки)" });
      await api.fill("form[data-form=\"release-build\"] input[name=\"releaseId\"]", state.releaseId);
      await api.submit("form[data-form=\"release-build\"]");
      await api.click("[data-action=\"confirm-release-build\"]");
      await api.waitForSelector(`[data-action="prepare-publish"][data-release-id="${state.releaseId}"], .ed-topbar [data-action="prepare-publish"]`, { label: "точка входа публикации собранного выпуска" });
      await api.click("[data-action=\"prepare-publish\"]");
      await api.waitForSelector("[data-action=\"confirm-publication\"]", { label: "publish report с подтверждением" });
      await api.click("[data-action=\"confirm-publication\"]");
      await api.waitForSelector(".publication-receipt", { label: "server receipt публикации" });
      const receipt = await api.textOf(".publication-receipt");
      api.record("publicationReceipt", String(receipt).slice(0, 400));
      api.expect(String(receipt).includes(state.releaseId), `receipt публикации не называет выпуск ${state.releaseId}`);
      state.published = true;
    }
  }),
  Object.freeze({
    id: "S14",
    phase: "catalog",
    title: "Опубликованная миссия видна в каталоге сайта",
    waitsFor: "GET /public/v1/missions → карточка /public/v1/missions/<slug>",
    async run(api, state) {
      const catalog = await api.httpJson(`${state.controlUrl}/public/v1/missions`);
      api.expect(catalog && Array.isArray(catalog.missions), "каталог не вернул список missions");
      const entry = catalog.missions.find((mission) => mission && typeof mission.slug === "string") ?? null;
      api.expect(entry !== null, "в публичном каталоге нет ни одной миссии после публикации");
      const listing = entry;
      api.expect(typeof listing.title === "string" && listing.title.length > 0, "запись каталога не содержит title");
      api.expect(!("projectId" in listing) && !("questId" in listing), "публичная запись каталога раскрывает внутренние projectId/questId");
      const card = await api.httpJson(`${state.controlUrl}/public/v1/missions/${encodeURIComponent(listing.slug)}`);
      api.expect(card && typeof card === "object", "публичная карточка миссии не отдалась");
      api.record("catalogCount", catalog.missions.length);
      api.record("slug", listing.slug);
      api.note("каталог", `Адрес миссии на сайте (slug) нигде не показан в интерфейсе Studio: каталог пришлось проверять отдельным HTTP-запросом к Control по найденной в каталоге записи (slug '${listing.slug}').`);
      state.slug = listing.slug;
    }
  })
]);

export function renderPlanText(steps = JOURNEY_STEPS) {
  const lines = ["ПЛАН ЖИВОГО ПРОГОНА (ничего не выполнено — это не приёмка):"];
  for (const step of steps) {
    lines.push(`  ${step.id} [${phaseTitle(step.phase)}] ${step.title}`);
    lines.push(`      ждёт: ${step.waitsFor}`);
  }
  lines.push("");
  lines.push("Режим --plan всегда выходит с кодом 2: невыполненный план — не успех.");
  return lines.join("\n");
}

// --- api шага (ожидания/проверки/запись) -------------------------------------

export function createStepApi({ driver, step, notes, sleep }) {
  const stats = { waits: 0, asserts: 0, failures: [] };
  const observed = {};
  const api = {
    driver,
    sleep,
    get waits() {
      return stats.waits;
    },
    get asserts() {
      return stats.asserts;
    },
    get failures() {
      return [...stats.failures];
    },
    observed,
    expect(condition, reason) {
      stats.asserts += 1;
      if (!condition) stats.failures.push(reason);
      return condition === true;
    },
    record(key, value) {
      observed[key] = value;
      return value;
    },
    note(title, detail) {
      notes.push({ step: step.id, title, detail, source: "прогон" });
      return true;
    },
    async evaluate(expression) {
      return driver.evaluate(expression);
    },
    /** HTTP-проверка каталога: считается ожиданием ответа сервера. */
    async httpJson(url) {
      stats.waits += 1;
      return driver.fetchJson(url);
    },
    async exists(selector) {
      stats.waits += 1;
      return (await driver.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) === true;
    },
    async count(selector) {
      stats.waits += 1;
      const value = await driver.evaluate(`(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes ? nodes.length : -1; })()`);
      return Number(value);
    },
    async textOf(selector) {
      stats.waits += 1;
      const value = await driver.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : ''; })()`);
      return String(value ?? "");
    },
    async waitForSelector(selector, { label = selector, timeoutMs = 8000, pollMs = 150, gone = false } = {}) {
      stats.waits += 1;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const present = (await driver.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) === true;
        if (gone ? !present : present) return true;
        if (Date.now() > deadline) throw new Error(`не дождались (${label}): ${gone ? "элемент не исчез" : "элемент не появился"} ${selector}`);
        await sleep(pollMs);
      }
    },
    async waitForCount(selector, { min = 1, label = selector, timeoutMs = 8000, pollMs = 150 } = {}) {
      stats.waits += 1;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = Number(await driver.evaluate(`(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes ? nodes.length : -1; })()`));
        if (value >= min) return value;
        if (Date.now() > deadline) throw new Error(`не дождались (${label}): элементов ${selector} — ${value}, нужно ≥ ${min}`);
        await sleep(pollMs);
      }
    },
    async waitForText(selector, needle, { label = needle, timeoutMs = 8000, pollMs = 150 } = {}) {
      stats.waits += 1;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = String(await driver.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : ''; })()`) ?? "");
        if (text.includes(needle)) return text;
        if (Date.now() > deadline) throw new Error(`не дождались (${label}): в ${selector} нет «${needle}» (сейчас: «${text.slice(0, 120)}»)`);
        await sleep(pollMs);
      }
    },
    async waitForExpr(expression, { label = expression, predicate = (value) => Boolean(value), timeoutMs = 8000, pollMs = 150 } = {}) {
      stats.waits += 1;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await driver.evaluate(expression);
        if (predicate(value)) return value;
        if (Date.now() > deadline) throw new Error(`не дождались (${label}): условие не выполнено за ${timeoutMs} мс (значение: ${JSON.stringify(value)})`);
        await sleep(pollMs);
      }
    },
    /** Ревизия черновика из блока технических данных (.draft-meta). */
    async draftRevision() {
      stats.waits += 1;
      const value = await driver.evaluate("(() => { const codes = document.querySelectorAll('.draft-meta code'); return codes.length > 1 ? Number(codes[1].textContent) : -1; })()");
      return Number(value);
    },
    async click(selector) {
      stats.waits += 1;
      const clicked = await driver.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
      if (clicked !== true) throw new Error(`клик: элемент не найден: ${selector}`);
      return true;
    },
    async clickText(containerSelector, text) {
      stats.waits += 1;
      const clicked = await driver.evaluate(`(() => {
        const bucket = document.querySelector(${JSON.stringify(containerSelector)});
        if (!bucket) return false;
        const wanted = ${JSON.stringify(text)};
        const target = [...bucket.querySelectorAll('button')].find((el) => (el.textContent || '').trim().includes(wanted));
        if (!target) return false;
        target.click();
        return true;
      })()`);
      if (clicked !== true) throw new Error(`клик по тексту: в ${containerSelector} нет кнопки «${text}»`);
      return true;
    },
    async fill(selector, text) {
      stats.waits += 1;
      const focused = await driver.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if (typeof el.select === 'function') el.select(); return true; })()`);
      if (focused !== true) throw new Error(`fill: поле не найдено: ${selector}`);
      await driver.insertText(String(text));
      await api.sleep(50);
    },
    async selectOption(selector, value) {
      stats.waits += 1;
      const changed = await driver.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || typeof el.value !== 'string') return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (changed !== true) throw new Error(`select: элемент не найден или не select: ${selector}`);
    },
    async setCheckbox(selector, checked) {
      stats.waits += 1;
      const applied = await driver.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (el.checked !== ${checked ? "true" : "false"}) { el.click(); }
        return true;
      })()`);
      if (applied !== true) throw new Error(`checkbox: элемент не найден: ${selector}`);
    },
    async expandDetails(selector) {
      stats.waits += 1;
      const opened = await driver.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if ('open' in el) el.open = true;
        return true;
      })()`);
      if (opened !== true) throw new Error(`details: элемент не найден: ${selector}`);
    },
    async submit(selector) {
      stats.waits += 1;
      const submitted = await driver.evaluate(`(() => {
        const form = document.querySelector(${JSON.stringify(selector)});
        if (!form) return false;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      if (submitted !== true) throw new Error(`submit: форма не найдена: ${selector}`);
      await api.sleep(120);
    },
    async cardIdByKind(kind) {
      stats.waits += 1;
      const id = await driver.evaluate(`(() => { const el = document.querySelector('.board-node[data-block-kind="' + ${JSON.stringify(kind)} + '"]'); return el ? el.dataset.nodeId : null; })()`);
      return typeof id === "string" && id.length > 0 ? id : null;
    },
    async storyNodeIds(type) {
      stats.waits += 1;
      const ids = await driver.evaluate(`[...document.querySelectorAll(${JSON.stringify(`.story-node-${type}`)})].map((el) => el.dataset.nodeId).filter(Boolean)`);
      return Array.isArray(ids) ? ids : [];
    },
    async storyEntryNodeId() {
      stats.waits += 1;
      const id = await driver.evaluate(`(() => { const el = document.querySelector('.story-node.is-entry'); return el ? el.dataset.nodeId : null; })()`);
      return typeof id === "string" && id.length > 0 ? id : null;
    },
    async pointerDownNode(nodeId) {
      stats.waits += 1;
      const dispatched = await driver.evaluate(`(() => {
        const el = document.querySelector('.story-node[data-node-id="' + ${JSON.stringify(nodeId)} + '"] .story-node-title, .story-node[data-node-id="' + ${JSON.stringify(nodeId)} + '"]');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const point = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
        el.dispatchEvent(new PointerEvent('pointerdown', point));
        return true;
      })()`);
      if (dispatched !== true) throw new Error(`pointerdown: узел сюжета не найден: ${nodeId}`);
    },
    async dragSourceToTarget(fromSelector, toSelector) {
      stats.waits += 1;
      const result = await driver.evaluate(`(() => {
        const from = document.querySelector(${JSON.stringify(fromSelector)});
        const to = document.querySelector(${JSON.stringify(toSelector)});
        if (!from || !to) return false;
        const fs = from.getBoundingClientRect();
        const ts = to.getBoundingClientRect();
        const at = (x, y) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
        from.dispatchEvent(new PointerEvent('pointerdown', at(fs.left + fs.width / 2, fs.top + fs.height / 2)));
        from.dispatchEvent(new PointerEvent('pointermove', at((fs.left + ts.left) / 2, (fs.top + ts.top) / 2)));
        from.dispatchEvent(new PointerEvent('pointermove', at(ts.left + ts.width / 2, ts.top + ts.height / 2)));
        from.dispatchEvent(new PointerEvent('pointerup', at(ts.left + ts.width / 2, ts.top + ts.height / 2)));
        return true;
      })()`);
      return result === true;
    }
  };
  return api;
}

// --- прогон -----------------------------------------------------------------

// runJourney принимает ИНЖЕКТИРУЕМЫЙ драйвер. Живой драйвер говорит по CDP,
// тестовый — возвращает заданные значения; ядро маршрута от транспорта не зависит.
export async function runJourney({
  driver,
  steps = JOURNEY_STEPS,
  state = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const notes = [];
  const results = [];
  let offlineReason = null;

  if (!driver || typeof driver.evaluate !== "function") {
    offlineReason = OFFLINE_REASON;
  } else if (typeof driver.connect === "function" && driver.connected !== true) {
    try {
      await driver.connect();
    } catch (error) {
      offlineReason = `${OFFLINE_REASON} (${String(error?.message ?? error)})`;
    }
  }

  for (const step of steps) {
    if (offlineReason !== null) {
      results.push({ id: step.id, phase: step.phase, title: step.title, ok: false, reason: offlineReason, observed: {} });
      continue;
    }
    const api = createStepApi({ driver, step, notes, sleep });
    let fatal = null;
    try {
      await step.run(api, state);
    } catch (error) {
      fatal = String(error?.message ?? error);
    }
    const failures = api.failures;
    let ok = true;
    let reason = null;
    if (fatal !== null) {
      ok = false;
      reason = `исключение: ${fatal}`;
    } else if (failures.length > 0) {
      ok = false;
      reason = failures.join("; ");
    } else if (api.waits === 0) {
      ok = false;
      reason = "шаг ничего не дождался: у шага нет ожидания, результат недостоверен";
    } else if (api.asserts === 0) {
      ok = false;
      reason = "шаг ничего не записал: у шага нет проверки результата";
    }
    results.push({ id: step.id, phase: step.phase, title: step.title, ok, reason, waits: api.waits, asserts: api.asserts, observed: api.observed });
  }

  if (typeof driver?.close === "function" && offlineReason === null) {
    try {
      await driver.close();
    } catch {
      /* закрытие транспорта не влияет на вердикт */
    }
  }

  return { results, notes, consoleErrors: Array.isArray(driver?.consoleErrors) ? driver.consoleErrors : [], state, offlineReason };
}

// --- journal ----------------------------------------------------------------

export function renderJournal({
  mode,
  results,
  notes = [],
  consoleErrors = [],
  targets,
  exitCode,
  date,
  generatedAtIso,
  offlineReason = null
}) {
  const counts = summarize(results);
  const lines = [];
  lines.push("# Живой приёмочный прогон: новая миссия в Studio (FIN-05/FIN-11)");
  lines.push("");
  lines.push(`Дата: ${date}. Режим: ${mode}. Код возврата: ${exitCode}. Сгенерировано: ${generatedAtIso}.`);
  lines.push(`Studio: ${targets.studioUrl} · Control: ${targets.controlUrl} · CDP: ${targets.cdpEndpoint}`);
  lines.push("");
  lines.push("Файл генерируется `scripts/live-acceptance/new-mission-journey.mjs` и перезаписывается каждым запуском.");
  lines.push("Живой прогон не обязателен: если Chrome/CDP недоступен, шаги помечаются «не выполнено» с причиной, результаты не выдумываются.");
  lines.push("");
  lines.push("## Итог");
  lines.push("");
  lines.push(`- Шагов: ${counts.total}; выполнено: ${counts.ok}; не выполнено: ${counts.failed}.`);
  lines.push(`- Вердикт: ${counts.total > 0 && counts.failed === 0 ? "PASS (все шаги дождались и записали ok)" : "FAIL / NOT ACCEPTED"}.`);
  if (offlineReason !== null) lines.push(`- Транспорт: ${offlineReason}`);
  lines.push("");
  lines.push("## Шаги");
  lines.push("");
  lines.push("| Шаг | Фаза | Ожидание | Действие | Результат | Наблюдение |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of results) {
    const mark = entry.ok === true ? "✔ ok" : `✖ ${entry.reason ?? "провал"}`;
    const observed = entry.observed && Object.keys(entry.observed).length > 0
      ? Object.entries(entry.observed).map(([key, value]) => `${key}=${String(value).replace(/\|/g, "/").slice(0, 120)}`).join(", ")
      : "—";
    lines.push(`| ${entry.id} | ${phaseTitle(entry.phase)} | ${entry.waitsFor ?? "—"} | ${entry.title} | ${mark.replace(/\|/g, "/")} | ${observed} |`);
  }
  lines.push("");
  const failed = results.filter((entry) => entry.ok !== true);
  lines.push("## Шаги не выполнены");
  lines.push("");
  if (failed.length === 0) {
    lines.push("Нет: каждый шаг дождался своего условия и записал ok:true.");
  } else {
    for (const entry of failed) lines.push(`- ${entry.id} ${entry.title} — ${entry.reason ?? "причина не записана"}`);
  }
  lines.push("");
  lines.push("## ЖУРНАЛ НЕУДОБСТВ");
  lines.push("");
  lines.push("### Замечено в этом прогоне");
  lines.push("");
  if (notes.length === 0) {
    lines.push(mode === "live"
      ? "Прогон не записал замечаний."
      : "Живого прогона не было: замечания ниже — из чтения кода, не из наблюдения.");
  } else {
    for (const note of notes) lines.push(`- **${note.title}** (шаг ${note.step}): ${note.detail}`);
  }
  lines.push("");
  lines.push("### Известные расхождения (из чтения кода; живым прогоном не подтверждались)");
  lines.push("");
  for (const item of KNOWN_INCONVENIENCES) lines.push(`- **${item.title}** — ${item.detail} _(${item.source})_`);
  lines.push("");
  lines.push("## Консольные ошибки браузера");
  lines.push("");
  lines.push(consoleErrors.length === 0 ? "Не зафиксировано (или браузера не было)." : consoleErrors.map((line) => `- ${String(line).slice(0, 400)}`).join("\n"));
  lines.push("");
  lines.push("## Оговорки");
  lines.push("");
  lines.push("- Скрипт ходит только на loopback-адреса из CLI; VPS/прод/gate, чужие сессии и учётные данные не используются.");
  lines.push("- Живой прогон с Chrome не обязателен. Пустой прогон и режим --plan — не успех (код 2 у плана, 1 у пустого прогона).");
  lines.push("- Каталог сайта проверяется по адресу Control, потому что Studio-прокси обслуживает только /control/*.");
  lines.push("");
  return lines.join("\n");
}

export function journalPath({ repoRoot = REPO_ROOT, date, worklogPath = null }) {
  return worklogPath !== null ? resolve(worklogPath) : join(repoRoot, "docs", "worklog", `live-acceptance-${date}.md`);
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// --- живой CDP-драйвер ------------------------------------------------------

export function createCdpDriver({ cdpEndpoint, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let ws = null;
  let send = null;
  let sessionId = null;
  const consoleErrors = [];
  const driver = {
    consoleErrors,
    connected: false,
    async connect() {
      assertLoopback(cdpEndpoint, "--cdp-endpoint");
      const version = await fetchImpl(`${cdpEndpoint}/json/version`).then((response) => response.json());
      ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("CDP websocket недоступен"));
      });
      let messageId = 0;
      const pending = new Map();
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
          return;
        }
        if (message.method === "Runtime.exceptionThrown") {
          const details = message.params?.exceptionDetails;
          consoleErrors.push(details?.exception?.description ?? details?.text ?? "exception");
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
          consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
        }
      };
      send = (method, params = {}, sid) => new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)));
        ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
      });
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      driver.connected = true;
      return true;
    },
    async close() {
      driver.connected = false;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    async navigate(url) {
      assertLoopback(url, "навигация");
      await send("Page.navigate", { url }, sessionId);
      await sleep(600);
    },
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
      return result.result.value;
    },
    async insertText(text) {
      await send("Input.insertText", { text }, sessionId);
    },
    async deviceMetrics(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    },
    async fetchJson(url) {
      assertLoopback(url, "http");
      const response = await fetchImpl(url);
      if (!response.ok) return null;
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
  };
  return driver;
}

export async function launchChrome({ chromePath, cdpEndpoint, userDataDir, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (typeof chromePath !== "string" || chromePath.length === 0) return null;
  const port = new URL(cdpEndpoint).port || "9339";
  const profile = userDataDir ?? join(REPO_ROOT, ".tmp-live-acceptance-profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`);
      if (response.ok) return child;
    } catch {
      /* Chrome ещё поднимается */
    }
    await sleep(300);
  }
  return child;
}

// --- CLI --------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    return EXIT_OK;
  }
  const date = options.date ?? todayIso();
  const state = {
    studioUrl: options.studioUrl,
    controlUrl: options.controlUrl,
    viewport: options.viewport,
    projectTitle: `Приёмка ${date}`,
    missionTitle: `Миссия приёмки ${date}`,
    releaseId: `release-acceptance-${date.replace(/-/g, "")}`
  };

  if (options.plan) {
    process.stdout.write(`${renderPlanText()}\n`);
    const journal = renderJournal({
      mode: "plan",
      results: JOURNEY_STEPS.map((step) => ({ id: step.id, phase: step.phase, title: step.title, waitsFor: step.waitsFor, ok: false, reason: "режим --plan: шаг не выполнялся", observed: {} })),
      notes: [],
      consoleErrors: [],
      targets: { studioUrl: options.studioUrl, controlUrl: options.controlUrl, cdpEndpoint: options.cdpEndpoint },
      exitCode: EXIT_PLAN_ONLY,
      date,
      generatedAtIso: new Date().toISOString(),
      offlineReason: "режим --plan: браузер не запускался"
    });
    if (!options.noJournal) writeJournal(journal, options, date);
    return EXIT_PLAN_ONLY;
  }

  let chromeChild = null;
  let driver;
  try {
    driver = createCdpDriver({ cdpEndpoint: options.cdpEndpoint });
    await driver.connect().catch(async (error) => {
      if (options.chromePath === null) throw error;
      chromeChild = await launchChrome({ chromePath: options.chromePath, cdpEndpoint: options.cdpEndpoint, userDataDir: options.userDataDir });
      await driver.connect();
    });
  } catch (error) {
    driver = { consoleErrors: [], evaluate: null, offlineReason: String(error?.message ?? error) };
  }

  const outcome = await runJourney({ driver, state });
  const exitCode = driver.evaluate === null ? EXIT_FAILED : computeExitCode(outcome.results);
  const counts = summarize(outcome.results);

  const journal = renderJournal({
    mode: driver.evaluate === null ? "offline" : "live",
    results: outcome.results.map((entry) => ({ ...entry, waitsFor: JOURNEY_STEPS.find((step) => step.id === entry.id)?.waitsFor ?? "—" })),
    notes: outcome.notes,
    consoleErrors: outcome.consoleErrors,
    targets: { studioUrl: options.studioUrl, controlUrl: options.controlUrl, cdpEndpoint: options.cdpEndpoint },
    exitCode,
    date,
    generatedAtIso: new Date().toISOString(),
    offlineReason: outcome.offlineReason ?? (driver.evaluate === null ? driver.offlineReason ?? OFFLINE_REASON : null)
  });

  process.stdout.write(`live-acceptance: ${counts.ok}/${counts.total} шагов ok, код возврата ${exitCode}\n`);
  for (const entry of outcome.results.filter((item) => !item.ok)) {
    process.stderr.write(`live-acceptance: ${entry.id} ${entry.title} — ${entry.reason}\n`);
  }
  process.stdout.write("\nЖУРНАЛ НЕУДОБСТВ:\n");
  for (const item of KNOWN_INCONVENIENCES) process.stdout.write(`- ${item.title}\n`);
  for (const note of outcome.notes) process.stdout.write(`- (прогон) ${note.title}\n`);

  if (!options.noJournal) {
    const path = writeJournal(journal, options, date);
    process.stdout.write(`\nжурнал: ${path}\n`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ exitCode, mode: driver.evaluate === null ? "offline" : "live", counts, results: outcome.results, notes: outcome.notes }, null, 2)}\n`);
  }
  chromeChild?.kill();
  return exitCode;
}

function writeJournal(journal, options, date) {
  const path = journalPath({ date, worklogPath: options.worklogPath });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, journal);
  return path;
}

const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invoked && invoked === self) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`live-acceptance: fatal: ${String(error?.message ?? error)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
