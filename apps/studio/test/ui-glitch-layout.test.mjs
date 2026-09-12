// ui-glitch-layout.test.mjs — регрессионный тест GLITCH-SWEEP на геометрию шапки и вкладок:
// D1: крошки шапки сжимаются (min-width:0 + overflow-x:auto), правые контролы не выталкиваются за экран;
// D2: вкладки инспектора сжимаются (min-width:0) и не переполняют 336px-контейнер.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("GLITCH topbar crumbs shrink instead of pushing actions beyond the viewport", async () => {
  const css = await readFile(
    fileURLToPath(new URL("../styles.css", import.meta.url)),
    "utf8"
  );
  const crumbsRule = css.match(/\.ed-topbar \.crumbs \{[^}]*\}/);
  assert.ok(crumbsRule, "правило .ed-topbar .crumbs существует");
  assert.match(crumbsRule[0], /min-width:\s*0/, "crumbs могут сжиматься (min-width:0)");
  assert.match(crumbsRule[0], /overflow-x:\s*auto/, "переполнение крошек уходит в прокрутку, а не за экран");
  const actionsRule = css.match(/\.ed-topbar \.actions \{[^}]*\}/);
  assert.ok(actionsRule, "правило .ed-topbar .actions существует");
  // Правые контролы остаются в потоке экрана: flex 0 0 auto, не отжимаются и не уезжают.
  assert.match(actionsRule[0], /flex:\s*0\s*0\s*auto/);
});

test("GLITCH inspector tabs shrink to their container instead of overflowing it", async () => {
  const css = await readFile(
    fileURLToPath(new URL("../styles.css", import.meta.url)),
    "utf8"
  );
  const tabsRule = css.match(/\.ed-tabs button \{[^}]*\}/);
  assert.ok(tabsRule, "правило .ed-tabs button существует");
  assert.match(tabsRule[0], /min-width:\s*0/, "вкладки сжимаются ниже min-content");
  // Контролы остаются 40px по высоте (правило владельца: контролы 40/48px).
  assert.match(tabsRule[0], /min-height:\s*40px/);
  // Запрещённые приём owner-правил: без ellipsis/clamp.
  assert.doesNotMatch(tabsRule[0], /ellipsis/);
  assert.doesNotMatch(tabsRule[0], /line-clamp/);
});
