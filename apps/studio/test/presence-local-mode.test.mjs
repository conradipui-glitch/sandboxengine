// Присутствие — командная функция: серверные маршруты присутствия существуют только
// при настоящей личности (в локальном режиме их нет вовсе). Раньше ряд присутствия
// монтировался всегда: клиент получал 404 на поток и «уход», показывал автору вечное
// «переподключаемся» и впустую долбил сервер (измерено приёмкой: 68 попыток потока).
//
// Этот страж держит границу: в локальном режиме ряд присутствия не монтируется.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_SOURCE = readFileSync(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf8");

test("presence-local: монтаж присутствия требует подтверждённого входа", () => {
  const body = /private mountPresenceIfNeeded\([\s\S]*?\n  \}/.exec(APP_SOURCE)?.[0] ?? "";
  assert.notEqual(body, "", "в app.ts должен быть метод mountPresenceIfNeeded");
  assert.match(
    body,
    /this\.state\.access\.mode !== "authenticated"/,
    "без подтверждённой личности ряд присутствия не монтируется (иначе 404-цикл на поток и «уход»)"
  );
});

test("presence-local: проверка режима стоит до создания клиента присутствия", () => {
  const at = APP_SOURCE.indexOf("private mountPresenceIfNeeded(");
  assert.ok(at > 0, "метод не найден");
  const body = APP_SOURCE.slice(at, at + 1200);
  const guard = body.indexOf('this.state.access.mode !== "authenticated"');
  const client = body.indexOf("createPresenceClient(");
  assert.ok(guard > 0, "граница режима отсутствует");
  assert.ok(client > 0, "создание клиента присутствия не найдено");
  assert.ok(guard < client, "проверка режима обязана стоять до создания клиента");
});
