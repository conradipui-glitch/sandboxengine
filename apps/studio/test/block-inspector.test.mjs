import test from "node:test";
import assert from "node:assert/strict";

import {
  createBlockForKind,
  replaceBlockWithPatch
} from "../dist/src/block-inspector.js";

const base = {
  schemaVersion: "1.0",
  id: "action-1",
  kind: "core.action",
  title: "Рисовать",
  description: "Подробное описание",
  data: {
    actionType: "core.paint",
    resourceId: "paint-1",
    resourceUnitsPerUnit: 2,
    durationSecondsPerUnit: 30,
    allowPartial: true
  }
};

test("inspector replacement preserves canonical fields and emits block.replace", () => {
  const change = replaceBlockWithPatch(base, { title: "Покрасить", description: undefined });
  assert.equal(change.kind, "block.replace");
  assert.equal(change.blockId, "action-1");
  assert.equal(change.block.title, "Покрасить");
  assert.equal(change.block.description, "Подробное описание");
  assert.deepEqual(change.block.data, base.data);
});

test("inspector creates all supported canonical block kinds", () => {
  assert.equal(createBlockForKind("location", { id: "loc-1", title: "Мастерская", description: "Описание" }).kind, "core.location");
  const character = createBlockForKind("character", {
    id: "char-1",
    title: "Ива",
    description: "Персонаж",
    initialLocationId: "loc-1",
    initialStatus: "ready"
  });
  assert.equal(character.kind, "core.character");
  assert.equal(character.data.initialLocationId, "loc-1");
  const resource = createBlockForKind("resource", {
    id: "paint-1",
    title: "Синяя краска",
    description: "Краска",
    unit: "порция",
    initialValue: 2,
    min: 0,
    max: 8
  });
  assert.equal(resource.kind, "core.resource");
  const action = createBlockForKind("action", {
    id: "action-1",
    title: "Рисовать",
    description: "Действие",
    resourceId: "paint-1",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 10,
    allowPartial: false
  });
  assert.equal(action.kind, "core.action");
});

test("inspector rejects invalid action and resource values before Control API", () => {
  assert.throws(() => createBlockForKind("action", {
    id: "action-1", title: "Рисовать", description: "", resourceId: "",
    resourceUnitsPerUnit: 1, durationSecondsPerUnit: 10, allowPartial: false
  }), /resource/i);
  assert.throws(() => createBlockForKind("resource", {
    id: "paint-1", title: "Краска", description: "", unit: "порция",
    initialValue: 9, min: 0, max: 8
  }), /initialValue|max/i);
});
