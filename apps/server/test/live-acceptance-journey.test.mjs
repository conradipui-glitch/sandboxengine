// Тесты живого приёмочного сценария новой миссии (FIN-05/FIN-11).
//
// Скрипт scripts/live-acceptance/new-mission-journey.mjs держит весь маршрут
// transport-независимым: runJourney() принимает инжектируемый драйвер, поэтому
// здесь проверяются структура шагов, семантика кода возврата, журнал неудобств и
// ЗАПРЕТЫ (никаких выдуманных адресов, никаких секретов в коде) — без Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  JOURNEY_STEPS,
  PHASES,
  KNOWN_INCONVENIENCES,
  OFFLINE_REASON,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_PLAN_ONLY,
  assertLoopback,
  computeExitCode,
  parseArgs,
  renderJournal,
  renderPlanText,
  journalPath,
  runJourney
} from "../../../scripts/live-acceptance/new-mission-journey.mjs";

const SCRIPT = fileURLToPath(new URL("../../../scripts/live-acceptance/new-mission-journey.mjs", import.meta.url));
const SOURCE = readFileSync(SCRIPT, "utf8");

const REQUIRED_PHASES = ["project", "mission", "board", "nodes", "story", "screens", "materials", "validation", "publication", "catalog"];

// Драйвер-двойник: имитирует DOM Studio достаточно, чтобы весь маршрут прошёл
// зелёным. Счётные выражения растут на каждый вызов (как реальный DOM после
// добавления узла), поэтому относительные ожидания шагов выполнимы.
function fakeDriver({ missionTitle = "Тестовая миссия", releaseId = "release-test", overrides = [] } = {}) {
  const calls = [];
  const counters = new Map();
  const bump = (expression) => {
    const next = (counters.get(expression) ?? 0) + 1;
    counters.set(expression, next);
    return next;
  };
  const rules = [
    [/navigator\.userAgent/, () => "HeadlessChrome/152.0.0.0"],
    [/draft-meta/, (expression) => bump(expression)],
    [/story-node-scene[\s\S]*\.map\(|\.map\([\s\S]*story-node-scene/, () => ["scene-1", "scene-2"]],
    [/story-node-ending[\s\S]*\.map\(|\.map\([\s\S]*story-node-ending/, () => ["ending-1", "ending-2"]],
    [/story-node\.is-entry/, () => "scene-1"],
    [/dataset\.nodeId/, () => "node-1"],
    [/data-release-blocked/, () => false],
    [/login/, () => false],
    // Любая проверка «элемент есть/нет» ведёт себя как реальный DOM: появился → исчез.
    [/Boolean\(document\.querySelector/, (expression) => bump(expression) % 2 === 1],
    [/story-toolbar/, () => true],
    [/crumbs/, () => true],
    [/draft-header/, () => missionTitle],
    [/publication-receipt/, () => `Опубликовано — подтверждено server receipt ${releaseId}`],
    [/querySelectorAll/, (expression) => bump(expression)],
    [/textContent/, () => "наблюдение прогона"],
    [/.+/, () => true]
  ];
  const driver = {
    calls,
    consoleErrors: [],
    connected: false,
    async connect() {
      driver.connected = true;
      return true;
    },
    async close() {
      driver.connected = false;
    },
    async evaluate(expression) {
      calls.push(expression);
      for (const override of overrides) {
        const value = override(expression);
        if (value !== undefined) return value;
      }
      for (const [pattern, produce] of rules) {
        if (pattern.test(String(expression))) return produce(String(expression));
      }
      return true;
    },
    async navigate() {},
    async insertText() {},
    async deviceMetrics() {},
    async fetchJson(url) {
      return { missions: [{ slug: "acceptance-mission", title: missionTitle, summary: "описание" }], url };
    }
  };
  return driver;
}

function stateFor() {
  return {
    studioUrl: "http://127.0.0.1:4185",
    controlUrl: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 900 },
    projectTitle: "Тестовый проект",
    missionTitle: "Тестовая миссия",
    releaseId: "release-test"
  };
}

// --- структура шагов ---------------------------------------------------------

test("маршрут покрывает все обязательные фазы и каждый шаг самодостаточен", () => {
  assert.ok(JOURNEY_STEPS.length >= 10, `шагов слишком мало: ${JOURNEY_STEPS.length}`);
  const ids = JOURNEY_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, "id шагов должны быть уникальны");
  assert.deepEqual(ids, ids.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), "шаги должны идти по порядку");
  const phaseIds = new Set(PHASES.map((phase) => phase.id));
  for (const step of JOURNEY_STEPS) {
    assert.equal(typeof step.id, "string");
    assert.ok(step.id.length > 0);
    assert.ok(typeof step.title === "string" && step.title.length > 3, `${step.id}: нет заголовка`);
    assert.ok(typeof step.waitsFor === "string" && step.waitsFor.length > 5, `${step.id}: шаг не объявляет, чего ждёт`);
    assert.ok(phaseIds.has(step.phase), `${step.id}: фаза '${step.phase}' не объявлена в PHASES`);
    assert.equal(typeof step.run, "function", `${step.id}: нет run()`);
  }
  const usedPhases = new Set(JOURNEY_STEPS.map((step) => step.phase));
  for (const phase of REQUIRED_PHASES) {
    assert.ok(usedPhases.has(phase), `фаза '${phase}' маршрута не покрыта ни одним шагом`);
  }
});

test("код возврата считается по фактическим результатам, а не по заголовкам шагов", () => {
  assert.equal(computeExitCode(JOURNEY_STEPS.map((step, index) => ({ id: step.id, ok: true, index }))), EXIT_OK);
  assert.notEqual(computeExitCode([{ ok: true }, { ok: false }]), EXIT_OK);
  assert.notEqual(computeExitCode([{ ok: false }]), EXIT_OK);
  assert.notEqual(computeExitCode([]), EXIT_OK); // ничего не проверено — не успех
  assert.notEqual(computeExitCode(undefined), EXIT_OK);
});

// --- ядро прогона ------------------------------------------------------------

test("зелёный прогон (все шаги дождались и записали ok) даёт код 0", async () => {
  const outcome = await runJourney({ driver: fakeDriver(), state: stateFor(), sleep: async () => {} });
  assert.equal(outcome.results.length, JOURNEY_STEPS.length, "каждый шаг обязан оставить запись");
  const failed = outcome.results.filter((entry) => !entry.ok);
  assert.deepEqual(failed, [], `шаги с провалом: ${JSON.stringify(failed)}`);
  assert.equal(computeExitCode(outcome.results), EXIT_OK);
  assert.ok(outcome.results.every((entry) => entry.waits > 0), "у каждого шага должно быть ожидание");
  assert.ok(outcome.results.every((entry) => entry.asserts > 0), "у каждого шага должна быть запись результата");
});

test("провал одного шага делает прогон красным и объясняет причину", async () => {
  const driver = fakeDriver({ overrides: [(expression) => (String(expression).includes("projects-screen") ? false : undefined)] });
  const outcome = await runJourney({ driver, state: stateFor(), sleep: async () => {} });
  const broken = outcome.results.filter((entry) => !entry.ok);
  assert.ok(broken.length > 0, "провал Studio обязан быть замечен");
  assert.equal(broken[0].id, "S1");
  assert.match(broken[0].reason, /не дождались/);
  assert.notEqual(computeExitCode(outcome.results), EXIT_OK);
});

test("шаг без ожидания и шаг без записи результата считаются провалом", async () => {
  const noWait = { id: "X1", phase: "studio", title: "шаг без ожидания", waitsFor: "ничего", run: async (api) => { api.expect(true, "не бывает"); } };
  const noAssert = { id: "X2", phase: "studio", title: "шаг без записи", waitsFor: "всё", run: async (api) => { await api.waitForSelector("#app"); } };
  const both = { id: "X3", phase: "studio", title: "полный шаг", waitsFor: "всё и результат", run: async (api) => { await api.waitForSelector("#app"); api.expect(true, "ок"); } };
  const outcome = await runJourney({ driver: fakeDriver(), steps: [noWait, noAssert, both], state: stateFor(), sleep: async () => {} });
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].reason, /не дождался/);
  assert.equal(outcome.results[1].ok, false);
  assert.match(outcome.results[1].reason, /не записал/);
  assert.equal(outcome.results[2].ok, true);
  assert.notEqual(computeExitCode(outcome.results), EXIT_OK);
});

test("без браузера/CDP шаги честно помечаются «не выполнено», а не выдумываются", async () => {
  const outcome = await runJourney({ driver: { evaluate: null, consoleErrors: [] }, state: stateFor(), sleep: async () => {} });
  assert.equal(outcome.results.length, JOURNEY_STEPS.length);
  assert.ok(outcome.results.every((entry) => entry.ok === false), "ни один шаг не может быть зелёным без транспорта");
  assert.ok(outcome.results.every((entry) => entry.reason === OFFLINE_REASON));
  assert.equal(computeExitCode(outcome.results), EXIT_FAILED);
});

test("недоступный CDP-connect не превращается в успешный прогон", async () => {
  const driver = fakeDriver();
  driver.connect = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:9339");
  };
  const outcome = await runJourney({ driver, state: stateFor(), sleep: async () => {} });
  assert.match(outcome.offlineReason, /ECONNREFUSED/);
  assert.notEqual(computeExitCode(outcome.results), EXIT_OK);
});

// --- запреты: адреса и секреты ----------------------------------------------

test("в скрипте нет выдуманных адресов: все URL — loopback", () => {
  const urls = SOURCE.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  assert.ok(urls.length > 0, "адреса должны браться из CLI/умолчаний");
  const foreign = urls.filter((raw) => {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return !["127.0.0.1", "localhost", "::1"].includes(host);
  });
  assert.deepEqual(foreign, [], `найдены не-loopback адреса: ${foreign.join(", ")}`);
  assert.match(SOURCE, /assertLoopback/, "скрипт обязан проверять loopback до запроса");
});

test("адреса из CLI не могут указывать на VPS/прод/gate", () => {
  assert.throws(() => parseArgs(["--studio-url", "https://prod.example.com"]), /loopback/);
  assert.throws(() => parseArgs(["--control-url", "http://10.0.0.5:8788"]), /loopback/);
  assert.throws(() => parseArgs(["--cdp-endpoint", "https://gate.example.net"]), /loopback/);
  assert.throws(() => parseArgs(["--studio-url", "not-a-url"]), /не URL/);
  assert.throws(() => parseArgs(["--unknown-flag"]), /неизвестный аргумент/);
  const options = parseArgs([]);
  assert.equal(options.studioUrl, "http://127.0.0.1:4185");
  assert.equal(options.controlUrl, "http://127.0.0.1:8788");
  assert.equal(options.cdpEndpoint, "http://127.0.0.1:9339");
  assert.doesNotThrow(() => assertLoopback("http://localhost:4185", "test"));
});

test("скрипт не требует секретов в коде и не читает их из окружения", () => {
  assert.doesNotMatch(SOURCE, /process\.env/, "адреса и доступы не берутся из окружения — только CLI");
  assert.doesNotMatch(SOURCE, /\b(secret|token|password|passwd|cookie|authorization|api[_-]?key|bearer)\b/i, "в скрипте не должно быть слов-секретов");
  assert.doesNotMatch(SOURCE, /--(secret|token|password)\b/i, "у CLI нет флагов секретов");
  const options = parseArgs(["--studio-url", "http://127.0.0.1:1"]);
  assert.equal(Object.keys(options).some((key) => /secret|token|password/i.test(key)), false);
});

// --- журнал неудобств -------------------------------------------------------

test("журнал неудобств печатается и содержит шаги, провалы и известные расхождения", async () => {
  const driver = fakeDriver({ overrides: [(expression) => (String(expression).includes("projects-screen") ? false : undefined)] });
  const outcome = await runJourney({ driver, state: stateFor(), sleep: async () => {} });
  const journal = renderJournal({
    mode: "live",
    results: outcome.results,
    notes: outcome.notes,
    consoleErrors: [],
    targets: { studioUrl: "http://127.0.0.1:4185", controlUrl: "http://127.0.0.1:8788", cdpEndpoint: "http://127.0.0.1:9339" },
    exitCode: computeExitCode(outcome.results),
    date: "2026-09-11",
    generatedAtIso: "2026-09-11T00:00:00.000Z",
    offlineReason: null
  });
  assert.match(journal, /ЖУРНАЛ НЕУДОБСТВ/);
  assert.match(journal, /## Шаги не выполнены/);
  assert.match(journal, /S1/);
  for (const item of KNOWN_INCONVENIENCES) assert.ok(journal.includes(item.title), `в журнале нет расхождения «${item.title}»`);
  assert.ok(KNOWN_INCONVENIENCES.length >= 5, "журнал должен описывать реальные расхождения, а не один пункт");
});

test("journal-файл кладётся в docs/worklog/live-acceptance-<дата>.md", () => {
  const path = journalPath({ date: "2026-09-11" }).replace(/\\/g, "/");
  assert.match(path, /docs\/worklog\/live-acceptance-2026-09-11\.md$/);
  assert.match(journalPath({ date: "2026-09-11", worklogPath: "C:/tmp/x.md" }).replace(/\\/g, "/"), /\/tmp\/x\.md$/);
});

test("--plan печатает план всех шагов и честно объявляет, что это не приёмка", () => {
  const plan = renderPlanText();
  for (const step of JOURNEY_STEPS) assert.ok(plan.includes(step.id), `в плане нет шага ${step.id}`);
  assert.match(plan, /не выполнено/);
  assert.match(plan, /кодом 2/);
  assert.equal(EXIT_PLAN_ONLY, 2);
  assert.notEqual(EXIT_PLAN_ONLY, EXIT_OK);
  assert.notEqual(EXIT_FAILED, EXIT_OK);
});
