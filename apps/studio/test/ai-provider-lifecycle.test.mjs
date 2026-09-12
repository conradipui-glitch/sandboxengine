/*
 * Живой цикл подключения ИИ-помощника через настоящие маршруты Studio.
 *
 * Поднимается реальный Studio dev-server и локальный стенд-провайдер (только
 * фиктивные значения, реальных ключей нет). Проверяется то, что ломалось на
 * живом стенде:
 *
 *  1) ключ сохраняется, и повторное сохранение БЕЗ ключа его не теряет;
 *  2) сохранённое подключение переживает перезапуск процесса (restore);
 *  3) «Проверить подключение» отвечает по причине: неверный адрес, нет ключа,
 *     ключ отклонён, лимит, медленный ответ, нет сети, нечитаемый ответ;
 *  4) «Получить список моделей» возвращает модели провайдера либо честную причину;
 *  5) полный ключ не попадает ни в один ответ.
 *
 * Запуск (после сборки dist): node --test apps/studio/test/ai-provider-lifecycle.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { MemoryControlProviderConnectionStore } from "../../../packages/control/dist/index.js";
import { LocalAuthorProvider } from "../dist/src/local-author-provider.js";
import { createStudioDevServer } from "../dist/src/dev-server.js";

const FIXTURE_KEY = "sk-test-0000000000000000-fixture";
const FIXTURE_KEY_2 = "sk-test-1111111111111111-fixture";

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body: responseBody.length === 0 ? null : JSON.parse(responseBody)
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(typeof address, "string");
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
  const probe = createServer(() => {});
  const port = await listen(probe);
  await close(probe);
  return port;
}

const settle = async (times = 4) => {
  for (let step = 0; step < times; step += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Стенд-провайдер: отдаёт список моделей, умеет отказывать и «висеть». */
function providerStand() {
  let mode = "ok";
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (mode === "hang") return; // намеренно не отвечаем: проверяется медленный ответ
    res.setHeader("content-type", "application/json");
    if (mode === "unauthorized") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    if (mode === "rate") {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: "too many" } }));
      return;
    }
    if (mode === "server_error") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    if (mode === "garbage") {
      res.end("<html>not json</html>");
      return;
    }
    res.end(JSON.stringify({
      data: [
        { id: "qwen/qwen3-32b", name: "Qwen3 32B" },
        { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
        { id: "openai/gpt-4o-mini", name: "дубль" },
        { id: 42, name: "мусор" },
        { id: "", name: "пусто" }
      ]
    }));
  });
  return {
    server,
    requests,
    setMode: (value) => { mode = value; },
    getMode: () => mode
  };
}

test("L03-подключение: ключ сохраняется, переживает перезапуск, причины проверки разбираются", async () => {
  const stand = providerStand();
  const standPort = await listen(stand.server);
  const baseUrl = `http://127.0.0.1:${standPort}/v1`;
  const scope = { projectId: "local-operator", userId: "local-owner" };
  const connections = new MemoryControlProviderConnectionStore();
  const provider = new LocalAuthorProvider(undefined, { connections, scope });
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1", authorProvider: provider });
  const port = await studio.listen(0, "127.0.0.1").then((value) => value.port);

  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };
  const statusRead = () => request(port, "/local/author-provider");
  const configure = (body, headers = jsonHeaders) => request(port, "/local/author-provider", { method: "POST", headers, body: JSON.stringify(body) });
  const probe = () => request(port, "/local/author-provider/probe", { method: "POST", headers: jsonHeaders });
  const models = () => request(port, "/local/author-provider/models", { method: "POST", headers: jsonHeaders });
  const bodies = [];
  const remember = (value) => { bodies.push(JSON.stringify(value)); return value; };

  try {
    // 1. До настройки: честное «не настроено», никаких выдуманных полей.
    const initial = remember(await statusRead());
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.hasCredential, false);
    assert.equal(initial.body.probeCause, null);
    assert.equal(initial.body.state, "not_configured");

    // 2. Первое сохранение без ключа — понятный код, а не «не удалось сохранить».
    const noKey = remember(await configure({ preset: "compatible", baseUrl, model: "model-1", credential: "" }));
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "CREDENTIAL_REQUIRED");

    // 3. Сохранение с ключом: настройки видны, ключ — только маской.
    const saved = remember(await configure({ preset: "compatible", baseUrl, model: "model-1", credential: FIXTURE_KEY }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, "settings_saved");
    assert.equal(saved.body.settings.model, "model-1");
    assert.equal(saved.body.settings.baseUrl, baseUrl);
    assert.equal(saved.body.hasCredential, true);
    assert.match(saved.body.credentialMask, /^sk-…/);
    assert.equal(JSON.stringify(saved.body).includes(FIXTURE_KEY), false);

    // 4. Повторное сохранение БЕЗ ключа: ключ не теряется (главная жалоба владельца).
    const rotated = remember(await configure({ preset: "compatible", baseUrl, model: "model-2", credential: "" }));
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.settings.model, "model-2");
    assert.equal(rotated.body.hasCredential, true, "ключ остался сохранённым");
    assert.equal(rotated.body.credentialMask, saved.body.credentialMask);

    // 5. Проверка подключения: провайдер отвечает — «подключено» с задержкой.
    stand.setMode("ok");
    const connected = remember(await probe());
    assert.equal(connected.body.state, "connected");
    assert.equal(connected.body.probeCause, "connected");
    assert.equal(connected.body.probeHttpStatus, 200);
    assert.equal(typeof connected.body.probeLatencyMs, "number");

    // 6. Провайдер отклонил ключ — это названо причиной, а не тайм-аутом.
    stand.setMode("unauthorized");
    const refused = remember(await probe());
    assert.equal(refused.body.state, "error");
    assert.equal(refused.body.probeCause, "auth_required");
    assert.equal(refused.body.lastErrorCode, "auth_required");
    assert.equal(refused.body.probeHttpStatus, 401);

    // 7. Лимит запросов — своя причина.
    stand.setMode("rate");
    const limited = remember(await probe());
    assert.equal(limited.body.probeCause, "rate_limited");
    assert.equal(limited.body.probeHttpStatus, 429);

    // 8. Провайдер вернул нечитаемый ответ — своя причина.
    stand.setMode("garbage");
    const garbage = remember(await probe());
    assert.equal(garbage.body.probeCause, "invalid_response");

    // 9. Ошибка провайдера (5xx) — своя причина.
    stand.setMode("server_error");
    const serverError = remember(await probe());
    assert.equal(serverError.body.probeCause, "backend_error");
    assert.equal(serverError.body.probeHttpStatus, 500);

    // 10. Неверный базовый адрес: сохранение отказано своей причиной, а прежнее
    //     рабочее подключение остаётся нетронутым (в сеть при этом не ходили).
    const requestsBeforeInvalid = stand.requests.length;
    const invalid = remember(await configure({ preset: "compatible", baseUrl: "not-a-url", model: "model-1", credential: "" }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_BASE_URL");
    assert.equal(stand.requests.length, requestsBeforeInvalid, "при неверном адресе в сеть не ходим");
    const stillSaved = remember(await statusRead());
    assert.equal(stillSaved.body.settings.baseUrl, baseUrl);
    assert.equal(stillSaved.body.settings.model, "model-2");
    assert.equal(stillSaved.body.hasCredential, true);

    // 11. Нет сети (закрытый порт) — «не удалось связаться», а не тайм-аут.
    const deadPort = await freePort();
    await configure({ preset: "compatible", baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: "model-1", credential: "" });
    const offline = remember(await probe());
    assert.equal(offline.body.probeCause, "network");
    assert.equal(offline.body.probeHttpStatus, null);

    // 12. Медленный ответ: провайдер молчит — причина «slow_timeout» (тайм-аут разобран).
    await configure({ preset: "compatible", baseUrl, model: "model-1", credential: "" });
    stand.setMode("hang");
    await provider.probe({ timeoutMs: 150 });
    const hanging = provider.status();
    assert.equal(hanging.probeCause, "slow_timeout");
    assert.equal(hanging.state, "error");
    assert.equal(hanging.lastErrorCode, "timeout");
    stand.setMode("ok");

    // 13. Список моделей провайдера: получили идентификаторы, дубли и мусор отброшены.
    const list = remember(await models());
    assert.equal(list.status, 200);
    assert.equal(list.body.kind, "ok");
    assert.deepEqual(list.body.models.map((model) => model.id), ["openai/gpt-4o-mini", "qwen/qwen3-32b"]);
    assert.equal(list.body.models[0].name, "GPT-4o mini");
    assert.equal(JSON.stringify(list.body).includes(FIXTURE_KEY), false);

    // 14. Список моделей при отказе ключа — честная причина.
    stand.setMode("unauthorized");
    const listRefused = remember(await models());
    assert.equal(listRefused.body.kind, "error");
    assert.equal(listRefused.body.cause, "auth_required");
    stand.setMode("ok");

    // 15. Медленный ответ и в списке моделей — тайм-аут не прячется.
    stand.setMode("hang");
    const hangingList = await provider.listModels({ timeoutMs: 150 });
    assert.equal(hangingList.kind, "error");
    assert.equal(hangingList.cause, "slow_timeout");
    stand.setMode("ok");

    // 16. Без сохранённого подключения список моделей честно говорит «не настроено».
    provider.disconnect();
    await settle(4);
    const listWithoutProvider = remember(await models());
    assert.equal(listWithoutProvider.status, 200);
    assert.equal(listWithoutProvider.body.kind, "error");
    assert.equal(listWithoutProvider.body.cause, "not_configured");
    assert.deepEqual(listWithoutProvider.body.models, []);

    // 17. Настраиваем заново и перезапускаем процесс: подключение и ключ
    //     восстанавливаются из хранилища (для автора — перезагрузка страницы
    //     снова показывает то, что сохранено).
    const again = remember(await configure({ preset: "compatible", baseUrl, model: "model-1", credential: FIXTURE_KEY }));
    assert.equal(again.status, 200);
    const maskAgain = again.body.credentialMask;
    await settle(6);
    const restarted = new LocalAuthorProvider(undefined, { connections, scope });
    await restarted.restore();
    const restored = remember(restarted.status());
    assert.equal(restored.configured, true);
    assert.equal(restored.hasCredential, true);
    assert.equal(restored.settings.baseUrl, baseUrl);
    assert.equal(restored.settings.model, "model-1");
    assert.equal(restored.credentialMask, maskAgain);
    assert.equal((await restarted.probe({ timeoutMs: 1_000 })), "connected");

    // 18. Явное отключение стирает ключ: следующая проверка честно просит ключ.
    restarted.disconnect();
    await settle(4);
    const afterDisconnect = remember(restarted.status());
    assert.equal(afterDisconnect.configured, false);
    assert.equal(afterDisconnect.hasCredential, false);
    assert.equal((await restarted.probe()), "not_configured");
    assert.equal(restarted.status().probeCause, null);

    // 19. Ни один ответ маршрутов не раскрыл полный ключ.
    for (const body of bodies) {
      assert.equal(body.includes(FIXTURE_KEY), false, "полный ключ не должен попадать в ответы");
      assert.equal(body.includes(FIXTURE_KEY_2), false);
    }
    assert.equal(stand.requests.length > 0, true, "стенд-провайдер действительно получал запросы");
    assert.equal(stand.requests.every((entry) => entry.authorization === `Bearer ${FIXTURE_KEY}`), true, "ключ уходит только в заголовке Authorization");
  } finally {
    await studio.close();
    await close(stand.server);
  }
});
