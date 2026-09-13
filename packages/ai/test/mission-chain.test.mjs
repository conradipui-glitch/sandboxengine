import test from "node:test";
import assert from "node:assert/strict";
import {
  MissionChainAgent,
  validateChainPayload,
  missionIntentFromChain,
  buildMissionChainSystemPrompt,
  MISSION_CHAIN_MIN_QUESTIONS,
  MISSION_CHAIN_MAX_QUESTIONS,
  MISSION_CHAIN_MAX_ATTEMPTS,
  MISSION_WRITER_MAX_IDEA_CHARS,
  ScriptedAgentBackend
} from "../dist/index.js";

const DEADLINE = () => Date.now() + 60_000;
const PROFILE = "chain-profile";
const IDEA = "Смотритель маяка в шторм выбирает, кому светить: рыбацкому боту или порту";

const QUESTION_1 = JSON.stringify({ kind: "question", text: "Что должен чувствовать игрок: тревогу или ответственность?" });
const QUESTION_2 = JSON.stringify({ kind: "question", text: "Чем автор готов жертвовать: временем или ресурсами?" });
const QUESTION_3 = JSON.stringify({ kind: "question", text: "Какой финал считать достойным?" });

function chainPayload() {
  return JSON.stringify({
    kind: "chain",
    ideaRestated: "Шторм, маяк и выбор смотрителя: бот или порт.",
    genre: "драма",
    durationMinutes: 15,
    constraints: ["без насилия"],
    narrative: "Шторм ломает причалы. Масла хватает на одну дорогу света. Смотритель решает, кто увидит свет и кто останется в темноте. Каждый выбор что-то стоит, и цена названа заранее.",
    chain: {
      scenes: [
        { id: "storm", title: "Шторм", goal: "Решить, кого светить" },
        { id: "port", title: "Порт", goal: "Удержать вход в гавань" },
        { id: "boat", title: "Бот", goal: "Довести бот до берега" }
      ],
      choices: [
        { from: "storm", label: "Свет в порт", to: "port", consequence: "Бот темнит: масла меньше на 2" },
        { from: "storm", label: "Свет на бот", to: "boat", consequence: "Порт без света: риск на 1 выше" },
        { from: "port", label: "Держать вход", to: "ending-safe", consequence: "Порт цел, бот пропал" },
        { from: "port", label: "Отойти к боту", to: "ending-loss", consequence: "Порт повреждён" },
        { from: "boat", label: "Выкинуться на берег", to: "ending-loss", consequence: "Груз потерян" },
        { from: "boat", label: "Идти в гавань", to: "ending-safe", consequence: "Время потеряно, но все живы" }
      ],
      resources: [{ id: "oil", title: "Масло", initial: 6, purpose: "Единственный свет маяка" }],
      endings: [
        { id: "ending-safe", title: "Тихая гавань", condition: "Вход удержан или бот доведён" },
        { id: "ending-loss", title: "Цена шторма", condition: "Свет отдан не тому" }
      ]
    }
  });
}

/** Цепочка с подменённым куском chain — для проверки брака структуры. */
function brokenChain(chainOverrides) {
  const payload = JSON.parse(chainPayload());
  return JSON.stringify({ ...payload, chain: { ...payload.chain, ...chainOverrides } });
}

/** Бэкенд: ответы по очереди на каждый runTurn. */
function scripted(turnSteps) {
  return new ScriptedAgentBackend({
    backendId: "chain-scripted",
    openSteps: turnSteps.map(() => ({ kind: "success" })),
    closeSteps: turnSteps.map(() => ({ kind: "success" })),
    turnSteps
  });
}

/* ------------------------------------------------------------------ */
/* 1. Старт интервью: первый вопрос                                    */
/* ------------------------------------------------------------------ */

test("AI-CHAIN: start возвращает первый уточняющий вопрос с шагом 1", async () => {
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "question");
  assert.equal(result.kind === "question" && result.questionOrdinal, 1);
  assert.equal(agent.phase, "interview");
  assert.equal(agent.questionsAsked, 1);
});

test("AI-CHAIN: системный промпт несёт методологию и инварианты", () => {
  const prompt = buildMissionChainSystemPrompt(MISSION_CHAIN_MIN_QUESTIONS, MISSION_CHAIN_MAX_QUESTIONS);
  assert.match(prompt, /loop-мышление/);
  assert.match(prompt, /opportunity cost/);
  assert.match(prompt, /бездействие не выигрывает/);
  assert.match(prompt, /доминирующая стратегия запрещена/);
  assert.match(prompt, /telegraph/);
  assert.match(prompt, /2-3/);
  // Идея автора не вшита в системный промпт — она данные, а не инструкции.
  assert.doesNotMatch(prompt, /маяк/i);
});

test("AI-CHAIN: конструктор отвергает недопустимые границы и идею", () => {
  const backend = scripted([]);
  assert.throws(() => new MissionChainAgent({ backend, profileId: PROFILE, idea: "" }), RangeError);
  assert.throws(() => new MissionChainAgent({ backend, profileId: PROFILE, idea: "x".repeat(4_001) }), RangeError);
  assert.throws(() => new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA, minQuestions: 0 }), RangeError);
  assert.throws(() => new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA, minQuestions: 3, maxQuestions: 2 }), RangeError);
  assert.throws(() => new MissionChainAgent({ backend, profileId: "bad id!", idea: IDEA }), TypeError);
});

/* ------------------------------------------------------------------ */
/* 2. Машина состояний: минимум вопросов до цепочки, максимум после    */
/* ------------------------------------------------------------------ */

test("AI-CHAIN: цепочка раньше времени отклоняется, повтор хода даёт вопрос", async () => {
  // После первого вопроса модель отдаёт цепочку — машина требует минимум 2
  // (chain.too_early), ход повторяется; попытка 2 отдаёт нормальный вопрос.
  // Итог хода: вопрос, счётчик вопросов увеличен ровно один раз.
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: chainPayload() },
    { kind: "success", outputText: QUESTION_2 }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  const early = await agent.reply("Тревогу и ответственность.", DEADLINE());
  assert.equal(early.kind, "question");
  assert.equal(early.kind === "question" && early.questionOrdinal, 2);
  assert.equal(agent.questionsAsked, 2);
  assert.equal(backend.capturedTurnRequests.length, 3, "попытки: старт 1 + ход 2 (MAX_ATTEMPTS)");
});

test("AI-CHAIN: вопросы сверх максимума отклоняются, цепочка после минимума принимается", async () => {
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  const q2 = await agent.reply("Ответственный выбор со ценой.", DEADLINE());
  assert.equal(q2.kind, "question");
  assert.equal(q2.kind === "question" && q2.questionOrdinal, 2);
  const ready = await agent.reply("Достойный — спасти обоих ценой масла.", DEADLINE());
  assert.equal(ready.kind, "chain_ready");
  assert.equal(agent.phase, "ready");
  const summary = ready.kind === "chain_ready" ? ready.summary : null;
  assert.ok(summary);
  assert.equal(summary.chain.scenes.length, 3);
  assert.equal(summary.chain.endings.length, 2);
  assert.equal(summary.chain.choices.length, 6);
  assert.equal(summary.chain.resources.length, 1);
  // Транскрипт интервью: пары вопрос-ответ.
  assert.equal(agent.transcript.length, 2);
  assert.equal(agent.transcript[0].question.length > 0, true);
  assert.equal(agent.transcript[0].answer.length > 0, true);
});

test("AI-CHAIN: на исчерпанном лимите вопросов ход обязан собрать цепочку", async () => {
  // start=Q1, a1=Q2, a2=Q3 → лимит исчерпан. Следующий ход все попытки задаёт
  // вопрос (каждая нарушает контракт «только цепочка») → финальная ошибка.
  // Счётчик вопросов при этом не растёт: сверхлимитных вопросов нет.
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: QUESTION_3 },
    ...Array.from({ length: MISSION_CHAIN_MAX_ATTEMPTS }, () => ({ kind: "success", outputText: QUESTION_1 }))
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Ответ 1.", DEADLINE());
  await agent.reply("Ответ 2.", DEADLINE());
  const extra = await agent.reply("Ответ 3.", DEADLINE());
  assert.equal(extra.kind, "failed");
  assert.ok(
    extra.kind === "failed" && (extra.problems ?? []).includes("chain.close_expected_chain"),
    "на исчерпанном лимите вопрос вместо цепочки — нарушение контракта закрытия"
  );
  assert.equal(agent.questionsAsked, 3, "сверхлимитный ход не увеличил счётчик");
});

test("AI-CHAIN: последний ответ автора на исчерпанном лимите собирает цепочку сам", async () => {
  // Автор отвечает на третий вопрос, лимит исчерпан — ход сразу собирает
  // цепочку. Раньше здесь можно было получить только ошибку «слишком много
  // вопросов», и автор оставался без миссии.
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: QUESTION_3 },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Ответ 1.", DEADLINE());
  await agent.reply("Ответ 2.", DEADLINE());
  const ready = await agent.reply("Ответ 3.", DEADLINE());
  assert.equal(ready.kind, "chain_ready");
  assert.equal(agent.phase, "ready");
  assert.equal(agent.questionsAsked, 3);
  // Ответ автора не потерян: он попал в транскрипт интервью.
  assert.equal(agent.transcript.length, 3);
  assert.equal(agent.transcript[2].answer, "Ответ 3.");
});

test("AI-CHAIN: close() собирает цепочку по уже сказанному без нового вопроса", async () => {
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Ответ 1.", DEADLINE());
  const ready = await agent.close(DEADLINE());
  assert.equal(ready.kind, "chain_ready");
  assert.equal(agent.phase, "ready");
  assert.equal(backend.capturedTurnRequests.length, 3, "close идёт тем же движком: ровно один ход");
});

test("AI-CHAIN: close() раньше минимума ответов — invalid_use без запроса к бэкенду", async () => {
  const backend = scripted([{ kind: "success", outputText: QUESTION_1 }]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  const early = await agent.close(DEADLINE());
  assert.equal(early.kind, "failed");
  assert.equal(early.kind === "failed" && early.code, "invalid_use");
  assert.equal(backend.capturedTurnRequests.length, 1, "запрос к модели не отправлялся");
  assert.equal(agent.phase, "interview", "интервью осталось живым: ответы автора не потеряны");
});

test("AI-CHAIN: close() после готовности — invalid_use, цепочка не пересобирается", async () => {
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Ответ 1.", DEADLINE());
  const ready = await agent.reply("Ответ 2.", DEADLINE());
  assert.equal(ready.kind, "chain_ready");
  const again = await agent.close(DEADLINE());
  assert.equal(again.kind, "failed");
  assert.equal(again.kind === "failed" && again.code, "invalid_use");
  assert.equal(backend.capturedTurnRequests.length, 3, "повторный close не пошёл в модель");
});

test("AI-CHAIN: повторный start и reply после готовности — invalid_use без запроса к бэкенду", async () => {
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  const again = await agent.start(DEADLINE());
  assert.equal(again.kind, "failed");
  assert.equal(again.kind === "failed" && again.code, "invalid_use");
  await agent.reply("Ответ 1.", DEADLINE());
  const ready = await agent.reply("Ответ 2.", DEADLINE());
  assert.equal(ready.kind, "chain_ready");
  const extra = await agent.reply("Ещё ответ.", DEADLINE());
  assert.equal(extra.kind, "failed");
  assert.equal(extra.kind === "failed" && extra.code, "invalid_use");
  assert.equal(backend.capturedTurnRequests.length, 3, "бэкенд не должен вызываться сверх трёх ходов");
});

/* ------------------------------------------------------------------ */
/* 3. Честные ошибки: битый ответ, бэкенд-сбой                         */
/* ------------------------------------------------------------------ */

test("AI-CHAIN: нечитаемый ответ модели — invalid_response, попыток ровно MAX_ATTEMPTS", async () => {
  const backend = scripted([
    { kind: "success", outputText: "Извините, вот ваш вопрос: как дела?" },
    { kind: "success", outputText: "```json " + QUESTION_1 + " ```" }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "invalid_response");
  assert.equal(backend.capturedTurnRequests.length, MISSION_CHAIN_MAX_ATTEMPTS);
  // Старт провалился: диалог можно начать заново новым агентом (ход не зафиксирован).
  assert.equal(agent.questionsAsked, 0);
});

test("AI-CHAIN: сбой бэкенда (нет ключа) — честный backend_failure", async () => {
  const backend = scripted([
    { kind: "failure", error: { code: "auth_required", retryable: false } }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "backend_failure");
  assert.match(result.kind === "failed" ? result.message : "", /ключ|ИИ/);
});

test("AI-CHAIN: таймаут бэкенда — backend_failure с понятным сообщением", async () => {
  // Попыток теперь MISSION_CHAIN_MAX_ATTEMPTS: скрипт обязан покрыть все,
  // иначе проверялся бы не таймаут, а исчерпание скрипта.
  const backend = scripted(
    Array.from({ length: MISSION_CHAIN_MAX_ATTEMPTS }, () => ({
      kind: "failure",
      error: { code: "timeout", retryable: true }
    }))
  );
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "backend_failure");
  assert.match(result.kind === "failed" ? result.message : "", /время/);
  assert.equal(backend.capturedTurnRequests.length, MISSION_CHAIN_MAX_ATTEMPTS, "исчерпаны все попытки");
});

test("AI-CHAIN: обрезанный ответ модели — output_truncated, а не «нечитаемый ответ»", async () => {
  // Провайдер упёрся в лимит вывода: JSON недописан. Автор должен узнать про
  // обрыв, а не про «модель ответила ерунду» — действия у них разные.
  const backend = scripted(
    Array.from({ length: MISSION_CHAIN_MAX_ATTEMPTS }, () => ({
      kind: "failure",
      error: { code: "output_truncated", retryable: true }
    }))
  );
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "backend_failure");
  assert.match(result.kind === "failed" ? result.message : "", /обрез/i);
});

test("AI-CHAIN: повтор не тратит попытки впустую — при первом же успехе ход закрыт", async () => {
  const backend = scripted([
    { kind: "failure", error: { code: "output_truncated", retryable: true } },
    { kind: "success", outputText: QUESTION_1 }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "question");
  assert.equal(backend.capturedTurnRequests.length, 2, "повтор после обрыва");
});

test("AI-CHAIN: структурный брак цепочки — повтор с собственным JSON модели и списком нарушений", async () => {
  // Живой случай: провайдер вернул цепочку со ссылкой в несуществующую сцену.
  // Слепая перегенерация даёт ту же ошибку, поэтому на повторе модель обязана
  // увидеть свой забракованный JSON и точный перечень нарушений.
  const broken = brokenChain({
    choices: [
      ...JSON.parse(chainPayload()).chain.choices,
      { from: "storm", label: "Уйти в туман", to: "nowhere", consequence: "Сцена не существует" }
    ]
  });
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    { kind: "success", outputText: broken },
    { kind: "success", outputText: chainPayload() }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Тревогу и ответственность сразу.", DEADLINE());
  const result = await agent.reply("Временем, ресурсы трогать нельзя.", DEADLINE());

  assert.equal(result.kind, "chain_ready", "после ремонта ход собирает цепочку");
  assert.equal(backend.capturedTurnRequests.length, 4, "брак → ремонт → успех, без лишних попыток");

  const repairRequest = backend.capturedTurnRequests[3];
  const messages = repairRequest.messages;
  const tail = messages.slice(-2);
  assert.equal(tail[0].role, "assistant", "модель видит свой предыдущий ответ");
  assert.equal(tail[0].content, broken, "предыдущий ответ передан дословно");
  assert.equal(tail[1].role, "user");
  assert.match(tail[1].content, /Твой предыдущий JSON не принят проверкой цепочки/);
  assert.match(tail[1].content, /chain\.choice_to_unknown:nowhere/, "нарушение названо точно");
  assert.match(tail[1].content, /endings/, "ремонт напоминает про обязательные ключи");

  // Забракованный ответ не подменяет историю интервью: вопросы автора на месте.
  assert.equal(
    messages.filter((message) => message.role === "user").length,
    4,
    "три ответа автора плюс директива ремонта"
  );
});

test("AI-CHAIN: неструктурный брак (слишком рано) — обычный повтор без директивы ремонта", async () => {
  // «Цепочка раньше времени» лечится не ремонтом JSON, а ещё одним вопросом:
  // подсовывать модели директиву про структуру здесь было бы вредно.
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: chainPayload() },
    { kind: "success", outputText: QUESTION_2 }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  const result = await agent.reply("Тревогу.", DEADLINE());
  assert.equal(result.kind, "question", "модель вернулась к вопросу");
  const second = backend.capturedTurnRequests[1];
  const last = second.messages.at(-1);
  assert.equal(last.role, "user", "ход остался на ответе автора");
  assert.match(last.content, /Тревогу/, "последнее сообщение — ответ автора, а не директива");
  assert.doesNotMatch(JSON.stringify(second.messages), /не принят проверкой цепочки/);
});

test("AI-CHAIN: исчерпаны все попытки — автор видит нарушения, а не «нечитаемый ответ»", async () => {
  const broken = brokenChain({ endings: [] });
  const backend = scripted([
    { kind: "success", outputText: QUESTION_1 },
    { kind: "success", outputText: QUESTION_2 },
    ...Array.from({ length: MISSION_CHAIN_MAX_ATTEMPTS }, () => ({ kind: "success", outputText: broken }))
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  await agent.start(DEADLINE());
  await agent.reply("Тревогу.", DEADLINE());
  const result = await agent.reply("Временем.", DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "invalid_response");
  assert.ok(
    result.kind === "failed" && Array.isArray(result.problems) && result.problems.some((p) => p.startsWith("chain.")),
    "нарушения перечислены автору"
  );
});

test("AI-CHAIN: вопрос без текста и пустой ответ автора отклоняются честно", async () => {
  // Старт: модель дважды отвечает вопросом без текста — обе попытки бракуются.
  const backend = scripted([
    { kind: "success", outputText: JSON.stringify({ kind: "question", text: "   " }) },
    { kind: "success", outputText: JSON.stringify({ kind: "question" }) }
  ]);
  const agent = new MissionChainAgent({ backend, profileId: PROFILE, idea: IDEA });
  const result = await agent.start(DEADLINE());
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" && result.code, "invalid_response");

  // Пустой ответ автора не доходит до бэкенда.
  const backend2 = scripted([{ kind: "success", outputText: QUESTION_1 }]);
  const agent2 = new MissionChainAgent({ backend: backend2, profileId: PROFILE, idea: IDEA });
  await agent2.start(DEADLINE());
  const empty = await agent2.reply("", DEADLINE());
  assert.equal(empty.kind, "failed");
  assert.equal(empty.kind === "failed" && empty.code, "invalid_use");
  assert.equal(backend2.capturedTurnRequests.length, 1, "пустой ответ не ходит к бэкенду");
});

/* ------------------------------------------------------------------ */
/* 4. Валидация цепочки                                                */
/* ------------------------------------------------------------------ */

function parsedChain(overrides = {}) {
  const payload = JSON.parse(chainPayload());
  return deepMerge(payload, overrides);
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key]) && typeof target[key] === "object") {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

test("AI-CHAIN: валидатор принимает корректную цепочку и считает инварианты", () => {
  const result = validateChainPayload(parsedChain(), IDEA);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.summary.chain.scenes.length, 3);
    assert.equal(result.summary.durationMinutes, 15);
    assert.equal(result.summary.idea.length > 0, true);
    // Пересказ модели используется, если он дан.
    assert.match(result.summary.idea, /шторм/i);
  }
});

test("AI-CHAIN: валидатор ловит висячие цели, недостижимые финалы, отсутствие развилок и дубли id", () => {
  // Висячая цель выбора.
  const dangling = parsedChain();
  dangling.chain.choices[0].to = "no-such-node";
  const danglingResult = validateChainPayload(dangling, IDEA);
  assert.equal(danglingResult.ok, false);
  assert.ok(danglingResult.ok === false && danglingResult.problems.some((p) => p.startsWith("chain.choice_to_unknown")));

  // Недостижимый финал.
  const unreachable = parsedChain();
  unreachable.chain.choices = unreachable.chain.choices.filter((c) => c.to !== "ending-loss");
  unreachable.chain.choices.push({ from: "port", label: "Ещё выбор", to: "ending-safe", consequence: "Дублирующий" });
  const unreachableResult = validateChainPayload(unreachable, IDEA);
  assert.equal(unreachableResult.ok, false);
  assert.ok(unreachableResult.ok === false && unreachableResult.problems.some((p) => p.startsWith("chain.ending_unreachable")));

  // Нет настоящей развилки: из каждой сцены ведёт ровно один выбор, у игрока
  // нигде нет альтернативы — инвариант «доминирующей стратегии нет» нарушен.
  const noBranch = parsedChain();
  noBranch.chain.choices = [
    { from: "storm", label: "Единственный путь", to: "port", consequence: "Выбора нет" },
    { from: "port", label: "Дальше", to: "ending-loss", consequence: "Выбора нет" },
    { from: "boat", label: "Дальше", to: "ending-safe", consequence: "Выбора нет" }
  ];
  const noBranchResult = validateChainPayload(noBranch, IDEA);
  assert.equal(noBranchResult.ok, false);
  assert.ok(noBranchResult.ok === false && noBranchResult.problems.includes("chain.no_branching_scene"));

  // Дубли id сцен.
  const dupes = parsedChain();
  dupes.chain.scenes[1].id = dupes.chain.scenes[0].id;
  const dupesResult = validateChainPayload(dupes, IDEA);
  assert.equal(dupesResult.ok, false);
  assert.ok(dupesResult.ok === false && dupesResult.problems.includes("chain.duplicate_scene_id"));

  // Один финал недостаточно.
  const oneEnding = parsedChain();
  oneEnding.chain.endings = [oneEnding.chain.endings[0]];
  const oneEndingResult = validateChainPayload(oneEnding, IDEA);
  assert.equal(oneEndingResult.ok, false);
  assert.ok(oneEndingResult.ok === false && oneEndingResult.problems.includes("chain.endings_invalid"));
});

test("AI-CHAIN: валидатор отклоняет мусорные границы (жанр, длительность, нарратив)", () => {
  const bad = parsedChain();
  bad.genre = "";
  bad.durationMinutes = 0;
  bad.narrative = "";
  const result = validateChainPayload(bad, IDEA);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.problems.includes("chain.genre_invalid"));
  assert.ok(result.ok === false && result.problems.includes("chain.duration_invalid"));
  assert.ok(result.ok === false && result.problems.includes("chain.narrative_invalid"));
});

/* ------------------------------------------------------------------ */
/* 5. Сборка интента для mission-writer                                */
/* ------------------------------------------------------------------ */

test("AI-CHAIN: missionIntentFromChain переносит цепочку в интент писателя", () => {
  const validation = validateChainPayload(parsedChain(), IDEA);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const intent = missionIntentFromChain(validation.summary);
  assert.match(intent.idea, /Идея автора:/);
  assert.match(intent.idea, /Нарратив:/);
  assert.match(intent.idea, /Цепочка взаимодействий/);
  assert.match(intent.idea, /storm/);
  assert.match(intent.idea, /Свет в порт/);
  assert.match(intent.idea, /Масло/);
  assert.equal(intent.genre, "драма");
  assert.equal(intent.targetDurationMinutes, 15);
  assert.equal(intent.branchCount, 2);
  assert.equal(intent.endingCount, 2);
  assert.deepEqual([...intent.constraints], ["без насилия"]);
  assert.equal(intent.language, "ru");
});

test("AI-CHAIN: максимальная цепочка переносится в интент без потери структуры", () => {
  // Законный максимум цепочки длиннее предела намерения, поэтому сжимается
  // нарратив, а не структура: иначе писатель не увидит финалы и откажет.
  const scenes = Array.from({ length: 24 }, (_, index) => ({
    id: `scene-${index}`,
    title: `Сцена ${index}`,
    goal: "Решить, кому светить и чем за это платить"
  }));
  const choices = [];
  for (let index = 0; index < 24; index += 1) {
    choices.push({
      from: `scene-${index}`,
      label: `Выбор ${index}`,
      to: index === 23 ? "ending-safe" : `scene-${index + 1}`,
      consequence: "Масла меньше, риск выше"
    });
    if (index % 3 === 0) {
      choices.push({
        from: `scene-${index}`,
        label: `Свернуть к цене ${index}`,
        to: "ending-loss",
        consequence: "Свет отдан не тому"
      });
    }
  }
  const payload = {
    kind: "chain",
    ideaRestated: IDEA,
    genre: "драма",
    durationMinutes: 20,
    constraints: ["без насилия"],
    narrative: "Шторм бьёт в стекло, смотритель считает масло. ".repeat(85),
    chain: {
      scenes,
      choices,
      resources: Array.from({ length: 8 }, (_, index) => ({
        id: `res-${index}`,
        title: `Ресурс ${index}`,
        initial: index,
        purpose: "Топливо истории"
      })),
      endings: Array.from({ length: 8 }, (_, index) => ({
        id: index === 7 ? "ending-safe" : index === 6 ? "ending-loss" : `ending-${index}`,
        title: `Финал ${index}`,
        condition: "Условие достижимо выбором"
      }))
    }
  };
  // Все восемь финалов достижимы: крайние два — выборами, остальные добавляем.
  payload.chain.choices.push(
    { from: "scene-0", label: "К финалу 0", to: "ending-0", consequence: "Цена названа" },
    { from: "scene-1", label: "К финалу 1", to: "ending-1", consequence: "Цена названа" },
    { from: "scene-2", label: "К финалу 2", to: "ending-2", consequence: "Цена названа" },
    { from: "scene-3", label: "К финалу 3", to: "ending-3", consequence: "Цена названа" },
    { from: "scene-4", label: "К финалу 4", to: "ending-4", consequence: "Цена названа" },
    { from: "scene-5", label: "К финалу 5", to: "ending-5", consequence: "Цена названа" }
  );
  const validation = validateChainPayload(payload, IDEA);
  assert.equal(validation.ok, true, JSON.stringify(validation.problems ?? []));
  if (!validation.ok) return;
  const intent = missionIntentFromChain(validation.summary);
  assert.ok(intent.idea.length <= MISSION_WRITER_MAX_IDEA_CHARS);
  assert.match(intent.idea, /Финалы:/);
  for (const ending of validation.summary.chain.endings) {
    assert.ok(intent.idea.includes(ending.id), `финал ${ending.id} потерян при сборке интента`);
  }
  assert.equal(intent.idea.match(/- scene-\d+:/g)?.length, 24, "все сцены обязаны попасть в интент");
});
