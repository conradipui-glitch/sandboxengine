/**
 * Сырая диагностика цепочки миссии на стенде: ловим точный запрос цепочки и
 * повторяем его напрямую, чтобы увидеть finish_reason, длину content и
 * reasoning. Ключ не печатается.
 *
 * Запуск внутри контейнера lhc-studio: node /tmp/chain-raw2.mjs (cwd /engine).
 */
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { OpenAiCompatibleModelProvider, validateChainPayload } from "/engine/node_modules/@living-history/ai/dist/index.js";
import { SQLiteControlProviderConnectionStore } from "/engine/node_modules/@living-history/control/dist/index.js";
import { LocalAuthorProvider } from "/engine/apps/studio/dist/src/local-author-provider.js";
import { MissionChainDialogStore } from "/engine/apps/studio/dist/src/mission-chain-dialogs.js";

const databasePath = process.env.LH_DATABASE_PATH ?? "/data/living-history.sqlite";
const database = new DatabaseSync(databasePath, { readOnly: true });
const row = database
  .prepare("SELECT project_id, user_id, base_url, model, api_key FROM control_provider_connections LIMIT 1")
  .get();
if (!row) {
  console.log("ПОДКЛЮЧЕНИЕ НЕ НАСТРОЕНО: строки в control_provider_connections нет");
  process.exit(2);
}
const baseUrl = String(row.base_url);
const model = String(row.model);
const credential = String(row.api_key);
console.log(`провайдер: ${baseUrl} | модель: ${model} | ключ: ${credential.length} символов`);

const provider = new OpenAiCompatibleModelProvider({
  baseUrl,
  credential,
  capabilities: { text: true, jsonObject: true }
});

const connections = new SQLiteControlProviderConnectionStore({ path: databasePath });
const authorProvider = new LocalAuthorProvider(undefined, {
  connections,
  scope: { projectId: String(row.project_id), userId: String(row.user_id) }
});
await authorProvider.restore();

const real = authorProvider.backend;
let captured = null;
const proxy = new Proxy(real, {
  get(target, prop) {
    if (prop === "runTurn") {
      return async (request) => {
        captured = request;
        console.log(`\n[ЗАПРОС] maxOutputTokens=${request.maxOutputTokens} сообщений=${request.messages.length} формат=${request.responseFormat}`);
        const started = Date.now();
        const turn = await real.runTurn(request);
        console.log(`[ОТВЕТ] за ${Date.now() - started} мс ok=${turn?.ok} ${turn?.ok ? `len=${turn.outputText?.length}` : `code=${turn?.error?.code} retryable=${turn?.error?.retryable}`}`);
        if (turn?.ok) {
          try {
            const parsed = JSON.parse(String(turn.outputText));
            if (parsed?.kind === "chain") {
              const verdict = validateChainPayload(parsed, "Квест: пропавший маяк на острове, три свидетеля, два финала");
              const counts = {
                scenes: Array.isArray(parsed.chain?.scenes) ? parsed.chain.scenes.length : -1,
                choices: Array.isArray(parsed.chain?.choices) ? parsed.chain.choices.length : -1,
                resources: Array.isArray(parsed.chain?.resources) ? parsed.chain.resources.length : -1,
                endings: Array.isArray(parsed.chain?.endings) ? parsed.chain.endings.length : -1
              };
              console.log(`[СТРУКТУРА] ok=${verdict.ok} problems=${JSON.stringify(verdict.problems ?? [])} размеры=${JSON.stringify(counts)}`);
            }
          } catch (error) {
            console.log(`[РАЗБОР] не JSON: ${String(error.message).slice(0, 90)}`);
          }
        }
        return turn;
      };
    }
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  }
});

const dialogs = new MissionChainDialogStore({ backend: proxy, profileId: "studio-dev-author-profile" });
const view = await dialogs.start({
  idea: "Квест: пропавший маяк на острове, три свидетеля, два финала",
  projectId: "",
  questId: ""
});
const sessionId = String(view?.sessionId ?? "");
await dialogs.reply(sessionId, "Маяк гаснет третью ночь, смотритель пропал. На острове трое: рыбак, дочь смотрителя и инспектор.");
await dialogs.reply(sessionId, "Финал первый: маяк зажигают и узнают правду. Финал второй: маяк остаётся тёмным, но остров спасают.");
const confirmed = await dialogs.confirm(sessionId);
console.log(`\nСБОРКА: stage=${confirmed?.stage} error=${JSON.stringify(confirmed?.error ?? null).slice(0, 200)}`);

if (!captured) {
  console.log("ЗАПРОС НЕ ПОЙМАН");
  process.exit(0);
}

/* Повторяем тот же самый запрос напрямую — короткий бюджет. */
async function replay(budget) {
  const body = {
    model,
    messages: captured.messages.map((message) => ({ role: message.role, content: message.content })),
    max_tokens: budget,
    response_format: { type: "json_object" }
  };
  const started = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const spent = Date.now() - started;
  const payload = await response.json();
  const choice = payload?.choices?.[0] ?? {};
  const content = String(choice?.message?.content ?? "");
  const reasoning = String(choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? "");
  let parsed = "OK";
  try {
    parsed = `OK kind=${String(JSON.parse(content)?.kind)}`;
  } catch (error) {
    parsed = `FAIL ${String(error.message).slice(0, 80)}`;
  }
  console.log(`\n[ПОВТОР max_tokens=${budget}] http=${response.status} за ${spent} мс finish_reason=${choice?.finish_reason}`);
  console.log(`  content=${content.length} символов | reasoning=${reasoning.length} символов | usage=${JSON.stringify(payload?.usage ?? {})}`);
  console.log(`  parse=${parsed}`);
  console.log(`  tail=${JSON.stringify(content.slice(-120))}`);
  await writeFile(`/tmp/chain-${budget}.txt`, content, "utf8");
}

await replay(captured.maxOutputTokens);
await replay(16_000);
process.exit(0);
