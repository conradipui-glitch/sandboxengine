import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Ревью интерфейса мастерской: владелец работает с «миссиями», а Studio
// называла их «квестами» — и в верхней панели предлагала непонятные две
// кнопки («Проверить» в панели и «Играть» сверху). Эти тесты держат
// пользовательский словарь и защиту от безымянных миссий.
const APP = new URL("../src/app.ts", import.meta.url);
const MODULES = ["collaboration.ts", "onboarding.ts", "conflict.ts", "author-assistant.ts", "board-dom.ts"]
  .map((name) => new URL(`../src/${name}`, import.meta.url));

async function readApp() {
  return readFile(APP, "utf8");
}

test("в интерфейсе мастерской нет пользовательского слова «квест»", async () => {
  const app = await readApp();
  const forbidden = [
    '"Квест не выбран."',
    '"В проекте пока нет квестов."',
    "Создайте первый квест",
    "<h2>Квесты</h2>",
    "aria-label=\"Библиотека квестов\"",
    "title=\"Переименовать квест\"",
    'placeholder="Название квеста"',
    "<button type=\"submit\">Создать квест</button>",
    "<h3>Новый квест</h3>",
    "<h2>Проверка квеста</h2>",
    ">Проверить квест<",
    "создание квеста недоступно",
    "Миссии у этого квеста"
  ];
  for (const text of forbidden) {
    assert.equal(app.includes(text), false, `в app.ts осталась подпись «${text}»`);
  }
  assert.equal(app.includes("Миссий: ${questCount}"), true, "счётчик миссий подписан как «Миссии»");
  assert.equal(app.includes('"Миссия не выбрана."'), true, "пустой выбор миссии объясняется словом «миссия»");
});

test("верхняя панель предлагает одно действие — «Проверить и сыграть»", async () => {
  const app = await readApp();
  const button = /data-action="play-quest"[^>]*>([^<]*)</.exec(app);
  assert.ok(button, "кнопка play-quest найдена");
  assert.equal(button[1], "${this.state.playerLaunching ? \"Проверяем и запускаем…\" : \"Проверить и сыграть\"}");
  assert.equal(app.includes(">Играть<"), false, "старая кнопка «Играть» убрана");
  // Действие действительно сначала проверяет revision, потом запускает плеер.
  assert.ok(/await this\.validateCurrentDraft\(\);[\s\S]{0,400}await this\.launchCurrentPlayer\(\);/.test(app));
});

test("пустое название не создаёт безымянный проект или миссию", async () => {
  const app = await readApp();
  assert.ok(
    /const title = text\(data, "title"\)\.trim\(\);[\s\S]{0,300}title\.length === 0[\s\S]{0,300}projectModalError/.test(app),
    "пустое название проекта объясняется автору в форме"
  );
  assert.ok(
    /if \(kind === "quest"\)[\s\S]{0,300}title\.length === 0[\s\S]{0,300}this\.state\.message/.test(app),
    "пустое название миссии объясняется автору"
  );
  assert.equal(app.includes('"Новый квест"'), false, "безымянный «Новый квест» больше не создаётся");
  assert.ok(/if \(!about \|\| about\.trim\(\)\.length === 0\)/.test(app), "«Создать с ИИ» требует описания");
});

test("«Начать с пустого проекта» создаёт проект без безымянной миссии", async () => {
  const app = await readApp();
  const branch = /if \(kind === "empty-draft"\) \{([\s\S]*?)\n      \}/.exec(app);
  assert.ok(branch, "ветка empty-draft найдена");
  assert.equal(branch[1].includes("createQuest"), false, "пустой старт не создаёт миссию за автора");
  assert.ok(branch[1].includes("Создайте первую миссию в библиотеке слева"));
});

test("модули Studio называют историю миссией", async () => {
  for (const url of MODULES) {
    const text = await readFile(url, "utf8");
    for (const bad of ["Квест не найден", "Квест <code>", "Название квеста изменено", "Доска квеста"]) {
      assert.equal(text.includes(bad), false, `${url.pathname} содержит «${bad}»`);
    }
  }
});
