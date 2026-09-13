import test from "node:test";
import assert from "node:assert/strict";
import { aiDraftFailureMessage } from "../dist/src/app.js";

// Честность сообщения: автор должен понять, что делать. Раньше любая неудача
// предлагала «проверьте модель и ключ», хотя ключ и модель были верны, а модель
// просто не успела ответить (тайм-аут генерации) или отдала пустой ответ.

test("S-AI-1 тайм-аут генерации назван причиной и предлагает повтор или быструю модель", () => {
  const message = aiDraftFailureMessage({
    kind: "backend_failure",
    problems: ["provider.timeout"],
    evidence: [{ attempt: 1, ok: false, errorCode: "timeout" }]
  });
  assert.match(message, /не успела ответить/);
  assert.match(message, /сохран/);
  assert.doesNotMatch(message, /проверьте модель и ключ/i);
});

test("S-AI-1 пустой ответ модели отличается от тайм-аута", () => {
  const message = aiDraftFailureMessage({
    kind: "backend_failure",
    evidence: [{ attempt: 1, ok: false, errorCode: "http" }, { attempt: 2, ok: false, errorCode: "invalid_response" }]
  });
  assert.match(message, /не готовым планом/);
  assert.doesNotMatch(message, /не успела ответить/);
});

test("S-AI-1 отклонённый ключ всё-таки просит проверить ключ", () => {
  const message = aiDraftFailureMessage({
    kind: "backend_failure",
    evidence: [{ attempt: 1, ok: false, errorCode: "auth_required" }]
  });
  assert.match(message, /ключ/i);
});

test("S-AI-1 нехватка плана и невалидный план сохраняют свои формулировки", () => {
  assert.match(aiDraftFailureMessage({ kind: "insufficient_plan" }), /без двух развилок/);
  assert.match(aiDraftFailureMessage({ kind: "invalid_plan", problems: ["branch.duplicate"] }), /не прошёл проверку/);
});

test("S-AI-1 без доказательств сообщение остаётся честным и не обвиняет ключ", () => {
  const message = aiDraftFailureMessage({ kind: "backend_failure" });
  assert.match(message, /сохран/);
  assert.doesNotMatch(message, /проверьте модель и ключ/i);
});
