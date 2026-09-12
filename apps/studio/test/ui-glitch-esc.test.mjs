// ui-glitch-esc.test.mjs — регрессионный тест GLITCH-SWEEP:
// Escape закрывает служебную панель «Дополнительно» и меню «…» (раньше — не закрывал).
import test from "node:test";
import assert from "node:assert/strict";
import { StudioApp } from "../dist/src/app.js";

// StudioApp.render() читает document.activeElement; браузера в тестах нет.
globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class {};

function fakeRoot() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    querySelector() { return null; }
  };
}

/** Подменяет document на фейковый с keydown-слушателями; возвращает диспетчер Escape. */
function withFakeDocument(run) {
  const previous = globalThis.document;
  const keydownListeners = [];
  globalThis.document = {
    activeElement: null,
    addEventListener(type, handler) { if (type === "keydown") keydownListeners.push(handler); },
    removeEventListener() {}
  };
  try {
    return run(() => {
      const event = { key: "Escape", preventDefault() {} };
      for (const handler of keydownListeners) handler(event);
      return keydownListeners.length;
    });
  } finally {
    globalThis.document = previous;
  }
}

function bootApp({ panel = null, menuOpen = false } = {}) {
  return withFakeDocument((press) => {
    const root = fakeRoot();
    const app = new StudioApp(root, { async listProjects() { return []; } });
    app.state.access = Object.freeze({
      mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null
    });
    app.state.view = "editor";
    app.state.projects = Object.freeze([{ projectId: "p", title: "Проект", role: "owner" }]);
    app.state.selectedProjectId = "p";
    app.state.selectedQuestId = "q";
    app.state.quests = Object.freeze([{
      projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "depot", contentHash: "x".repeat(64)
    }]);
    app.state.utilityPanel = panel;
    app.state.editorMenuOpen = menuOpen;
    app.render();
    return { app, root, press };
  });
}

test("GLITCH Escape closes every utility panel (versions/publish/portability/materials/settings)", () => {
  for (const panel of ["versions", "publish", "portability", "materials", "settings"]) {
    const { app, root, press } = bootApp({ panel, menuOpen: true });
    assert.match(root.innerHTML, /class="ed-utility-panel"/, `панель ${panel} открыта до Escape`);
    assert.match(root.innerHTML, /data-action="close-utility-panel"/);
    const handlers = press();
    assert.ok(handlers >= 1, "StudioApp подключает keydown-слушатель к document");
    assert.equal(app.state.utilityPanel, null, `Escape закрыл панель ${panel}`);
    assert.equal(app.state.editorMenuOpen, false, "Escape закрыл меню «…»");
    assert.doesNotMatch(root.innerHTML, /class="ed-utility-panel"/, `панель ${panel} исчезла из DOM`);
  }
});

test("GLITCH Escape without any open layer does not re-render or throw", () => {
  const { app, root, press } = bootApp({ panel: null, menuOpen: false });
  const before = root.innerHTML;
  press();
  assert.equal(app.state.utilityPanel, null);
  assert.equal(app.state.editorMenuOpen, false);
  assert.equal(root.innerHTML, before, "перерисовки при отсутствии открытого слоя нет");
});
