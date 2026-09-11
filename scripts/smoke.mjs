#!/usr/bin/env node
// Смок-проверка живого контура Living History.
//
// Поднимает РЕАЛЬНЫЙ собранный сервер (apps/server/dist/main.js) на временной базе,
// проходит путь автора (проект → миссия → документ миссии → проверка → релиз → публикация),
// затем путь читателя/игрока (каталог → карточка → сессия → ход) и проверяет честность
// отказов. В конце перезапускает сервер на той же базе: опубликованное обязано пережить рестарт.
//
// Запуск:  node scripts/smoke.mjs            (нужна предварительная сборка: npx tsc -b)
//          node scripts/smoke.mjs --json     (машинный вывод; квитанция пишется всегда)
// Код выхода: 0 — все шаги PASS (SKIP печатается явно), 1 — есть FAIL.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const serverEntry = join(repo, "apps", "server", "dist", "main.js");

const RUNTIME_PORT = Number(process.env.SMOKE_RUNTIME_PORT ?? 8791);
const CONTROL_PORT = Number(process.env.SMOKE_CONTROL_PORT ?? 8790);
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 25_000);

const steps = [];
const record = (id, title, status, detail) => {
  steps.push({ id, title, status, detail: detail ?? null });
  const mark = status === "PASS" ? "✔" : status === "SKIP" ? "…" : "✖";
  process.stderr.write(`${mark} ${id}  ${title}${detail ? ` — ${detail}` : ""}\n`);
};

const request = async (path, options = {}) => {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${BASE}${path}`, { method: options.method ?? "GET", headers, body });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForReady = async (child) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`сервер завершился до готовности (exit ${child.exitCode})`);
    try {
      const probe = await request("/public/v1/missions");
      if (probe.status === 200) return;
    } catch {
      /* сервер ещё не слушает */
    }
    await sleep(250);
  }
  throw new Error(`сервер не стал готов за ${READY_TIMEOUT_MS} мс`);
};

const startServer = async (databasePath) => {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repo,
    env: {
      ...process.env,
      RUNTIME_DB_PATH: databasePath,
      PORT: String(RUNTIME_PORT),
      CONTROL_PORT: String(CONTROL_PORT),
      HOST: "127.0.0.1",
      CONTROL_HOST: "127.0.0.1",
      CONTROL_AUTH_MODE: "local",
      // Локальный смок поднимает сервер на 127.0.0.1; без секрета публичные
      // маршруты честно отвечают 503 PUBLIC_MISSION_RUNTIME_UNAVAILABLE.
      // Боевой секрет берётся из окружения, если задан.
      LH_PUBLIC_MISSION_SESSION_SECRET: process.env.LH_PUBLIC_MISSION_SESSION_SECRET ?? "smoke-local-public-mission-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForReady(child);
  return { child };
};

const stopServer = async (server) => {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill();
  const deadline = Date.now() + 5_000;
  while (server.child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
};

const locationBlock = Object.freeze({
  schemaVersion: "1.0",
  id: "start",
  kind: "core.location",
  title: "Старт",
  description: "",
  data: {}
});

const initialWorld = () => ({
  schemaVersion: "1.0",
  revision: 0,
  clock: { elapsedSeconds: 0 },
  locations: [],
  entities: [],
  resources: [],
  items: [],
  terminal: null
});

// Авторский документ миссии: сцена с выбором, ведущим в концовку.
// Без него реальный сервер не собирает релиз — заморозка бандла отвечает RELEASE_FREEZE_FAILED.
const missionDocument = (projectId, questId) => ({
  schemaVersion: "1.0",
  projectId,
  questId,
  contentRevision: 0,
  contentHash: "",
  listing: {
    title: "Смок-миссия",
    slug: "smoke-mission",
    summary: "Сквозная проверка контура.",
    coverAssetId: null,
    period: "1917",
    place: "Станция",
    playerRole: "Кладовщик",
    estimatedMinutes: 10,
    supportedModes: ["choice"]
  },
  story: {
    entrySceneId: "start",
    scenes: [
      {
        id: "start",
        title: "Старт",
        text: "Ночь.",
        dialogue: [],
        choices: [{ id: "finish", label: "Закончить", targetSceneId: null, endingId: "done", conditions: [], effects: [] }]
      }
    ],
    endings: [{ id: "done", title: "Готово", text: "Рассвет." }]
  },
  screens: { intros: [], scenes: {}, endings: {} },
  defaults: { background: null, theme: "station-night", animationPreset: "calm" }
});

const main = async () => {
  if (!existsSync(serverEntry)) {
    record("S0", "собранный сервер на месте", "FAIL", `${serverEntry} не найден — нужен npx tsc -b --force`);
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), "lh-smoke-"));
  const databasePath = join(dir, "smoke.sqlite");
  const projectId = "smoke";
  const questId = "smoke-mission";
  const releaseId = "smoke-release-1";

  let server = await startServer(databasePath);
  let slug = null;
  try {
    const projects = await request("/control/v1/projects");
    record(
      "S1",
      "Control отвечает списком проектов",
      projects.status === 200 && Array.isArray(projects.body?.projects) ? "PASS" : "FAIL",
      `status ${projects.status}`
    );

    const emptyCatalog = await request("/public/v1/missions");
    const emptyOk = emptyCatalog.status === 200
      && Array.isArray(emptyCatalog.body?.missions)
      && emptyCatalog.body.missions.length === 0;
    record("S2", "на свежей базе публичный каталог пуст", emptyOk ? "PASS" : "FAIL", `status ${emptyCatalog.status}, записей ${emptyCatalog.body?.missions?.length ?? "—"}`);

    const project = await request("/control/v1/projects", {
      method: "POST",
      headers: { "idempotency-key": "smoke-project" },
      json: { projectId, title: "Смок-проверка" }
    });
    record("S3", "проект создаётся", project.status === 201 ? "PASS" : "FAIL", `status ${project.status}, код ${project.body?.error?.code ?? "—"}`);

    const quest = await request(`/control/v1/projects/${projectId}/quests`, {
      method: "POST",
      headers: { "idempotency-key": "smoke-quest" },
      json: { questId, title: "Смок-миссия", entryLocationId: "start", initialBlocks: [locationBlock] }
    });
    record("S4", "миссия создаётся в проекте", quest.status === 201 ? "PASS" : "FAIL", `status ${quest.status}, код ${quest.body?.error?.code ?? "—"}`);

    const missionSave = await request(`/control/v1/projects/${projectId}/quests/${questId}/mission`, {
      method: "POST",
      headers: { "idempotency-key": "smoke-mission" },
      json: { baseRevision: 0, mission: missionDocument(projectId, questId) }
    });
    const draftRevision = missionSave.body?.mission?.contentRevision ?? null;
    const savedOk = (missionSave.status === 201 || missionSave.status === 200) && draftRevision !== null;
    record("S5", "документ миссии сохраняется с ревизией", savedOk ? "PASS" : "FAIL", `status ${missionSave.status}, ревизия ${draftRevision ?? "—"}, код ${missionSave.body?.error?.code ?? "—"}`);
    if (!savedOk) throw new Error("без сохранённой ревизии миссии дальнейшие шаги недостоверны");

    const validation = await request(`/control/v1/projects/${projectId}/quests/${questId}/validations`, {
      method: "POST",
      headers: { "idempotency-key": "smoke-validation" },
      json: { draftRevision: 0 }
    });
    const validationId = validation.body?.validation?.validationId ?? null;
    const validationOk = validation.status === 201 && validation.body?.validation?.status === "valid" && validationId !== null;
    record("S6", "проверка черновика даёт valid", validationOk ? "PASS" : "FAIL", `status ${validation.status}, итог ${validation.body?.validation?.status ?? "—"}, id ${validationId ? "есть" : "нет"}`);
    if (!validationOk) throw new Error("без validationId сборка релиза недостоверна");

    const release = await request(`/control/v1/projects/${projectId}/quests/${questId}/releases`, {
      method: "POST",
      headers: { "idempotency-key": "smoke-release" },
      json: { releaseId, draftRevision: 0, validationId }
    });
    const releaseOk = release.status === 201 && release.body?.release?.releaseId === releaseId;
    record("S7", "релиз собирается из проверенного черновика", releaseOk ? "PASS" : "FAIL", `status ${release.status}, код ${release.body?.error?.code ?? "—"}${release.body?.error?.detailCode ? `/${release.body.error.detailCode}` : ""}`);

    const publish = await request(`/control/v1/projects/${projectId}/quests/${questId}/publish`, {
      method: "POST",
      headers: { "idempotency-key": "smoke-publish" },
      json: { releaseId, expectedCurrentReleaseId: null }
    });
    record("S8", "релиз публикуется", publish.status === 200 ? "PASS" : "FAIL", `status ${publish.status}, код ${publish.body?.error?.code ?? "—"}`);

    const releases = await request(`/control/v1/projects/${projectId}/quests/${questId}/releases`);
    const current = Array.isArray(releases.body?.releases) ? releases.body.releases.find((item) => item.isCurrent === true) : null;
    record("S9", "указатель публикации смотрит на выпущенный релиз", current?.releaseId === releaseId ? "PASS" : "FAIL", `current ${current?.releaseId ?? "—"}`);

    const catalog = await request("/public/v1/missions");
    const entry = Array.isArray(catalog.body?.missions) ? catalog.body.missions[0] ?? null : null;
    slug = entry?.slug ?? null;
    const catalogOk = catalog.status === 200 && catalog.body?.missions?.length === 1 && slug !== null;
    record("S10", "опубликованная миссия видна в публичном каталоге", catalogOk ? "PASS" : "FAIL", `status ${catalog.status}, записей ${catalog.body?.missions?.length ?? "—"}, адрес ${slug ?? "—"}`);

    const missionCard = slug === null
      ? { status: 0, body: null }
      : await request(`/public/v1/missions/${encodeURIComponent(slug)}`);
    record("S11", "публичная карточка миссии отдаётся", missionCard.status === 200 ? "PASS" : "FAIL", `status ${missionCard.status}`);

    const unknown = await request("/public/v1/missions/no-such-mission-anywhere");
    record("S12", "неизвестная миссия — честный 404", unknown.status === 404 ? "PASS" : "FAIL", `status ${unknown.status}`);

    if (slug === null) {
      record("S13", "битый initialWorld отвергается как 400", "FAIL", "нет адреса миссии из каталога");
      record("S14", "игровая сессия стартует на опубликованной миссии", "FAIL", "нет адреса миссии из каталога");
    } else {
      const malformed = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions`, {
        method: "POST",
        headers: { "idempotency-key": "smoke-bad-world" },
        json: { sessionId: "smoke-bad", initialWorld: {} }
      });
      const rejectedNotCrashed = malformed.status >= 400 && malformed.status < 500;
      record("S13", "битый initialWorld отвергается 4xx, а не падением 500", rejectedNotCrashed ? "PASS" : "FAIL", `status ${malformed.status}, код ${malformed.body?.error?.code ?? "—"}`);

      const session = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions`, {
        method: "POST",
        headers: { "idempotency-key": "smoke-session" },
        json: { sessionId: "smoke-browser", initialWorld: initialWorld() }
      });
      const credential = session.body?.credential ?? null;
      const started = session.status === 201 && credential !== null;
      record("S14", "игровая сессия стартует на опубликованной миссии", started ? "PASS" : "FAIL", `status ${session.status}, код ${session.body?.error?.code ?? "—"}`);

      if (started) {
        const auth = { authorization: `Bearer ${credential}` };
        const denied = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions/smoke-browser`);
        const view = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions/smoke-browser`, { headers: auth });
        const readOk = view.status === 200 && denied.status === 401;
        record("S15", "состояние хода читается по credential, без него — 401", readOk ? "PASS" : "FAIL", `с credential ${view.status}, без ${denied.status}`);

        // Выбор берётся из авторского документа миссии: смок сам её и составил.
        const choiceId = missionDocument(projectId, questId).story.scenes[0].choices[0].id;
        const turn = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions/smoke-browser/turns`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": "smoke-turn-1" },
          json: { baseTurn: 0, choiceId }
        });
        const target = turn.body?.target ?? null;
        record(
          "S16",
          "ход применяется и приводит к концовке миссии",
          turn.status === 200 && target?.kind === "ending" && target?.endingId === "done" ? "PASS" : "FAIL",
          `ход ${turn.status}, итог ${target?.kind ?? "—"}/${target?.endingId ?? "—"}`
        );

        const stale = await request(`/public/v1/missions/${encodeURIComponent(slug)}/sessions/smoke-browser/turns`, {
          method: "POST",
          headers: { ...auth, "idempotency-key": "smoke-turn-2" },
          json: { baseTurn: 0, choiceId }
        });
        record("S17", "повтор хода с тем же baseTurn отвергается 409", stale.status === 409 ? "PASS" : "FAIL", `status ${stale.status}, код ${stale.body?.error?.code ?? "—"}`);
      } else {
        record("S15", "состояние хода читается по credential, без него — 401", "FAIL", "сессия не стартовала");
        record("S16", "ход применяется и приводит к концовке миссии", "FAIL", "сессия не стартовала");
        record("S17", "повтор хода с тем же baseTurn отвергается 409", "FAIL", "сессия не стартовала");
      }
    }
  } finally {
    await stopServer(server);
  }

  // Перезапуск на той же базе: опубликованное обязано пережить рестарт.
  server = await startServer(databasePath);
  try {
    const after = await request("/public/v1/missions");
    const survived = after.status === 200 && Array.isArray(after.body?.missions) && after.body.missions.length === 1;
    record("S18", "публикация переживает перезапуск сервера", survived ? "PASS" : "FAIL", `status ${after.status}, записей ${after.body?.missions?.length ?? "—"}`);
  } finally {
    await stopServer(server);
  }

  return steps.some((step) => step.status === "FAIL") ? 1 : 0;
};

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  record("SX", "смок-прогон завершился без исключений", "FAIL", String(error?.message ?? error));
  exitCode = 1;
}

const tally = steps.reduce((acc, step) => ({ ...acc, [step.status]: (acc[step.status] ?? 0) + 1 }), {});
const summary = {
  operationId: `smoke-${new Date().toISOString().slice(0, 10)}`,
  ranAtIso: new Date().toISOString(),
  verdict: exitCode === 0 ? "PASS" : "FAIL",
  counts: tally,
  steps
};
try {
  writeFileSync(join(repo, "docs", "worklog", "smoke-receipt.json"), JSON.stringify(summary, null, 2));
} catch {
  /* квитанция — необязательный артефакт */
}
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`SMOKE: ${summary.verdict} — PASS ${tally.PASS ?? 0}, SKIP ${tally.SKIP ?? 0}, FAIL ${tally.FAIL ?? 0}\n`);
process.exit(exitCode);
