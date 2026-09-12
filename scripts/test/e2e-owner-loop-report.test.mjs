// e2e-owner-loop-report.test.mjs — несущий тест отчёта сквозного цикла владельца.
//
//   node --test scripts/test/e2e-owner-loop-report.test.mjs
//
// Проверяет СТРУКТУРУ и честность отчёта artifacts/e2e-owner-loop/report.json,
// оставленного последним прогоном scripts/e2e-owner-loop.mjs: каждый шаг имеет
// статус из фикс-набора, FAIL-шагов нет у успешного прогона, скриншоты, о которых
// заявлено, существуют на диске, а домен шагов покрывает весь цикл владельца
// (стенд → проект → ИИ → сохранение → админка → плеер → публикация → каталог).
// Тест НЕ перезапускает стенд: он проверяет артефакт реального прогона.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const reportPath = join(repo, "artifacts", "e2e-owner-loop", "report.json");

const STATUSES = new Set(["PASS", "SKIP", "FAIL"]);
// Домен шагов: какие фазы цикла обязан покрывать отчёт (префиксы шагов).
const REQUIRED_PHASES = [
  { prefix: "S01", what: "подъём чистого стенда" },
  { prefix: "S02", what: "создание проекта через продукт-Studio" },
  { prefix: "S03", what: "генерация миссии ИИ-агентом" },
  { prefix: "S04", what: "сохранение и перечитывание миссии" },
  { prefix: "S05", what: "админка: миссия с метаданными" },
  { prefix: "S06", what: "проверка и игра в плеере" },
  { prefix: "S07", what: "публикация продуктовым маршрутом" },
  { prefix: "S08", what: "публичный каталог и страница миссии" },
  { prefix: "S09", what: "скриншоты ключевых экранов" }
];

test("отчёт e2e-цикла существует и читается как JSON", () => {
  assert.equal(existsSync(reportPath), true, `нет отчёта ${reportPath} — запустите scripts/e2e-owner-loop.mjs`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(typeof report.operationId, "string");
  assert.ok(report.operationId.startsWith("e2e-"), "operationId должен начинаться с e2e-");
});

test("отчёт фиксирует SHA и ветку репозитория", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.match(report.repoSha, /^[0-9a-f]{40}$/, "repoSha — полный git SHA");
  assert.equal(typeof report.branch, "string");
  assert.ok(report.branch.length > 0);
});

test("каждый шаг имеет id, название и статус из фикс-набора", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.ok(Array.isArray(report.steps) && report.steps.length > 0, "шагов нет — пустой прогон не отчёт");
  for (const step of report.steps) {
    assert.equal(typeof step.id, "string");
    assert.equal(typeof step.title, "string");
    assert.ok(STATUSES.has(step.status), `шаг ${step.id}: неизвестный статус ${step.status}`);
  }
});

test("верdict отчёта согласован с пошаговыми статусами", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const fails = report.steps.filter((s) => s.status === "FAIL").length;
  const skips = report.steps.filter((s) => s.status === "SKIP").length;
  const expected = fails > 0 ? "FAIL" : skips > 0 ? "PARTIAL" : "PASS";
  assert.equal(report.verdict, expected, "вердикт должен выводиться из статусов, а не назначаться вручную");
  const counts = report.counts ?? {};
  assert.equal((counts.PASS ?? 0) + (counts.SKIP ?? 0) + (counts.FAIL ?? 0), report.steps.length, "сумма counts не сходится с числом шагов");
});

test("цикл владельца покрыт целиком: каждая фаза имеет хотя бы один шаг", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const { prefix, what } of REQUIRED_PHASES) {
    const found = report.steps.some((s) => s.id.startsWith(prefix) && s.status !== "FAIL");
    assert.ok(found, `фаза «${what}» (${prefix}*) не покрыта ни одним не-FAIL шагом`);
  }
});

test("заявленные скриншоты существуют на диске и не пусты", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.ok(Array.isArray(report.screenshots), "screenshots отсутствует");
  assert.ok(report.screenshots.length >= 3, "по брифу нужны минимум три скриншота (карточка проекта, карточка миссии, публичная страница)");
  for (const shot of report.screenshots) {
    assert.equal(typeof shot.path, "string");
    assert.equal(existsSync(shot.path), true, `скриншот заявлен, но отсутствует: ${shot.path}`);
    assert.ok(statSync(shot.path).size > 1000, `скриншот подозрительно мал: ${shot.path}`);
  }
});

test("SKIP-шаги объяснены, а не замолчаны", () => {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const step of report.steps.filter((s) => s.status === "SKIP")) {
    assert.equal(typeof step.detail, "string");
    assert.ok(step.detail.length > 20, `SKIP-шаг ${step.id} без объяснения`);
  }
});
