import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// FIN-13 (UI-половина): курсоры коллег должны быть подключены к живой доске
// Studio, а не жить отдельным модулем. Тест держит ровно те точки интеграции,
// которые выполнял оркестратор поверх ветки субагента.

const appSource = await readFile(
  fileURLToPath(new URL("../src/app.ts", import.meta.url)),
  "utf8"
);
const apiSource = await readFile(
  fileURLToPath(new URL("../src/api.ts", import.meta.url)),
  "utf8"
);
const styles = await readFile(
  fileURLToPath(new URL("../styles.css", import.meta.url)),
  "utf8"
);

test("FIN-13 wiring: presence монтируется вместе с доской и снимается вместе с ней", () => {
  assert.match(appSource, /import \{[^}]*mountPresence[^}]*\} from "\.\/presence\.js"/s);
  const mountBoardBody = appSource.slice(appSource.indexOf("private mountBoardIfNeeded"));
  assert.match(mountBoardBody, /this\.mountPresenceIfNeeded\(host, projectId, questId\)/);
  assert.match(appSource, /private mountPresenceIfNeeded\(host: HTMLElement, projectId: string, questId: string\)/);
  const destroyBoardBody = appSource.slice(appSource.indexOf("private destroyBoard"));
  assert.match(destroyBoardBody, /this\.destroyPresence\(\)/);
});

test("FIN-13 wiring: курсоры идут в API с CSRF и координатами доски, руками mouse-движения не шлются на сервер", () => {
  assert.match(appSource, /csrfToken: \(\) => this\.api\.currentCsrfToken\(\)/);
  assert.match(appSource, /getViewport: \(\) =>\s*this\.boardLifecycle\.getViewport\(projectId, questId\)/);
  assert.match(apiSource, /currentCsrfToken\(\): string \| null \{\s*return this\.csrfToken;/);
  assert.match(appSource, /host\.getBoundingClientRect\(\)/);
});

test("FIN-13 wiring: стили полосы и курсоров присутствия есть в бандле Studio", () => {
  for (const selector of [".presence-bar", ".presence-cursor", ".presence-avatar", ".presence-layer", ".presence-cursors"]) {
    assert.ok(styles.includes(selector), `нет стиля ${selector}`);
  }
  assert.match(styles, /\.board-host \{ position: relative; \}/);
});

test("FIN-10 wiring: ошибка загрузки показывается русским баннером с «Повторить» на месте блока", () => {
  assert.match(appSource, /import \{ renderStudioError, type StudioErrorBannerHandle \} from "\.\/onboarding\.js"/);
  assert.match(appSource, /private syncLoadErrorBanner\(\): void \{/);
  assert.match(appSource, /renderStudioError\(slot, code, \(\) => \{/);
  assert.match(appSource, /data-error-slot data-error-code="asset-load"/);
  assert.match(appSource, /data-error-slot data-error-code="player-launch"/);
  assert.match(appSource, /this\.syncLoadErrorBanner\(\);\r?\n/);
  assert.match(appSource, /void this\.launchCurrentPlayer\(\)/);
});
