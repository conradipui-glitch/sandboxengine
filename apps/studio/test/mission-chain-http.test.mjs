import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createStudioDevServer } from "../dist/src/dev-server.js";
import { MissionChainDialogStore } from "../dist/src/mission-chain-dialogs.js";
import { ModelProviderAgentBackend } from "@living-history/ai";

/*
 * AI-CHAIN: HTTP-контракт /local/mission-chain на живом Studio-сервере.
 *
 * Многошаговый сценарий с mock-провайдером (OpenAI-совместимый stub):
 *   старт диалога → ответ 1 → ответ 2 → цепочка готова → подтверждение →
 *   документ миссии получен. Плюс честные ошибки: сбой провайдера, отмена.
 *
 * Локальная граница: запросы обязаны идти с Host, совпадающим с портом
 * процесса (isAllowedLocalHttpRequest), и с заголовком content-type json.
 */

const QUESTION_1 = JSON.stringify({ kind: "question", text: "Что должен чувствовать игрок?" });
const QUESTION_2 = JSON.stringify({ kind: "question", text: "Чем готов пожертвовать автор?" });
const CHAIN_JSON = JSON.stringify({
  kind: "chain",
  ideaRestated: "Маяк в шторме, выбор смотрителя.",
  genre: "драма",
  durationMinutes: 15,
  constraints: [],
  narrative: "Шторм. Одна дорога света. Смотритель решает, кто увидит свет. Цена названа заранее.",
  chain: {
    scenes: [
      { id: "storm", title: "Шторм", goal: "Кого светить" },
      { id: "port", title: "Порт", goal: "Удержать гавань" },
      { id: "boat", title: "Бот", goal: "Довести бот" }
    ],
    choices: [
      { from: "storm", label: "Свет в порт", to: "port", consequence: "Бот темнит" },
      { from: "storm", label: "Свет на бот", to: "boat", consequence: "Порт без света" },
      { from: "port", label: "Держать вход", to: "ending-safe", consequence: "Порт цел" },
      { from: "port", label: "Отойти", to: "ending-loss", consequence: "Порт повреждён" },
      { from: "boat", label: "На берег", to: "ending-loss", consequence: "Груз потерян" },
      { from: "boat", label: "В гавань", to: "ending-safe", consequence: "Время потеряно" }
    ],
    resources: [{ id: "oil", title: "Масло", initial: 6, purpose: "Свет маяка" }],
    endings: [
      { id: "ending-safe", title: "Тихая гавань", condition: "Вход удержан" },
      { id: "ending-loss", title: "Цена шторма", condition: "Свет отдан не тому" }
    ]
  }
});

/** Полный валидный план миссии — то, что mission-writer соберёт из ответа модели. */
function fullPlan() {
  return {
    listing: {
      title: "Маяк на краю ночи",
      slogan: "Свет стоит дороже масла",
      summary: "Смотритель выбирает, кому светить в шторм.",
      period: "1889",
      place: "Северный мыс",
      playerRole: "Смотритель маяка"
    },
    start: {
      locations: [{ id: "lighthouse", title: "Маяк" }],
      resources: [{ id: "oil", title: "Масло", initial: 6 }],
      characters: [{ id: "keeper", name: "Смотритель" }]
    },
    branches: [
      {
        id: "duty",
        title: "Долг",
        scenes: [
          {
            id: "s-open",
            title: "Шторм",
            text: "Волны бьют в стекло.",
            choices: [
              { label: "Держать вход", target: { kind: "ending", id: "e-duty" } },
              { label: "Свет на бот", target: { kind: "ending", id: "e-mercy" } }
            ]
          }
        ],
        ending: { id: "e-duty", title: "Долг исполнен", text: "Порт спасён." }
      },
      {
        id: "mercy",
        title: "Милосердие",
        scenes: [
          {
            id: "s-boat",
            title: "Бот",
            text: "Бот идёт к берегу.",
            choices: [{ label: "Довести бот", target: { kind: "ending", id: "e-mercy" } }]
          }
        ],
        ending: { id: "e-mercy", title: "Бот спасён", text: "Рыбаки живы." }
      }
    ]
  };
}

/** Очередь ответов модели: каждый POST /chat/completions берёт следующий. */
function modelStub(queue) {
  const seen = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      const next = queue.shift();
      res.setHeader("content-type", "application/json");
      if (next === undefined) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: "stub exhausted" } }));
        return;
      }
      if (next.kind === "http_error") {
        res.statusCode = next.status;
        res.end(JSON.stringify({ error: { message: next.message } }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        id: `stub-${seen.length}`,
        choices: [{ message: { role: "assistant", content: next.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      }));
    });
  });
  return { stub, seen };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

/** Локальный операторский запрос: Host обязан совпадать с портом Studio. */
function post(studioPort, path, body) {
  return fetch(`http://127.0.0.1:${studioPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lh-local-settings": "1" },
    body: JSON.stringify(body)
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}

async function bootStudio(queue) {
  const { stub, seen } = modelStub(queue);
  const stubPort = await listen(stub);
  const backend = new ModelProviderAgentBackend();
  backend.configure({
    async generate(request) {
      const response = await fetch(`http://127.0.0.1:${stubPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": "Bearer stub-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "stub-model",
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          response_format: { type: "json_object" }
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          error: { code: "http", message: `HTTP ${response.status}`, retryable: response.status >= 500, httpStatus: response.status, providerRequestId: null },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null }
        };
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return {
          ok: false,
          error: { code: "invalid_response", message: "no content", retryable: false, httpStatus: response.status, providerRequestId: null },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null }
        };
      }
      let value;
      try { value = JSON.parse(content); } catch {
        return {
          ok: false,
          error: { code: "invalid_response", message: "bad json", retryable: false, httpStatus: response.status, providerRequestId: null },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null }
        };
      }
      return {
        ok: true,
        output: { format: "json_object", value },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        providerRequestId: `stub-${stubPort}`
      };
    }
  }, "stub-model");
  const dialogs = new MissionChainDialogStore({ backend, profileId: "chain-http-profile" });
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:1`,
    missionChainDialogs: dialogs
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  return {
    studioPort,
    seen,
    dialogs,
    close: async () => {
      await studio.close();
      stub.close();
    }
  };
}

test("AI-CHAIN HTTP: многошаговый диалог — старт, два ответа, цепочка, подтверждение, документ", async () => {
  const env = await bootStudio([
    { content: QUESTION_1 },
    { content: QUESTION_2 },
    { content: CHAIN_JSON },
    // Подтверждение: mission-writer делает 1 ход с планом.
    { content: JSON.stringify(fullPlan()) }
  ]);
  const { studioPort, close } = env;
  try {
    // Старт: первый вопрос.
    const started = await post(studioPort, "/local/mission-chain", {
      idea: "Смотритель маяка выбирает, кому светить.",
      projectId: "p-chain",
      questId: "q-chain"
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.stage, "interview");
    assert.equal(started.body.questionsAnswered, 1);
    assert.equal(started.body.messages.length, 2, "идея автора + первый вопрос");
    const sessionId = started.body.sessionId;
    assert.match(sessionId, /^chain-/);

    // Ответ 1: второй вопрос.
    const turn1 = await post(studioPort, "/local/mission-chain", { sessionId, text: "Тревогу и ответственность." });
    assert.equal(turn1.body.stage, "interview");
    assert.equal(turn1.body.questionsAnswered, 2);
    assert.equal(turn1.body.messages.length, 4);

    // Ответ 2: цепочка готова — показана автору.
    const turn2 = await post(studioPort, "/local/mission-chain", { sessionId, text: "Готов жертвовать маслом." });
    assert.equal(turn2.body.stage, "chain_ready");
    assert.ok(turn2.body.summary !== null);
    assert.match(turn2.body.messages.at(-1).text, /Собрана цепочка:/);
    assert.match(turn2.body.messages.at(-1).text, /Нарратив:/);
    assert.equal(turn2.body.summary.chain.scenes.length, 3);
    assert.equal(turn2.body.summary.chain.endings.length, 2);

    // Подтверждение: генерация миссии штатным mission-writer.
    const confirmed = await post(studioPort, "/local/mission-chain", { sessionId });
    assert.equal(confirmed.body.stage, "ready");
    assert.ok(confirmed.body.stats !== null);
    assert.ok(confirmed.body.stats.sceneCount >= 2);
    assert.ok(confirmed.body.stats.endingCount >= 2);

    // Документ доступен клиенту для CAS-сохранения.
    const doc = await post(studioPort, "/local/mission-chain/document", { sessionId });
    assert.equal(doc.status, 200);
    assert.equal(doc.body.ok, true);
    assert.equal(doc.body.document.listing.title, "Маяк на краю ночи");
    assert.ok(doc.body.document.story.scenes.length >= 2);

    // Отмена: сессия снимается.
    const cancel = await post(studioPort, "/local/mission-chain/cancel", { sessionId });
    assert.equal(cancel.status, 200);
    const afterCancel = await post(studioPort, "/local/mission-chain/document", { sessionId });
    assert.equal(afterCancel.body.ok, false);
  } finally {
    await close();
  }
});

test("AI-CHAIN HTTP: честная ошибка при сбое провайдера — stage failed, message по-русски", async () => {
  const env = await bootStudio([
    { kind: "http_error", status: 500, message: "boom" },
    { kind: "http_error", status: 500, message: "boom" }
  ]);
  const { studioPort, close } = env;
  try {
    const started = await post(studioPort, "/local/mission-chain", {
      idea: "Идея для сбоя",
      projectId: "p-chain",
      questId: "q-chain"
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.stage, "failed");
    assert.equal(started.body.sessionId, "");
    assert.ok(started.body.error !== null);
    assert.match(started.body.error.message, /Помощник недоступен|не ответил|подключение/i);
  } finally {
    await close();
  }
});

test("AI-CHAIN HTTP: битый JSON ответа модели — invalid_response, повтор хода возможен", async () => {
  // Модель отдаёт валидный JSON, но не по контракту (нет kind).
  const env = await bootStudio([
    { content: JSON.stringify({ say: "привет" }) },
    { content: JSON.stringify({ say: "привет" }) }
  ]);
  const { studioPort, close } = env;
  try {
    const started = await post(studioPort, "/local/mission-chain", {
      idea: "Идея",
      projectId: "p-chain",
      questId: "q-chain"
    });
    assert.equal(started.body.stage, "failed");
    assert.match(started.body.error.message, /неожиданном формате|нечитаемым/);
  } finally {
    await close();
  }
});

test("AI-CHAIN HTTP: невалидный запрос (пустая идея / неизвестная сессия) отклоняется", async () => {
  const env = await bootStudio([{ content: QUESTION_1 }]);
  const { studioPort, close } = env;
  try {
    const emptyIdea = await post(studioPort, "/local/mission-chain", { idea: "" });
    assert.equal(emptyIdea.body.stage, "failed");
    assert.match(emptyIdea.body.error.message, /идею/i);

    const unknown = await post(studioPort, "/local/mission-chain", { sessionId: "chain-nope", text: "привет" });
    assert.equal(unknown.body.stage, "failed");
    assert.match(unknown.body.error.message, /не найден/i);

    // Мусорное тело: ни idea, ни sessionId → 400 от маршрута.
    const garbage = await post(studioPort, "/local/mission-chain", {});
    assert.equal(garbage.status, 400);

    // GET не разрешён.
    const get = await fetch(`http://127.0.0.1:${studioPort}/local/mission-chain`);
    assert.equal(get.status, 405);
  } finally {
    await close();
  }
});
