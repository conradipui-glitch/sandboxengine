/**
 * Сырая диагностика цепочки миссии на стенде: что именно отвечает модель.
 *
 * Запуск внутри контейнера lhc-studio: node /tmp/chain-raw.mjs (cwd /engine).
 * Печатает длину/начало/конец ответа модели и результат разбора JSON —
 * без ключа и без содержимого промпта.
 */
import { SQLiteControlProviderConnectionStore } from "/engine/node_modules/@living-history/control/dist/index.js";
import { LocalAuthorProvider } from "/engine/apps/studio/dist/src/local-author-provider.js";
import { MissionChainDialogStore } from "/engine/apps/studio/dist/src/mission-chain-dialogs.js";

const databasePath = process.env.LH_DATABASE_PATH ?? "/data/living-history.sqlite";
const connections = new SQLiteControlProviderConnectionStore({ path: databasePath });
const authorProvider = new LocalAuthorProvider(undefined, {
  connections,
  scope: { projectId: "local-operator", userId: "local-owner" }
});
await authorProvider.restore();

const real = authorProvider.backend;
if (!real) {
  console.log("BACKEND НЕ НАСТРОЕН: подключение к ИИ пустое");
  process.exit(2);
}

let turnIndex = 0;
const logged = new Proxy(real, {
  get(target, prop) {
    if (prop === "runTurn") {
      return async (request) => {
        turnIndex += 1;
        const started = Date.now();
        let turn;
        try {
          turn = await real.runTurn(request);
        } catch (error) {
          console.log(`[RAW #${turnIndex}] runTurn THROW ${String(error).slice(0, 200)}`);
          throw error;
        }
        const spent = Date.now() - started;
        if (!turn || turn.ok !== true) {
          console.log(`[RAW #${turnIndex}] FAIL за ${spent} мс: ${JSON.stringify(turn?.error ?? turn).slice(0, 300)}`);
          return turn;
        }
        const text = String(turn.outputText ?? "");
        let parsed;
        try {
          const value = JSON.parse(text);
          parsed = `OK kind=${String(value?.kind)}`;
        } catch (error) {
          parsed = `FAIL ${String(error.message).slice(0, 90)}`;
        }
        console.log(`[RAW #${turnIndex}] за ${spent} мс: len=${text.length} usage=${JSON.stringify(turn.usage ?? {})}`);
        console.log(`[RAW #${turnIndex}] parse=${parsed}`);
        console.log(`[RAW #${turnIndex}] head=${JSON.stringify(text.slice(0, 140))}`);
        console.log(`[RAW #${turnIndex}] tail=${JSON.stringify(text.slice(-180))}`);
        return turn;
      };
    }
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  }
});

const dialogs = new MissionChainDialogStore({ backend: logged, profileId: "studio-dev-author-profile" });
const idea = "Квест: пропавший маяк на острове, три свидетеля, два финала";

const view = await dialogs.start({ idea, projectId: "", questId: "" });
const sessionId = String(view?.session?.sessionId ?? view?.sessionId ?? "");
console.log(`\nСТАРТ: stage=${view?.session?.stage} asked=${view?.session?.questionsAnswered}/${view?.session?.questionsMin} id=${sessionId.slice(0, 22)}…`);
console.log("ключи вида:", Object.keys(view ?? {}).join(","));

await dialogs.reply(sessionId, "Маяк гаснет третью ночь, смотритель пропал. На острове трое: рыбак, дочь смотрителя и инспектор.");
const afterFirst = await dialogs.reply(sessionId, "Финал первый: маяк зажигают и узнают правду. Финал второй: маяк остаётся тёмным, но остров спасают.");
console.log(`ПОСЛЕ ОТВЕТОВ: stage=${afterFirst?.session?.stage} asked=${afterFirst?.session?.questionsAnswered}`);

const confirmed = await dialogs.confirm(sessionId);
const summary = confirmed?.session?.summary;
console.log(`\nСБОРКА: stage=${confirmed?.session?.stage} error=${JSON.stringify(confirmed?.session?.error ?? null).slice(0, 200)}`);
console.log(`цепочка: сцены=${summary?.chain?.scenes?.length ?? 0} выборы=${summary?.chain?.choices?.length ?? 0} финалы=${summary?.chain?.endings?.length ?? 0}`);
console.log(`статистика: ${JSON.stringify(confirmed?.session?.stats ?? null).slice(0, 240)}`);
process.exit(0);
