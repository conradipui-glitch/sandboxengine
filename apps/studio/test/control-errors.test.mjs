import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ControlApiError } from "../dist/src/api.js";
import { describeControlError, describeReleaseReadiness } from "../dist/src/control-errors.js";

/**
 * R-01 (полное ревью кода): автор не должен собирать причину отказа из кода
 * ошибки. `Control API: RELEASE_FREEZE_FAILED.` не говорил ни что случилось,
 * ни что делать. Здесь закреплено правило: у отказа есть объяснение действием,
 * а неизвестный код остаётся видимым вместе со своим detailCode.
 */

function apiError(status, code, payload) {
  return new ControlApiError(status, code, payload);
}

test("R-01: выпуск без сохранённой истории объясняет причину, а не код", () => {
  const error = apiError(422, "RELEASE_FREEZE_FAILED", {
    error: { code: "RELEASE_FREEZE_FAILED", detailCode: "MISSION_REVISION_UNAVAILABLE" }
  });
  const message = describeControlError(error);
  assert.equal(
    message,
    "У миссии нет сохранённой истории: сохраните сюжет миссии и проверьте снова — из пустой миссии выпуск не собирается."
  );
  assert.doesNotMatch(message, /RELEASE_FREEZE_FAILED|MISSION_REVISION_UNAVAILABLE/);
  assert.doesNotMatch(message, /Control API:/);
});

test("R-01: материал, изменившийся после сборки выпуска, ведёт к пересборке", () => {
  const message = describeControlError(apiError(409, "ASSET_CHANGED", { error: { code: "ASSET_CHANGED" } }));
  assert.match(message, /соберите выпуск заново/);
});

test("R-01: параллельная правка объясняется действием «обновите и повторите»", () => {
  const message = describeControlError(
    apiError(409, "REVISION_CONFLICT", { error: { code: "REVISION_CONFLICT", detailCode: "REVISION_CONFLICT" } })
  );
  assert.match(message, /обновите страницу и повторите/);
});

test("R-01: неизвестный код виден целиком — код и detailCode, без выдуманной причины", () => {
  const message = describeControlError(
    apiError(400, "SOMETHING_NEW", { error: { code: "SOMETHING_NEW", detailCode: "WHY_IT_FAILED" } })
  );
  assert.equal(message, "Действие отклонено: SOMETHING_NEW / WHY_IT_FAILED.");
});

test("R-01: неизвестный код без detailCode не теряется", () => {
  assert.equal(describeControlError(apiError(400, "ONLY_CODE", null)), "Действие отклонено: ONLY_CODE.");
});

test("R-01: мёртвый Control API назван по-русски, а не пустым статусом 0", () => {
  const message = describeControlError(apiError(0, "FETCH_FAILED", null));
  assert.match(message, /Control API недоступен/);
});

test("R-01: сообщение обязано быть непустым для любой ошибки", () => {
  assert.equal(describeControlError(new Error("boom")), "boom");
  assert.equal(describeControlError(undefined), "Неизвестная ошибка Studio.");
  assert.notEqual(describeControlError(apiError(500, "", null)).trim(), "");
});

test("R-01: Studio больше не показывает автору сырой код отказа как сообщение", async () => {
  const app = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.doesNotMatch(app, /Control API: \$\{error\.code\}/);
  assert.match(app, /this\.state\.message = describeControlError\(error\);/);
});

test("R-01: «Проверить» предупреждает о блокере выпуска до попытки сборки", async () => {
  assert.equal(
    describeReleaseReadiness({ status: "blocked", code: "MISSION_REVISION_UNAVAILABLE" }),
    "У миссии нет сохранённой истории: сохраните сюжет миссии и проверьте снова — из пустой миссии выпуск не собирается."
  );
  assert.equal(describeReleaseReadiness({ status: "ready", missionRevision: 3 }), null);
  assert.equal(describeReleaseReadiness(null), null);
  assert.equal(describeReleaseReadiness(undefined), null);
  assert.equal(
    describeReleaseReadiness({ status: "blocked", code: "BRAND_NEW_REASON" }),
    "Выпуск собрать нельзя: код BRAND_NEW_REASON."
  );
  const app = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(app, /data-release-blocked/);
  assert.match(app, /describeReleaseReadiness\(validation\.releaseReadiness\)/);
});
