// FIN-14: пакет передачи проекта команде — проверки генератора handoff-манифеста.
//
// Что проверяется:
//   1. манифест собирается из явных аргументов CLI и валидируется по составу;
//   2. в манифесте нет секретов — ни значений, ни имён переменных, обозначающих
//      материал доступа (substring-проверка + форма значений);
//   3. генератор детерминирован: два прогона на одном входе совпадают всем, кроме
//      времени;
//   4. отсутствующие данные честно помечены null с причиной, а не заглушкой;
//   5. нехватка данных даёт код выхода 2, как `migrate:fin01`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "handoff-package.mjs");

const MISSION_A = "florence/florence-workshop/florence-workshop";
const MISSION_B = "florence/transfer-desk";

function runGenerator(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.error, undefined, `generator failed to start: ${result.error?.message}`);
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function generate(args) {
  const dir = await mkdtemp(join(tmpdir(), "fin14-handoff-"));
  const out = join(dir, "handoff-manifest.json");
  const run = runGenerator([...args, "--out", out]);
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(out, "utf8"));
  } catch {
    manifest = null;
  }
  return { dir, out, run, manifest };
}

function walk(value, path = [], visit = () => {}) {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, [...path, index], visit));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) walk(entry, [...path, key], visit);
  }
}

const BASE_ARGS = ["--mission", MISSION_A, "--mission", MISSION_B, "--now", "2026-01-02T03:04:05.000Z"];

test("FIN-14: генератор собирает валидируемый манифест передачи из явных аргументов", async () => {
  const { dir, run, manifest } = await generate(BASE_ARGS);
  try {
    assert.equal(run.code, 0, `expected exit 0 (complete package), got ${run.code}:\n${run.stdout}\n${run.stderr}`);
    assert.ok(manifest, "manifest must be written as valid JSON");

    assert.equal(manifest.schemaVersion, "1.0");
    assert.equal(manifest.status, "complete");
    assert.deepEqual(manifest.blockers, []);

    // Состав: SHA git, версии Node/npm, имена compose-сервисов — из фактов репозитория.
    assert.match(manifest.source.commit, /^[0-9a-f]{40}$/, "commit must be a full git SHA");
    assert.equal(manifest.source.commitShort, manifest.source.commit.slice(0, 7));
    assert.match(manifest.source.node, /^v\d+\.\d+\.\d+$/, "node version must be the running runtime");
    assert.ok(
      typeof manifest.source.npmObserved === "string" || manifest.source.npmObserved === null,
      "npmObserved must be a version string or an honest null"
    );
    if (manifest.source.npmObserved === null) {
      assert.equal(typeof manifest.source.npmObservedReason, "string");
    }
    assert.deepEqual(manifest.source.composeServices, ["authored", "engine", "gate", "studio"], "compose file is the source of truth for the running composition");

    // Адреса: Studio / Control / Engine / сайт / gate — все пять, без учётных данных.
    assert.equal(manifest.addresses.host, "85.137.95.104.sslip.io");
    const names = manifest.addresses.components.map((component) => component.name);
    for (const expected of ["studio", "control", "engine", "site", "gate"]) {
      assert.ok(names.includes(expected), `addresses must cover component "${expected}"`);
    }
    for (const component of manifest.addresses.components) {
      assert.equal(typeof component.purpose, "string");
      assert.ok(Array.isArray(component.envVars) || component.envVars === null);
      if (component.envVars === null) assert.equal(typeof component.envVarsReason, "string", "missing env vars must carry a reason");
      if (component.url === null) assert.equal(typeof component.reason, "string", `component "${component.name}" without a public URL must say why`);
      else assert.match(component.url, /^https:\/\/85\.137\.95\.104\.sslip\.io:\d{4}(\/.*)?$/);
    }
    const studio = manifest.addresses.components.find((component) => component.name === "studio");
    assert.equal(studio.url, "https://85.137.95.104.sslip.io:8741/");
    const gate = manifest.addresses.components.find((component) => component.name === "gate");
    assert.equal(gate.url, "https://85.137.95.104.sslip.io:8741/gate/");

    // Две показательные миссии — ровно те id, что переданы в CLI, плюс честная
    // пометка: slug не передан вторым аргументом, значит его нет.
    assert.equal(manifest.demoMissions.length, 2);
    assert.equal(manifest.demoMissions[0].id, "mission:florence:florence-workshop");
    assert.equal(manifest.demoMissions[0].slug, "florence-workshop");
    assert.equal(manifest.demoMissions[0].verifiedFromCatalog, null);
    assert.equal(typeof manifest.demoMissions[0].verifiedReason, "string");
    assert.equal(manifest.demoMissions[1].id, "mission:florence:transfer-desk");
    assert.equal(manifest.demoMissions[1].slug, null);
    assert.equal(typeof manifest.demoMissions[1].slugReason, "string");

    // Роли — из capability-матрицы, а не из пересказа.
    assert.equal(manifest.roles.available, true);
    assert.equal(manifest.roles.source, "docs/CAPABILITY-MATRIX.md");
    assert.deepEqual(manifest.roles.roles.map((role) => role.name), ["owner", "editor", "tester"]);
    for (const role of manifest.roles.roles) {
      assert.equal(typeof role.summary, "string");
      assert.ok(role.summary.length > 0, `role "${role.name}" must state what it can`);
      assert.ok(Array.isArray(role.routes) && role.routes.length > 0, `role "${role.name}" must list grounded routes`);
    }

    // Инструкции: какие файлы читать, и существуют ли они на самом деле.
    assert.ok(manifest.instructions.length >= 5);
    const handoff = manifest.instructions.find((entry) => entry.path === "docs/TEAM-HANDOFF.md");
    assert.ok(handoff, "the human instruction must be listed");
    assert.equal(handoff.exists, true);
    assert.equal(handoff.reason, null);
    const matrix = manifest.instructions.find((entry) => entry.path === "docs/CAPABILITY-MATRIX.md");
    assert.equal(matrix.exists, true);

    // Настройки доступа: значения не перечисляются, имена — под счётчиком.
    assert.equal(manifest.standOnlySettings.enumerated, false);
    assert.equal(typeof manifest.standOnlySettings.where, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FIN-14: манифест не содержит секретов — ни значений, ни имён переменных доступа", async () => {
  const { dir, manifest } = await generate(BASE_ARGS);
  try {
    assert.ok(manifest);
    const raw = JSON.stringify(manifest);

    // 1. Ни одного упоминания сущностей доступа — ни как значения, ни как имя
    //    переменной окружения.
    for (const banned of ["token", "secret", "password", "cookie", "key"]) {
      assert.equal(
        raw.toLowerCase().includes(banned),
        false,
        `manifest must not mention "${banned}" anywhere (values or env var names): ${raw.toLowerCase().match(new RegExp(`.{0,60}${banned}.{0,60}`))?.[0]}`
      );
    }

    // 2. Ни одно значение не выглядит как настоящий секрет (кроме явно
    //    разрешённых публичных идентификаторов состава).
    const allowed = new Set([manifest.source.commit, manifest.source.commitShort].filter(Boolean));
    const tokenish = [
      /ghp_[A-Za-z0-9]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /sk-[A-Za-z0-9]{16,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]+-----/,
      /Bearer\s+\S+/,
      /\b[A-Za-z0-9+/]{40,}={0,2}\b/
    ];
    walk(manifest, [], (value, path) => {
      if (typeof value !== "string") return;
      if (allowed.has(value)) return;
      for (const pattern of tokenish) {
        assert.equal(pattern.test(value), false, `value at ${path.join(".") || "<root>"} looks like a real credential: ${value.slice(0, 80)}`);
      }
    });

    // 3. Ни одно значение не равно значению из окружения, которым подписан стенд.
    const suspicious = Object.entries(process.env).filter(
      ([name, value]) => typeof value === "string" && value.length >= 24 && /(TOKEN|SECRET|PASSWORD|COOKIE|KEY)/i.test(name)
    );
    for (const [name, value] of suspicious) {
      assert.equal(raw.includes(value), false, `manifest must not leak the value of ${name}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FIN-14: генератор детерминирован — два прогона на одном входе совпадают кроме времени", async () => {
  const first = await generate(BASE_ARGS);
  const second = await generate(BASE_ARGS);
  try {
    assert.ok(first.manifest && second.manifest);
    assert.deepEqual(second.manifest, first.manifest, "with an explicit --now the whole manifest must be byte-identical");

    const timed = await generate(["--mission", MISSION_A, "--mission", MISSION_B]);
    const timedAgain = await generate(["--mission", MISSION_A, "--mission", MISSION_B]);
    try {
      assert.ok(timed.manifest && timedAgain.manifest);
      const strip = (manifest) => {
        const copy = JSON.parse(JSON.stringify(manifest));
        delete copy.generatedAt;
        delete copy.generatedAtMs;
        return copy;
      };
      assert.deepEqual(strip(timedAgain.manifest), strip(timed.manifest), "only the timestamp may differ between runs");
      assert.equal(typeof timed.manifest.generatedAt, "string");
      assert.equal(typeof timed.manifest.generatedAtMs, "number");
    } finally {
      await rm(timed.dir, { recursive: true, force: true });
      await rm(timedAgain.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(first.dir, { recursive: true, force: true });
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("FIN-14: отсутствующие данные помечены null с причиной, а не заглушкой", async () => {
  // checkout без docs/, без compose и без конфигурации nginx: генератор обязан
  // признаться в этом, а не подставить правдоподобные значения.
  const emptyRoot = await mkdtemp(join(tmpdir(), "fin14-empty-"));
  const dir = await mkdtemp(join(tmpdir(), "fin14-out-"));
  try {
    await mkdir(join(emptyRoot, "docs"), { recursive: true });
    const run = runGenerator([
      "--root", emptyRoot,
      "--out", join(dir, "manifest.json"),
      "--mission", MISSION_A,
      "--mission", MISSION_B,
      "--now", "2026-01-02T03:04:05.000Z"
    ]);
    assert.equal(run.code, 2, `incomplete package must exit 2, got ${run.code}`);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));

    assert.equal(manifest.status, "incomplete");
    assert.ok(manifest.blockers.length > 0, "blockers must name what is missing");

    assert.equal(manifest.roles.available, false);
    assert.equal(manifest.roles.roles, null);
    assert.match(manifest.roles.reason, /CAPABILITY-MATRIX/);

    assert.equal(manifest.source.composeServices, null);
    assert.equal(typeof manifest.source.composeReason, "string");
    assert.equal(manifest.addresses.host, null);
    assert.equal(typeof manifest.addresses.hostReason, "string");

    for (const entry of manifest.instructions) {
      assert.equal(entry.exists, false);
      assert.equal(typeof entry.reason, "string", `missing instruction "${entry.path}" must carry a reason`);
    }

    // Ни одного выдуманного значения: чего нет — то null, и рядом причина.
    assert.equal(manifest.source.commit, null, "no git HEAD means null, never a copied or plausible SHA");
    assert.equal(typeof manifest.source.commitReason, "string");
    assert.ok(
      manifest.blockers.some((blocker) => blocker.includes("HEAD")),
      `blockers must name the missing commit: ${JSON.stringify(manifest.blockers)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("FIN-14: нехватка данных даёт exit 2 (как migrate:fin01), ошибка аргументов — exit 1", async () => {
  const one = await generate(["--mission", MISSION_A, "--now", "2026-01-02T03:04:05.000Z"]);
  try {
    assert.equal(one.run.code, 2, `one mission is not a two-mission package: got ${one.run.code}`);
    assert.equal(one.manifest.status, "incomplete");
    assert.ok(one.manifest.demoMissions.length === 1, "the manifest still records the single mission honestly");
    assert.ok(
      one.manifest.blockers.some((blocker) => blocker.includes("2 из 2") || blocker.includes("показательных миссий")),
      `blockers must explain the missing mission: ${JSON.stringify(one.manifest.blockers)}`
    );
  } finally {
    await rm(one.dir, { recursive: true, force: true });
  }

  const none = await generate([]);
  try {
    assert.equal(none.run.code, 2);
    assert.equal(none.manifest.status, "incomplete");
    assert.deepEqual(none.manifest.demoMissions, [], "no missions are invented when none are passed");
  } finally {
    await rm(none.dir, { recursive: true, force: true });
  }

  const bad = runGenerator(["--mission", "florence", "--mission", MISSION_B]);
  assert.equal(bad.code, 1, "a malformed mission identifier is an argument error, not missing data");
  assert.match(bad.stderr, /invalid --mission/);
});

test("FIN-14: инструкция для человека существует и описывает вход, миссию, прохождение и комментарий", async () => {
  const doc = await readFile(join(repoRoot, "docs", "TEAM-HANDOFF.md"), "utf8");
  for (const section of ["gate-бота", "найти миссию", "пройти миссию", "оставить комментарий", "Частые проблемы"]) {
    assert.ok(doc.includes(section), `TEAM-HANDOFF.md must cover "${section}"`);
  }
  assert.ok(doc.includes("docs/CAPABILITY-MATRIX.md"), "the instruction must point at the capability matrix");
  assert.ok(doc.includes("deploy/vps/handoff-manifest.json"), "the instruction must point at the generated manifest");
  assert.ok(doc.includes("handoff-package.mjs"), "the instruction must say how the package is regenerated");
});
