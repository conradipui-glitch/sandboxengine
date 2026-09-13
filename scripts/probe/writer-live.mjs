/*
 * Живой прогон писателя миссии тем же путём, что на стенде: backend профиля
 * Studio → провайдер → ModelMissionWriter. Нужен, чтобы увидеть причины отказа
 * (попытки, коды, счётчики токенов), которых не видно в ответе стенда.
 *
 * Ключ читается из локального окружения Hermes и НЕ печатается.
 * Запуск: node scripts/probe/writer-live.mjs
 */
import { readFileSync } from "node:fs";
import {
  ModelMissionWriter,
  ModelProviderAgentBackend,
  OpenAiCompatibleModelProvider,
  missionIntentFromChain
} from "../../packages/ai/dist/index.js";

function readKey() {
  const path = process.env.LH_TOKEN_JUICE_ENV ?? "C:/Users/kato55/AppData/Local/hermes/.env";
  const text = readFileSync(path, "utf8");
  const match = /HERMES_CUSTOM_TOKEN_JUICE_API_KEY\s*=\s*(\S+)/.exec(text);
  if (!match) throw new Error("ключ token-juice не найден в окружении");
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function chainSummary() {
  const scenes = Array.from({ length: 7 }, (_, index) => ({
    id: `scene-${index + 1}`,
    title: `Сцена ${index + 1}`,
    goal: `Цель сцены ${index + 1}: сдвинуть расследование к разгадке и дать автору выбор.`
  }));
  const choices = scenes.flatMap((scene, index) => ([
    { from: scene.id, label: "Вариант А: спросить прямо", to: scenes[index + 1]?.id ?? "ending-1", consequence: "Правда открывается, но доверие падает." },
    { from: scene.id, label: "Вариант Б: промолчать и наблюдать", to: index % 2 === 0 ? "ending-2" : "ending-3", consequence: "Напряжение растёт, время уходит." }
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
      resources: [{ id: "oil", title: "Запас масла", initial: "1", purpose: "Ограничивает, сколько ночей маяк может гореть." }],
      endings: [
        { id: "ending-1", title: "Маяк горит", condition: "Правда о смотрителе раскрыта полностью." },
        { id: "ending-2", title: "Тёмный маяк", condition: "Остров спасён, но тайна осталась." },
        { id: "ending-3", title: "Тишина", condition: "Никто не признался, время вышло." }
      ]
    }
  };
}

const key = readKey();
const provider = new OpenAiCompatibleModelProvider({
  baseUrl: "https://api.tokenjuice.ai/v1",
  credential: key,
  allowLocal: true,
  capabilities: { text: true, jsonObject: true }
});
const backend = new ModelProviderAgentBackend();
backend.configure(provider, "deepseek-ai/DeepSeek-V4.1-Flash");
const writer = new ModelMissionWriter({
  backend,
  profileId: "studio-dev-author-profile",
  projectId: "p-probe",
  questId: "q-probe"
});

const started = Date.now();
const result = await writer.write({ intent: missionIntentFromChain(chainSummary()), deadlineAtMs: started + 900_000 });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const shape = {
  kind: result.kind,
  elapsedSec: Number(elapsed),
  errorCode: result.error?.code ?? null,
  message: result.error?.message ?? null,
  attempts: (result.evidence?.attempts ?? []).map((attempt) => ({
    attempt: attempt.attempt,
    ok: attempt.ok,
    errorCode: attempt.errorCode,
    outputTokens: attempt.usage?.outputTokens ?? null,
    budget: attempt.maxOutputTokens ?? null
  })),
  repairs: result.repairs ?? null,
  document: result.kind === "ok"
    ? {
        scenes: result.document.story.scenes.length,
        endings: result.document.story.endings.length,
        choices: result.document.story.scenes.reduce((total, scene) => total + (scene.choices?.length ?? 0), 0),
        title: result.document.listing?.title ?? result.document.story.title ?? null
      }
    : null
};
console.log(JSON.stringify(shape, null, 2));
