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
  let generationMode = "ok";
  const requests = [];
  const chatRequests = [];
  const server = createServer((req, res) => {
    const isChat = typeof req.url === "string" && req.url.includes("/chat/completions");
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null, isChat });
    if (isChat) {
      // Тело запроса генерации нужен целиком: проверка связи обязана просить
      // столько вывода, чтобы модель с размышлениями успела ответить.
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => { try { chatRequests.push(JSON.parse(raw)); } catch { chatRequests.push(raw); } });
    }
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
    if (isChat) {
      // Генерация: «hang» — провайдер отвечает на список моделей, но не генерирует.
      if (generationMode === "hang") return;
      if (generationMode === "empty") {
        res.end(JSON.stringify({ id: "gen-empty", choices: [{ finish_reason: "length", message: { content: "" } }] }));
        return;
      }
      res.end(JSON.stringify({
        id: "gen-1",
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }));
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
    chatRequests,
    setMode: (value) => { mode = value; },
    getMode: () => mode,
    setGenerationMode: (value) => { generationMode = value; },
    getGenerationMode: () => generationMode
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
    // Проверка обязана просить реальный запас вывода: с 24 токенами модель с
    // размышлениями возвращает пустой ответ при рабочем ключе (замер на стенде).
    const probeBody = stand.chatRequests.at(-1);
    assert.ok(probeBody.max_tokens >= 128, `проверка просит слишком мало вывода: ${probeBody.max_tokens}`);

    // 5a. Проверка не ограничивается списком моделей: провайдер отвечает, но
    //     модель не договорила (finish_reason=length: лимит вывода ушёл на
    //     размышления) — это отдельная причина, а не «подключение работает» и не
    //     «нечитаемый ответ». Проверка обязана назвать обрыв обрывом.
    stand.setGenerationMode("empty");
    const empties = remember(await probe());
    assert.equal(empties.body.state, "error");
    assert.equal(empties.body.probeCause, "generation_truncated");
    assert.equal(empties.body.lastErrorCode, "generation_truncated");

    // 5b. Провайдер отвечает на список моделей, но не успевает сгенерировать
    //     ответ: причина — тайм-аут генерации, а не «неверный ключ».
    stand.setGenerationMode("hang");
    const quick = new LocalAuthorProvider(undefined, { connections, scope }, { generationProbeTimeoutMs: 250 });
    quick.configure({ preset: "compatible", baseUrl, model: "model-1", credential: FIXTURE_KEY }, { persist: false });
    const quickState = await quick.probe();
    assert.equal(quickState, "error");
    assert.equal(quick.status().probeCause, "generation_timeout");
    assert.equal(quick.status().connectionCheck, "error");
    stand.setGenerationMode("ok");

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

test("L03-подключение: пресет token-juice принимается, адрес и модель подставляются", async () => {
  const stand = providerStand();
  const standPort = await listen(stand.server);
  const baseUrl = `http://127.0.0.1:${standPort}/v1`;
  const scope = { projectId: "local-operator", userId: "local-owner" };
  const connections = new MemoryControlProviderConnectionStore();
  const provider = new LocalAuthorProvider(undefined, { connections, scope });
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1", authorProvider: provider });
  const port = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  const jsonHeaders = { "content-type": "application/json", "x-lh-local-settings": "1" };
  const configure = (body) => request(port, "/local/author-provider", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  const bodies = [];
  const remember = (value) => { bodies.push(JSON.stringify(value)); return value; };

  try {
    // 1. Пресет token-juice без своего адреса: берётся адрес пресета, не пустая строка.
    const saved = remember(await configure({ preset: "token-juice", baseUrl: "", model: "deepseek-ai/DeepSeek-V4.1-Flash", credential: FIXTURE_KEY }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, "settings_saved");
    assert.equal(saved.body.settings.preset, "token-juice");
    assert.equal(saved.body.settings.baseUrl, "https://api.tokenjuice.ai/v1");
    assert.equal(saved.body.settings.model, "deepseek-ai/DeepSeek-V4.1-Flash");
    assert.equal(saved.body.hasCredential, true);

    // 2. Свой адрес того же шлюза уважается, ключ при смене адреса не теряется.
    const custom = remember(await configure({ preset: "token-juice", baseUrl, model: "deepseek-ai/DeepSeek-V4.1-Flash", credential: "" }));
    assert.equal(custom.status, 200);
    assert.equal(custom.body.settings.baseUrl, baseUrl);
    assert.equal(custom.body.hasCredential, true, "ключ остался сохранённым");

    // 3. Неизвестный пресет отклоняется: перечень — из движка, а не «что угодно».
    const unknown = remember(await configure({ preset: "no-such-provider", baseUrl, model: "model-1", credential: FIXTURE_KEY }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "INVALID_SETTINGS");

    // 4. Проверка подключения на адресе token-juice работает и не раскрывает ключ.
    const probed = remember(await request(port, "/local/author-provider/probe", { method: "POST", headers: jsonHeaders }));
    assert.equal(probed.body.state, "connected");
    assert.equal(probed.body.probeHttpStatus, 200);

    // 5. Подключение переживает перезапуск: пресет и адрес восстанавливаются.
    await settle(6);
    const restarted = new LocalAuthorProvider(undefined, { connections, scope });
    await restarted.restore();
    const restored = restarted.status();
    assert.equal(restored.configured, true);
    assert.equal(restored.settings.preset, "token-juice");
    assert.equal(restored.settings.baseUrl, baseUrl);
    assert.equal(restored.hasCredential, true);

    // 6. Ни один ответ не раскрыл полный ключ.
    for (const body of bodies) assert.equal(body.includes(FIXTURE_KEY), false, "полный ключ не должен попадать в ответы");
  } finally {
    await studio.close();
    await close(stand.server);
  }
});

test("L03-подключение: после перезапуска сохранение не теряется из-за повторного номера попытки", async () => {
  const stand = providerStand();
  const standPort = await listen(stand.server);
  const baseUrl = `http://127.0.0.1:${standPort}/v1`;
  const scope = { projectId: "local-operator", userId: "local-owner" };
  const connections = new MemoryControlProviderConnectionStore();

  try {
    // Первый запуск: две правки подряд — вторая занимает номер попытки 2.
    const first = new LocalAuthorProvider(undefined, { connections, scope });
    first.configure({ preset: "compatible", baseUrl, model: "model-1", credential: FIXTURE_KEY });
    await settle(8);
    first.configure({ preset: "compatible", baseUrl, model: "model-2", credential: "" });
    await settle(8);
    assert.equal(first.status().credentialStorage, "local_file_masked");

    // Перезапуск: номер попытки снова начинается с 1, и та же цифра не должна
    // столкнуться с ключом прошлого запуска — иначе сохранение молча не ляжет.
    const second = new LocalAuthorProvider(undefined, { connections, scope });
    await second.restore();
    second.configure({ preset: "token-juice", baseUrl: "", model: "deepseek-ai/DeepSeek-V4.1-Flash", credential: FIXTURE_KEY_2 });
    await settle(8);
    assert.equal(second.status().credentialStorage, "local_file_masked", "после перезапуска сохранение обязано лечь в хранилище");

    const stored = await connections.getConnection(scope.projectId, scope.userId);
    assert.equal(stored.providerPreset, "token-juice");
    assert.equal(stored.model, "deepseek-ai/DeepSeek-V4.1-Flash");
    assert.equal(stored.baseUrl, "https://api.tokenjuice.ai/v1");
    assert.equal(stored.revision >= 3, true, `ревизия растёт, а не откатывается: ${stored.revision}`);
  } finally {
    await close(stand.server);
  }
});
