import test from "node:test";
import assert from "node:assert/strict";

import {
  IN_PORT_SIDES,
  NODE_HEIGHT,
  NODE_WIDTH,
  OUT_PORT_SIDES,
  distributePortSides,
  portAnchor,
  portSlotFraction
} from "../dist/src/board-dom.js";

test("UX: исходящая связь выходит с правой/нижней стороны, входящая — с левой/верхней", () => {
  assert.deepEqual([...OUT_PORT_SIDES], ["right", "bottom"]);
  assert.deepEqual([...IN_PORT_SIDES], ["left", "top"]);
});

test("UX: несколько рёбер одного узла раскладываются по разным сторонам (ветвление)", () => {
  const two = distributePortSides("out", 2);
  assert.equal(two.length, 2);
  assert.notEqual(two[0].side, two[1].side, "две ветки из узла должны уходить в разные стороны");

  const four = distributePortSides("out", 4);
  assert.equal(four.length, 4);
  assert.equal(new Set(four.map((slot) => slot.side)).size >= 2, true);

  const incoming = distributePortSides("in", 3);
  assert.equal(incoming.length, 3);
  for (const slot of incoming) assert.equal(IN_PORT_SIDES.includes(slot.side), true);
  for (const slot of distributePortSides("out", 5)) assert.equal(OUT_PORT_SIDES.includes(slot.side), true);
});

test("UX: слоты внутри одной стороны разнесены, чтобы рёбра не слипались", () => {
  assert.deepEqual(portSlotFraction(0, 1), { index: 0, count: 1, fraction: 0.5 });
  const two = [portSlotFraction(0, 2).fraction, portSlotFraction(1, 2).fraction];
  assert.notEqual(two[0], two[1]);
  assert.equal(two[0] < 0.5 && two[1] > 0.5, true);
  const three = [0, 1, 2].map((index) => portSlotFraction(index, 3).fraction);
  assert.deepEqual(three, [...three].sort((a, b) => a - b), "слоты идут по порядку");
  assert.equal(new Set(three).size, 3);
});

test("UX: точка соединения лежит на ребре карточки, а не в воздухе", () => {
  const x = 100;
  const y = 200;
  assert.deepEqual(portAnchor(x, y, "right", 0.5), { x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 });
  assert.deepEqual(portAnchor(x, y, "bottom", 0.5), { x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT });
  assert.deepEqual(portAnchor(x, y, "left", 0.5), { x, y: y + NODE_HEIGHT / 2 });
  assert.deepEqual(portAnchor(x, y, "top", 0.5), { x: x + NODE_WIDTH / 2, y });
  assert.deepEqual(portAnchor(x, y, "right", 0.25), { x: x + NODE_WIDTH, y: y + NODE_HEIGHT * 0.25 });
  // Высота карточки может отличаться от номинала — точка обязана следовать за фактом.
  assert.deepEqual(portAnchor(x, y, "bottom", 0.5, 160), { x: x + NODE_WIDTH / 2, y: y + 160 });
});
