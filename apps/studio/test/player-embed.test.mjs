import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../../server/dist/control-server.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { ControlApiClient } from "../dist/src/api.js";
import { RuntimePlayerClient } from "../../../packages/player/dist/index.js";
import { closeAllPlayers, launchFrozenPlayer } from "../../../apps/player/dist/src/launch.js";
import {
  PLAYER_EMBED_PATH,
  isInternalPlayerAddress,
  isSameOriginEmbedPath,
  resolvePlayerTarget
} from "../dist/src/player-embed.js";

// PLAYER ZONE. Раньше кнопка «Проверить и сыграть» отдавала автору внутренний
// loopback-адрес плеера (http://127.0.0.1:<port>), недоступный снаружи: проверка
// миссии из админки фактически не работала. Теперь Studio встраивает Player на
// своём origin по маршруту /player и проксирует служебные пути плеера, а
// внутренний адрес в интерфейс не попадает.

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed = null;
        const contentType = response.headers["content-type"] ?? "";
        if (text.length > 0 && /application\/json/.test(contentType)) parsed = JSON.parse(text);
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Мини-плеер: страница шелла, её ассеты, метаданные и runtime-сессия. */
function stubPlayer() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(String(req.url ?? "/"), "http://player.local");
    hits.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<!doctype html><html lang="ru"><head><link rel="stylesheet" href="/player-assets/styles.css"><script type="module" src="/player-assets/app.js"></script></head><body><main id="app"></main></body></html>');
      return;
    }
    if (url.pathname === "/player-assets/app.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end('console.log("player app");');
      return;
    }
    if (url.pathname === "/player-meta.json") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ playtestId: "playtest-embed" }));
      return;
    }
    if (url.pathname === "/v1/sessions" && req.method === "POST") {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ sessionId: "session-1" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return { server, hits };
}

test("PLAYER: проверка миссии открывается внутри Studio на том же origin, внутренний порт наружу не отдаётся", async () => {
  const store = new MemoryControlStore();
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const player = stubPlayer();
  const playerAddress = await new Promise((resolve) => {
    player.server.listen(0, "127.0.0.1", () => resolve(player.server.address()));
  });
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
    playerLauncher: async (playtestId) => ({ ok: true, url: `http://127.0.0.1:${playerAddress.port}`, playtestId })
  });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };

  try {
    // Плеер ещё не запущен: честный текст вместо страницы и вместо чужого адреса.
    const notRunning = await request(studioAddress.port, PLAYER_EMBED_PATH);
    assert.equal(notRunning.status, 409);
    assert.match(notRunning.text, /Плеер не запущен/);
    assert.equal((await request(studioAddress.port, "/player-assets/app.js")).status, 404);

    const launched = await request(studioAddress.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: "playtest-embed" })
    });
    assert.equal(launched.status, 200);
    assert.equal(launched.body.ok, true);
    // Ссылка проверки — same-origin маршрут Studio, без хоста и порта плеера.
    assert.equal(launched.body.embedPath, PLAYER_EMBED_PATH);
    assert.equal(isSameOriginEmbedPath(launched.body.embedPath), true);
    assert.equal(launched.body.embedPath.includes("127.0.0.1"), false);
    assert.equal(launched.body.embedPath.includes(String(playerAddress.port)), false);

    // Страница плеера отдаётся с origin Studio и не выдаёт внутренний адрес.
    const page = await request(studioAddress.port, PLAYER_EMBED_PATH);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.text, /\/player-assets\/app\.js/);
    assert.equal(page.text.includes("127.0.0.1"), false);
    assert.equal(page.text.includes(String(playerAddress.port)), false);

    const asset = await request(studioAddress.port, "/player-assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"], /javascript/);
    assert.equal(asset.text, 'console.log("player app");');

    const meta = await request(studioAddress.port, "/player-meta.json");
    assert.equal(meta.status, 200);
    assert.equal(meta.body.playtestId, "playtest-embed");

    // Runtime-запросы плеера тоже идут через тот же origin Studio.
    const session = await request(studioAddress.port, "/v1/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: "playtest-embed" })
    });
    assert.equal(session.status, 201);
    assert.equal(session.body.sessionId, "session-1");
    assert.ok(player.hits.includes("POST /v1/sessions"));

    // Права: чужой origin и публичный Host до плеера не доходят.
    assert.equal((await request(studioAddress.port, "/player-assets/app.js", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(studioAddress.port, PLAYER_EMBED_PATH, { headers: { host: "studio.example" } })).status, 403);
  } finally {
    await studio.close();
    await control.close();
    await new Promise((resolve) => player.server.close(resolve));
  }
});

test("PLAYER: контракт адреса не пропускает loopback-порт, а интерфейс встраивает проверку same-origin", async () => {
  // Контракт «что можно показать автору».
  assert.equal(resolvePlayerTarget({ embedPath: PLAYER_EMBED_PATH, url: "http://127.0.0.1:8745" }), PLAYER_EMBED_PATH);
  assert.equal(resolvePlayerTarget({ url: "http://127.0.0.1:8745" }), null);
  assert.equal(resolvePlayerTarget({ embedPath: "http://127.0.0.1:8745/player", url: "http://127.0.0.1:8745" }), null);
  assert.equal(resolvePlayerTarget({ embedPath: "//evil.example/player", url: "http://127.0.0.1:8745" }), null);
  assert.equal(resolvePlayerTarget({ url: "https://play.example/p/pt-1" }), "https://play.example/p/pt-1");
  assert.equal(resolvePlayerTarget({}), null);
  assert.equal(isInternalPlayerAddress("http://127.0.0.1:8745"), true);
  assert.equal(isInternalPlayerAddress("http://localhost:4180"), true);
  assert.equal(isInternalPlayerAddress("https://play.example"), false);
  assert.equal(isSameOriginEmbedPath(PLAYER_EMBED_PATH), true);
  assert.equal(isSameOriginEmbedPath("/player?x=1"), false);

  // Интерфейс: адрес не рисуется текстом, проверка встроена на том же origin.
  const app = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.equal(app.includes("escapeHtml(options.playerUrl)"), false, "адрес плеера не выводится как текст ссылки");
  assert.equal(/Player запущен: \$\{/.test(app), false, "адрес не подставляется в статус Studio");
  assert.ok(app.includes("resolvePlayerTarget"), "интерфейс использует общий контракт адреса");
  assert.ok(app.includes("data-player-embed"), "проверка миссии встраивается в Studio");
  assert.ok(
    /<iframe class="player-embed-frame" src="\$\{href\}"/.test(app),
    "iframe проверки ссылается на same-origin маршрут Studio"
  );

  // Ошибки остаются честным текстом, а не адресом или пустым экраном.
  assert.ok(/data-error-slot data-error-code="player-launch"/.test(app));
  assert.ok(app.includes("Studio не получила адрес для проверки"));
  assert.ok(app.includes("Frozen playtest не найден на сервере. Создайте playtest заново."));

  // Прокси живёт на стороне Studio и гейтится локальным операторским барьером.
  const devServer = await readFile(new URL("../src/dev-server.ts", import.meta.url), "utf8");
  assert.ok(/loopbackPlayerOrigin\(outcome\.url\)/.test(devServer), "прокси принимает только loopback-origin плеера");
  assert.ok(/isLocalProxyRequest\(request\)/.test(devServer), "прокси плеера проверяет права запроса");
  assert.ok(/PLAYER_EMBED_PATH/.test(devServer), "маршрут проверки берётся из общего модуля");
});

test("PLAYER: реальный frozen playtest играется через маршрут Studio, а не через внутренний порт", async () => {
  const directory = await mkdtemp(join(tmpdir(), "living-history-player-embed-"));
  const databasePath = join(directory, "living-history.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  const control = createControlHttpServer({ store });
  const controlAddress = await control.listen(0, "127.0.0.1");
  let playerOrigin = "";
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
    playerLauncher: async (playtestId) => {
      const launched = await launchFrozenPlayer({ databasePath, playtestId });
      if (!launched.ok) return { ok: false, code: launched.code, message: launched.message };
      playerOrigin = launched.url;
      return { ok: true, url: launched.url, playtestId: launched.playtestId };
    }
  });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };
  const location = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "Стена ждёт краски", data: {} };
  const resource = { schemaVersion: "1.0", id: "blue-paint", kind: "core.resource", title: "Синяя краска", description: "", data: { unit: "порция", initialValue: 6, min: 0, max: 20 } };
  const action = { schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Красить стену", description: "", data: { actionType: "core.paint", resourceId: "blue-paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 60, allowPartial: true } };

  try {
    await api.createProject({ projectId: "player-embed", title: "Проверка встраивания" });
    const draft = await api.createQuest({
      projectId: "player-embed", questId: "quest", title: "Мастерская", entryLocationId: "workshop",
      initialBlocks: [location, resource, action]
    });
    const validation = await api.validateDraft("player-embed", "quest", draft.draftRevision);
    assert.equal(validation.status, "valid");
    const playtest = await api.createPlaytest("player-embed", "quest", draft.draftRevision, validation.validationId);

    const launched = await request(studioAddress.port, "/local/launch-player", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ playtestId: playtest.playtestId })
    });
    assert.equal(launched.status, 200);
    assert.equal(launched.body.embedPath, PLAYER_EMBED_PATH);
    assert.match(playerOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(playerOrigin, origin);

    // Реальная страница и модули Player отдаются с origin Studio.
    const page = await request(studioAddress.port, PLAYER_EMBED_PATH);
    assert.equal(page.status, 200);
    assert.match(page.text, /\/player-assets\/app\.js/);
    assert.equal(page.text.includes(playerOrigin.replace("http://", "")), false, "внутренний host:port не попадает в страницу");
    for (const path of ["/player-assets/app.js", "/player-assets/styles.css", "/player-lib/client.js", "/contracts-lib/index.js", "/player-meta.json"]) {
      const response = await request(studioAddress.port, path);
      assert.equal(response.status, 200, `${path} обязан отдаваться через Studio`);
    }
    const meta = await request(studioAddress.port, "/player-meta.json");
    assert.equal(meta.body.playtestId, playtest.playtestId);

    // Игра действительно играется: сессия runtime открывается через same-origin адрес Studio.
    const client = new RuntimePlayerClient(origin);
    const session = await client.createSession(`playtest-${playtest.playtestId}`);
    assert.ok(session.sessionId);
    const painted = await client.paint(session, 1, "player-embed-paint-1");
    assert.equal(painted.action.status, "executed");
  } finally {
    await closeAllPlayers();
    await studio.close();
    await control.close();
    store.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
