// Юнит-тесты чистой проекции доски (apps/studio/src/board-model.ts).
// Доска — представление canonical draft: узлы и связи ВЫВОДЯТСЯ из блоков.
// Запуск (после сборки dist): node --test apps/studio/test/board-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  draftToBoard,
  edgeToDraftChange,
  fallbackPosition,
  EDGE_RULES
} from "../dist/src/board-model.js";

// CONTRACT_SCHEMA_VERSION из packages/contracts/src/schema.ts (зафиксировано на момент написания).
const SCHEMA_VERSION = "1.0";

// ——— Фикстуры: DraftView и блоки по контрактам packages/contracts/src/authoring.ts ———

function locationBlock(id, title, description = "Локация") {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "core.location",
    title,
    description,
    data: {}
  };
}

function characterBlock(id, title, initialLocationId, initialStatus = "idle", description = "Персонаж") {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "core.character",
    title,
    description,
    data: { initialLocationId, initialStatus }
  };
}

function resourceBlock(id, title, unit = "gold", initialValue = 10, min = 0, max = 100, description = "Ресурс") {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "core.resource",
    title,
    description,
    data: { unit, initialValue, min, max }
  };
}

function actionBlock(id, title, resourceId, description = "Действие") {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "core.action",
    title,
    description,
    data: {
      actionType: "core.paint",
      resourceId,
      resourceUnitsPerUnit: 2,
      durationSecondsPerUnit: 30,
      allowPartial: false
    }
  };
}

// DraftView: { projectId, questId, draftRevision, title, entryLocationId, contentHash, blocks }.
// entryLocationId по умолчанию — первая локация среди блоков (или "" для пустого черновика).
function makeDraft(blocks, entryLocationId) {
  return {
    projectId: "project-a",
    questId: "quest-a",
    draftRevision: 7,
    title: "Черновик квеста",
    entryLocationId: entryLocationId ?? (blocks.find((b) => b.kind === "core.location")?.id ?? ""),
    contentHash: "a".repeat(64),
    blocks
  };
}

test("B13 board: draftToBoard создаёт узлы всех четырёх видов и entry-маркер на месте", () => {
  const locEntry = locationBlock("loc-entry", "Порог", "Точка входа");
  const locOther = locationBlock("loc-other", "Зал", "Обычная комната");
  const char = characterBlock("char-hero", "Герой", "loc-entry");
  const res = resourceBlock("res-gold", "Золото");
  const act = actionBlock("act-paint", "Покраска", "res-gold");

  const model = draftToBoard(makeDraft([locEntry, locOther, char, res, act], "loc-entry"));

  // Все блоки стали узлами, по одному на блок.
  assert.equal(model.nodes.length, 5);
  assert.deepEqual(
    model.nodes.map((n) => n.type).sort(),
    ["action", "character", "location", "location", "resource"]
  );
  assert.equal(model.entryLocationId, "loc-entry");

  // Поля узла переносятся из блока без искажений.
  const entryNode = model.nodes.find((n) => n.id === "loc-entry");
  assert.equal(entryNode.type, "location");
  assert.equal(entryNode.label, "Порог");
  assert.equal(entryNode.block.isEntry, true);
  assert.equal(entryNode.block.description, "Точка входа");

  // Маркер entry ровно один: вторая локация не помечена.
  const otherNode = model.nodes.find((n) => n.id === "loc-other");
  assert.equal(otherNode.block.isEntry, false);

  const charNode = model.nodes.find((n) => n.id === "char-hero");
  assert.equal(charNode.type, "character");
  assert.equal(charNode.block.initialLocationId, "loc-entry");
  assert.equal(charNode.block.initialStatus, "idle");

  const resNode = model.nodes.find((n) => n.id === "res-gold");
  assert.equal(resNode.type, "resource");
  assert.deepEqual(
    { unit: resNode.block.unit, initialValue: resNode.block.initialValue, min: resNode.block.min, max: resNode.block.max },
    { unit: "gold", initialValue: 10, min: 0, max: 100 }
  );

  const actNode = model.nodes.find((n) => n.id === "act-paint");
  assert.equal(actNode.type, "action");
  assert.deepEqual(
    {
      resourceId: actNode.block.resourceId,
      resourceUnitsPerUnit: actNode.block.resourceUnitsPerUnit,
      durationSecondsPerUnit: actNode.block.durationSecondsPerUnit,
      allowPartial: actNode.block.allowPartial
    },
    { resourceId: "res-gold", resourceUnitsPerUnit: 2, durationSecondsPerUnit: 30, allowPartial: false }
  );
});

test("B13 board: связи выводятся — character→location «Начинает здесь» и action→resource «Расходует»", () => {
  const loc = locationBlock("loc-a", "Комната");
  const char = characterBlock("char-a", "Герой", "loc-a");
  const res = resourceBlock("res-a", "Золото");
  const act = actionBlock("act-a", "Покраска", "res-a");

  const model = draftToBoard(makeDraft([loc, char, res, act], "loc-a"));

  // Связь character→location выводится из initialLocationId,
  // связь action→resource — из resourceId; ничего между ними не выдумывается.
  assert.deepEqual([...model.edges], [
    {
      id: "edge-character-char-a",
      source: "char-a",
      target: "loc-a",
      kind: "character-initial-location",
      label: "Начинает здесь"
    },
    {
      id: "edge-action-act-a",
      source: "act-a",
      target: "res-a",
      kind: "action-resource",
      label: "Расходует"
    }
  ]);

  // Выведенные виды связей совпадают с разрешёнными правилами EDGE_RULES.
  assert.deepEqual(
    EDGE_RULES.map((rule) => [rule.from, rule.to, rule.label]),
    [
      ["character", "location", "Начинает здесь"],
      ["action", "resource", "Расходует"]
    ]
  );
});

test("B13 board: связи нет, когда цель отсутствует или initialLocationId = null", () => {
  const loc = locationBlock("loc-a", "Комната");
  const charNull = characterBlock("char-null", "Без места", null);
  // initialLocationId указан, но блока с таким id в черновике нет — связь не выводится.
  const charGhost = characterBlock("char-ghost", "Призрачное место", "loc-missing");
  // resourceId указан, но ресурса с таким id нет — связь не выводится.
  const actGhost = actionBlock("act-ghost", "Действие в никуда", "res-missing");

  const model = draftToBoard(makeDraft([loc, charNull, charGhost, actGhost], "loc-a"));

  assert.deepEqual([...model.edges], []);
});

test("B13 board: edgeToDraftChange возвращает block.replace с canonical полем, недопустимые связи — null", () => {
  const loc = locationBlock("loc-a", "Комната");
  const char = characterBlock("char-a", "Герой", null);
  const res = resourceBlock("res-a", "Золото");
  const act = actionBlock("act-a", "Покраска", "res-a");
  const draft = makeDraft([loc, char, res, act], "loc-a");
  const model = draftToBoard(draft);

  // character→location: canonical поле initialLocationId = цель, остальные data сохранены.
  const charChange = edgeToDraftChange(draft, model, "char-a", "loc-a");
  assert.equal(charChange.kind, "block.replace");
  assert.equal(charChange.blockId, "char-a");
  assert.equal(charChange.block.id, "char-a");
  assert.equal(charChange.block.data.initialLocationId, "loc-a");
  assert.equal(charChange.block.data.initialStatus, "idle");

  // action→resource: canonical поле resourceId = цель, остальные data сохранены.
  const actChange = edgeToDraftChange(draft, model, "act-a", "res-a");
  assert.equal(actChange.kind, "block.replace");
  assert.equal(actChange.blockId, "act-a");
  assert.equal(actChange.block.data.resourceId, "res-a");
  assert.equal(actChange.block.data.actionType, "core.paint");
  assert.equal(actChange.block.data.resourceUnitsPerUnit, 2);
  assert.equal(actChange.block.data.durationSecondsPerUnit, 30);
  assert.equal(actChange.block.data.allowPartial, false);

  // Обратное направление и несовпадающие виды связей отклоняются.
  assert.equal(edgeToDraftChange(draft, model, "loc-a", "char-a"), null);
  assert.equal(edgeToDraftChange(draft, model, "res-a", "loc-a"), null);

  // Неизвестные id источника/цели — null.
  assert.equal(edgeToDraftChange(draft, model, "ghost", "loc-a"), null);
  assert.equal(edgeToDraftChange(draft, model, "char-a", "ghost"), null);

  // Исходный черновик не мутируется: изменение — новый объект.
  assert.equal(char.data.initialLocationId, null);
  assert.equal(act.data.resourceId, "res-a");
});

test("K04 board: fallback layout is deterministic and collision-aware across all block kinds", () => {
  const blocks = [
    locationBlock("loc-1", "Место 1"),
    locationBlock("loc-2", "Место 2"),
    locationBlock("loc-3", "Место 3"),
    locationBlock("loc-4", "Место 4"),
    characterBlock("char-1", "Персонаж 1", null),
    characterBlock("char-2", "Персонаж 2", null),
    resourceBlock("res-1", "Ресурс 1"),
    resourceBlock("res-2", "Ресурс 2"),
    actionBlock("act-1", "Действие 1", "res-1"),
    actionBlock("act-2", "Действие 2", "res-1")
  ];
  const model = draftToBoard(makeDraft(blocks, "loc-1"));
  const rectangles = model.nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    right: node.x + 248,
    bottom: node.y + 112
  }));
  for (let i = 0; i < rectangles.length; i += 1) {
    for (let j = i + 1; j < rectangles.length; j += 1) {
      const a = rectangles[i];
      const b = rectangles[j];
      assert.equal(
        a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom,
        false,
        `${a.id} overlaps ${b.id}`
      );
    }
  }
  assert.deepEqual(
    model.nodes.filter((node) => node.type === "location").map(({ x, y }) => ({ x, y })),
    [fallbackPosition("location", 0), fallbackPosition("location", 1), fallbackPosition("location", 2), fallbackPosition("location", 3)]
  );
  assert.equal(new Set(model.nodes.map((node) => `${node.x}:${node.y}`)).size, model.nodes.length);
  assert.ok(fallbackPosition("location", 1).y > fallbackPosition("location", 0).y);
  assert.ok(fallbackPosition("resource", 0).x > fallbackPosition("character", 0).x);
});

test("B13 board: сохранённая позиция из savedPositions переопределяет fallback", () => {
  const locA = locationBlock("loc-a", "Комната");
  const locB = locationBlock("loc-b", "Зал");
  const char = characterBlock("char-a", "Герой", "loc-a");
  const draft = makeDraft([locA, locB, char], "loc-a");
  const savedPositions = new Map([["loc-a", { x: 999, y: 777 }]]);

  const model = draftToBoard(draft, savedPositions);

  // Сохранённая позиция побеждает для loc-a…
  const savedNode = model.nodes.find((n) => n.id === "loc-a");
  assert.equal(savedNode.x, 999);
  assert.equal(savedNode.y, 777);
  assert.deepEqual(model.positions.get("loc-a"), { x: 999, y: 777 });

  // …а остальные узлы лежат на fallback-позициях (индекс внутри своего вида: location 0..1,
  // character начинается с 0 в своей колонке).
  const fallbackNode = model.nodes.find((n) => n.id === "loc-b");
  assert.deepEqual({ x: fallbackNode.x, y: fallbackNode.y }, fallbackPosition("location", 1));
  const charNode = model.nodes.find((n) => n.id === "char-a");
  assert.deepEqual({ x: charNode.x, y: charNode.y }, fallbackPosition("character", 0));
  assert.deepEqual(model.positions.get("char-a"), fallbackPosition("character", 0));
});

test("B13 board: пустой draft даёт пустую доску", () => {
  const model = draftToBoard(makeDraft([], ""));

  assert.equal(model.nodes.length, 0);
  assert.equal(model.edges.length, 0);
  assert.equal(model.entryLocationId, "");
  assert.equal(model.positions.size, 0);
});
