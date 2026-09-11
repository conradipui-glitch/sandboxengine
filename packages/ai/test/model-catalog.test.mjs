import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG_DISCLAIMER,
  REFERENCE_MODEL_CATALOG,
  createModelCatalog,
  deepFreeze
} from "../dist/index.js";

const validEntry = (overrides = {}) => ({
  id: "openai/gpt-4.1",
  displayName: "GPT-4.1",
  provider: "openai",
  contextTokens: 200_000,
  structuredOutput: true,
  speed: "balanced",
  costUnits: 20,
  fits: ["author", "host"],
  ...overrides
});

test("FIN08-C01 справочный каталог глубоко заморожен и запись в него бросает", () => {
  assert.ok(Object.isFrozen(REFERENCE_MODEL_CATALOG));
  assert.ok(Object.isFrozen(REFERENCE_MODEL_CATALOG.entries));
  assert.equal(REFERENCE_MODEL_CATALOG.entries.length, 7);
  for (const entry of REFERENCE_MODEL_CATALOG.entries) {
    assert.ok(Object.isFrozen(entry), `запись ${entry.id} не заморожена`);
    assert.ok(Object.isFrozen(entry.fits), `fits записи ${entry.id} не заморожен`);
  }
  assert.ok(Object.isFrozen(REFERENCE_MODEL_CATALOG.disclaimer));

  assert.throws(() => {
    REFERENCE_MODEL_CATALOG.entries[0].contextTokens = 1;
  }, TypeError);
  assert.throws(() => {
    REFERENCE_MODEL_CATALOG.entries[0].fits.push("author");
  }, TypeError);
  assert.throws(() => {
    REFERENCE_MODEL_CATALOG.version = "hacked";
  }, TypeError);
});

test("FIN08-C02 каталог помечен как справочный и не содержит сетевых полей или секретов", () => {
  assert.equal(REFERENCE_MODEL_CATALOG.disclaimer, MODEL_CATALOG_DISCLAIMER);
  assert.match(REFERENCE_MODEL_CATALOG.disclaimer, /Справочные значения/);
  assert.match(REFERENCE_MODEL_CATALOG.disclaimer, /обновлению/);

  const forbidden = ["baseUrl", "url", "apiKey", "credential", "token", "secret", "endpoint"];
  for (const entry of REFERENCE_MODEL_CATALOG.entries) {
    for (const key of forbidden) {
      assert.equal(Object.hasOwn(entry, key), false, `запись ${entry.id} содержит поле ${key}`);
    }
  }
  const json = JSON.stringify(REFERENCE_MODEL_CATALOG);
  assert.equal(/https?:\/\//.test(json), false, "каталог не должен содержать URL");
});

test("FIN08-C03 createModelCatalog не мутирует и не замораживает входные данные", () => {
  const inputEntry = validEntry();
  const input = [inputEntry];

  const catalog = createModelCatalog(input, { version: "test-1" });

  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.entries[0]));
  assert.notEqual(catalog.entries[0], inputEntry, "каталог должен хранить копию, а не тот же объект");

  // Входные данные остались во владении вызывающего: их можно менять.
  inputEntry.displayName = "Изменено после создания";
  input.push(validEntry({ id: "anthropic/x" }));
  assert.equal(inputEntry.displayName, "Изменено после создания");
  assert.equal(input.length, 2);
  assert.equal(catalog.entries.length, 1, "позднее изменение входного массива не влияет на каталог");
  assert.equal(catalog.entries[0].displayName, "GPT-4.1");
});

test("FIN08-C04 createModelCatalog отклоняет некорректные записи", () => {
  assert.throws(() => createModelCatalog([validEntry({ contextTokens: 0 })]), RangeError);
  assert.throws(() => createModelCatalog([validEntry({ contextTokens: 1.5 })]), RangeError);
  assert.throws(() => createModelCatalog([validEntry({ structuredOutput: "yes" })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry({ speed: "warp" })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry({ costUnits: -1 })]), RangeError);
  assert.throws(() => createModelCatalog([validEntry({ fits: ["nobody"] })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry({ fits: [] })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry(), validEntry()]), /дважды/);
  assert.throws(() => createModelCatalog([validEntry({ id: "bad id with spaces" })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry({ provider: "OpenAI/evil" })]), TypeError);
  assert.throws(() => createModelCatalog([validEntry({ displayName: "  " })]), TypeError);
  assert.throws(() => createModelCatalog(null), TypeError);
});

test("FIN08-C05 deepFreeze рекурсивно замораживает вложенные структуры", () => {
  const value = deepFreeze({ a: [{ b: { c: 1 } }] });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.a));
  assert.ok(Object.isFrozen(value.a[0]));
  assert.ok(Object.isFrozen(value.a[0].b));
  assert.throws(() => {
    value.a[0].b.c = 2;
  }, TypeError);
});
