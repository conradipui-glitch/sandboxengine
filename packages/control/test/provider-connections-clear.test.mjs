// Отключение провайдера обязано стирать секрет: строка подключения удаляется
// целиком, чтение больше ничего не отдаёт, а повторная запись начинается с
// ревизии 1 (никакого «призрака» прежнего ключа).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlProviderConnectionStore, SQLiteControlProviderConnectionStore } from "@living-history/control";

// Значение намеренно не похоже на настоящий ключ провайдера: тест проверяет маску
// и стирание, а не работу с живым секретом (сканирование секретов это подтверждает).
const API_KEY = "local-test-credential-for-mask-and-clear";

/** Стор принимает только sha256-хэши в requestHash. */
const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function saveInput(overrides = {}) {
  return {
    projectId: "local-operator",
    userId: "local-owner",
    expectedRevision: null,
    providerPreset: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    apiKey: API_KEY,
    idempotencyKey: "save-1",
    requestHash: sha256Text("save-1"),
    updatedAtMs: 1,
    ...overrides
  };
}

for (const [label, make] of [
  ["memory", async () => new MemoryControlProviderConnectionStore()],
  ["sqlite", async (dir) => new SQLiteControlProviderConnectionStore({ path: join(dir, "connections.sqlite") })]
]) {
  test(`FIN-07: отключение стирает ключ (${label})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "fin07-clear-"));
    let store = await make(dir);
    t.after(async () => { store.close?.(); await rm(dir, { recursive: true, force: true }); });

    const saved = await store.saveConnection(saveInput());
    assert.equal(saved.kind, "saved");
    assert.equal(saved.connection.hasKey, true);
    assert.equal(JSON.stringify(saved.connection).includes(API_KEY), false, "ключ не попадает в безопасное чтение");
    assert.equal(await store.revealApiKey({ projectId: "local-operator", userId: "local-owner" }), API_KEY);

    assert.equal(await store.clearConnection("local-operator", "local-owner"), true);
    assert.equal(await store.getConnection("local-operator", "local-owner"), null);
    assert.equal(await store.revealApiKey({ projectId: "local-operator", userId: "local-owner" }), null);
    assert.equal(await store.clearConnection("local-operator", "local-owner"), false, "повторное удаление честно отвечает «нечего удалять»");

    if (label === "sqlite") {
      // Настоящая проверка — переживание перезапуска: после закрытия и повторного
      // открытия файла ни чтения, ни внутреннего доступа к ключу быть не должно
      // (сырые байты файла проверять нельзя: WAL/journal ещё держат страницы).
      store.close?.();
      const reopened = new SQLiteControlProviderConnectionStore({ path: join(dir, "connections.sqlite") });
      assert.equal(await reopened.getConnection("local-operator", "local-owner"), null);
      assert.equal(await reopened.revealApiKey({ projectId: "local-operator", userId: "local-owner" }), null);
      store = reopened;
    }

    const again = await store.saveConnection(saveInput({ idempotencyKey: "save-2", requestHash: sha256Text("save-2"), updatedAtMs: 2 }));
    assert.equal(again.kind, "saved");
    assert.equal(again.connection.revision, 1, "после удаления запись начинается заново");
  });
}
