/*
 * Форма запроса писателя миссии: какие сообщения и какой бюджет он отправляет.
 *
 * Нужно, чтобы живой замер на стенде шёл с ТЕМ ЖЕ входом, что у продукта, а не
 * с придуманным промптом. Никаких сетевых вызовов: backend подменён и только
 * записывает запрос.
 *
 * Запуск: node scripts/probe/writer-request-shape.mjs [out.json]
 */
import { writeFileSync } from "node:fs";
import { ModelMissionWriter, missionIntentFromChain } from "../../packages/ai/dist/index.js";

// Сводка цепочки того же класса, что собирает живой стенд: 7 сцен, 3 финала.
function chainSummary() {
  const scenes = Array.from({ length: 7 }, (_, index) => ({
    id: `scene-${index + 1}`,
    title: `Сцена ${index + 1}`,
    goal: `Цель сцены ${index + 1}: сдвинуть расследование к разгадке и дать автору выбор.`
  }));
  const choices = scenes.flatMap((scene, index) => ([
    { from: scene.id, label: `Вариант А: спросить прямо`, to: scenes[index + 1]?.id ?? "ending-1", consequence: "Правда открывается, но доверие падает." },
    { from: scene.id, label: `Вариант Б: промолчать и наблюдать`, to: index % 2 === 0 ? "ending-2" : "ending-3", consequence: "Напряжение растёт, время уходит." }
  ]));
  return {
    idea: "Квест: пропавший смотритель маяка, три свидетеля, два финала",
    genre: "тихий триллер",
    durationMinutes: 20,
    constraints: ["без крови", "без мистики"],
    narrative: "Третью ночь маяк на острове не горит, и смотритель исчез. На острове трое: рыбак, дочь смотрителя и инспектор. Каждый что-то скрывает, и у каждого свой мотив молчать.".repeat(3),
    chain: {
      scenes,
      choices,
      resources: [
        { id: "oil", title: "Запас масла", initial: "1", purpose: "Ограничивает, сколько ночей маяк может гореть." }
      ],
      endings: [
        { id: "ending-1", title: "Маяк горит", condition: "Правда о смотрителе раскрыта полностью." },
        { id: "ending-2", title: "Тёмный маяк", condition: "Остров спасён, но тайна осталась." },
        { id: "ending-3", title: "Тишина", condition: "Никто не признался, время вышло." }
      ]
    }
  };
}

const captured = [];
const backend = {
  async openSession() {
    return { ok: true, session: { id: "probe-session", busy: false, controller: new AbortController() } };
  },
  async runTurn(request) {
    captured.push(request);
    return { ok: false, error: { code: "output_truncated", message: "проба", retryable: false, backendRequestId: "probe" }, usage: null };
  },
  async closeSession() { return; }
};

const intent = missionIntentFromChain(chainSummary());
const writer = new ModelMissionWriter({ backend, profileId: "probe-profile", projectId: "p-probe", questId: "q-probe" });
await writer.write({ intent, deadlineAtMs: Date.now() + 900_000 });

const first = captured[0];
const messages = first.messages.map((message) => ({ role: message.role, content: message.content }));
const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
const out = {
  maxOutputTokens: first.maxOutputTokens,
  messageCount: messages.length,
  totalChars,
  ideaChars: intent.idea.length,
  messages
};
const path = process.argv[2] ?? "writer-request.json";
writeFileSync(path, JSON.stringify(out));
console.log(JSON.stringify({
  maxOutputTokens: first.maxOutputTokens,
  messageCount: messages.length,
  totalChars,
  ideaChars: intent.idea.length,
  roles: messages.map((message) => message.role),
  out: path
}, null, 2));
