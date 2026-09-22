import test from "node:test";
import assert from "node:assert/strict";
import { ModelMissionWriter, ModelProviderAgentBackend } from "@living-history/ai";
import { aiDraftFailureMessage } from "../dist/src/app.js";

// Честность сообщения: автор должен понять, что делать. Раньше любая неудача
// предлагала «проверьте модель и ключ», хотя ключ и модель были верны, а модель
// просто не успела ответить (тайм-аут генерации) или отдала пустой ответ.
//
// РЕГРЕССИЯ: писатель отдаёт доказательства объектом `{attempts:[…]}`, а панель
// читала их как плоский массив — код последней попытки не находился никогда, и
// автор всегда видел общую фразу вместо настоящей причины. Первые четыре теста
// держат форму доказательств такой, какой её отдаёт писатель (проверено живым
// прогоном ModelMissionWriter ниже), а не удобной для чтения.

test("S-AI-1 тайм-аут генерации назван причиной и предлагает повтор или быструю модель", () => {
  const message = aiDraftFailureMessage({
    kind: "failed",
    code: "backend_failure",
    evidence: { attempts: [{ attempt: 1, ok: false, errorCode: "timeout", maxOutputTokens: 8192 }] }
  });
  assert.match(message, /не успела ответить/);
  assert.match(message, /сохран/);
  assert.doesNotMatch(message, /проверьте модель и ключ/i);
});

test("S-AI-1 пустой ответ модели отличается от тайм-аута", () => {
  const message = aiDraftFailureMessage({
    kind: "failed",
    code: "backend_failure",
    evidence: {
      attempts: [
        { attempt: 1, ok: false, errorCode: "backend_error", maxOutputTokens: 8192 },
        { attempt: 2, ok: false, errorCode: "invalid_response", maxOutputTokens: 8192 }
      ]
    }
  });
  assert.match(message, /не готовым планом/);
  assert.doesNotMatch(message, /не успела ответить/);
});

test("S-AI-1 отклонённый ключ всё-таки просит проверить ключ", () => {
  const message = aiDraftFailureMessage({
    kind: "failed",
    code: "backend_failure",
    evidence: { attempts: [{ attempt: 1, ok: false, errorCode: "auth_required", maxOutputTokens: 8192 }] }
  });
  assert.match(message, /ключ/i);
  assert.match(message, /Подключение ИИ-помощника/);
});

test("S-AI-1 сбой связи с провайдером назван причиной, а не «ответ не пришёл»", () => {
  const message = aiDraftFailureMessage({
    kind: "failed",
    code: "backend_failure",
    evidence: { attempts: [{ attempt: 1, ok: false, errorCode: "backend_error", maxOutputTokens: 8192 }] }
  });
  assert.match(message, /Не удалось связаться с провайдером/);
  assert.match(message, /сохран/);
});

test("S-AI-1 нехватка плана и невалидный план сохраняют свои формулировки", () => {
  assert.match(aiDraftFailureMessage({ kind: "insufficient_plan" }), /без двух развилок/);
  assert.match(aiDraftFailureMessage({ kind: "invalid_plan", problems: ["branch.duplicate"] }), /не прошёл проверку/);
});

test("S-AI-1 без доказательств сообщение остаётся честным и не обвиняет ключ", () => {
  const message = aiDraftFailureMessage({ kind: "failed", code: "backend_failure" });
  assert.match(message, /сохран/);
  assert.doesNotMatch(message, /проверьте модель и ключ/i);
});

test("S-AI-1 плоский массив доказательств (старые ответы) читается по-прежнему", () => {
  const message = aiDraftFailureMessage({
    kind: "failed",
    code: "backend_failure",
    evidence: [{ attempt: 1, ok: false, errorCode: "timeout" }]
  });
  assert.match(message, /не успела ответить/);
});

/**
 * Живой писатель с падающим бэкендом: доказательства приходят ровно той формы,
 * какую разбирает панель. Тест ловит расхождение формы, из-за которого автор
 * видел общую фразу вместо причины отказа.
 */
async function writerFailure(errorCode) {
  const backend = new ModelProviderAgentBackend();
  backend.configure({
    async generate() {
      return {
        ok: false,
        error: { code: errorCode, message: `stub ${errorCode}`, retryable: false, httpStatus: null, providerRequestId: null },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null }
      };
    }
  }, "stub-model");
  const writer = new ModelMissionWriter({
    backend,
    profileId: "draft-failure-profile",
    projectId: "p-draft",
    questId: "q-draft"
  });
  return writer.write({
    intent: { idea: "Смотритель маяка в шторм решает, кому светить.", genre: "драма", targetDurationMinutes: 15, language: "ru" },
    deadlineAtMs: Date.now() + 30_000
  });
}

test("S-AI-1 живой писатель: тайм-аут из доказательств доходит до автора причиной", async () => {
  const result = await writerFailure("timeout");
  assert.equal(result.kind, "failed");
  const message = aiDraftFailureMessage(result);
  assert.match(message, /не успела ответить/);
});

test("S-AI-1 живой писатель: сбой провайдера из доказательств назван связью", async () => {
  const result = await writerFailure("backend_error");
  assert.equal(result.kind, "failed");
  const message = aiDraftFailureMessage(result);
  assert.match(message, /Не удалось связаться с провайдером/);
});
