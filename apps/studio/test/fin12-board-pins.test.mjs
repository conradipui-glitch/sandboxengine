import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BOARD_PINS_SCHEMA_VERSION,
  PIN_MARKER_MARGIN,
  PIN_MARKER_RADIUS,
  PIN_ORPHAN_REASON_TEXT,
  boardModelPinAnchors,
  boardPinAnchorLabel,
  boardPinMarkerLabel,
  boardPinMarkerText,
  boardPinOrphanMessages,
  boardPinSummary,
  createBoardPin,
  deserializeBoardPins,
  isPinAnchorKind,
  isPinStatus,
  pinMarkerOffsets,
  projectBoardPins,
  renderBoardPinOrphans,
  renderBoardPinsPanel,
  serializeBoardPins,
  storyModelPinAnchors
} from "../dist/src/board-pins.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function pin(overrides = {}) {
  const input = {
    pinId: "pin-1",
    anchorKind: "node",
    anchorId: "node-1",
    authorUserId: "editor",
    lastMessage: "Проверить свет в мастерской",
    unreadCount: 0,
    status: "open",
    updatedAtMs: 1,
    ...overrides
  };
  const built = createBoardPin(input);
  assert.equal(built.ok, true, `fixture pin must be valid: ${JSON.stringify(input)}`);
  return built.pin;
}

function anchor(overrides = {}) {
  return Object.freeze({
    anchorKind: "node",
    anchorId: "node-1",
    x: 0,
    y: 0,
    width: 248,
    height: 112,
    ...overrides
  });
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function panelOptions(overrides = {}) {
  return { canWrite: true, currentUserId: "editor", ...overrides };
}

/* ------------------------------------------------------------------ */
/* 1. Форма пина                                                       */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: createBoardPin собирает замороженный пин и отклоняет мусор по каждому полю", () => {
  const built = createBoardPin({
    pinId: "  pin-9  ",
    anchorKind: "scene",
    anchorId: "  workshop ",
    authorUserId: " editor ",
    lastMessage: "",
    unreadCount: 3,
    status: "resolved",
    updatedAtMs: 42
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.pin, {
    pinId: "pin-9",
    anchorKind: "scene",
    anchorId: "workshop",
    authorUserId: "editor",
    lastMessage: "",
    unreadCount: 3,
    status: "resolved",
    updatedAtMs: 42
  });
  assert.ok(Object.isFrozen(built.pin), "пин неизменяем: интерфейс не мутирует общие данные");

  const bad = [
    [{ pinId: " " }, "board_pins.pin_id"],
    [{ pinId: 5 }, "board_pins.pin_id"],
    [{ anchorKind: "board" }, "board_pins.anchor_kind"],
    [{ anchorKind: "NODE" }, "board_pins.anchor_kind"],
    [{ anchorId: "" }, "board_pins.anchor_id"],
    [{ authorUserId: "   " }, "board_pins.author"],
    [{ lastMessage: null }, "board_pins.message"],
    [{ unreadCount: -1 }, "board_pins.unread_count"],
    [{ unreadCount: 1.5 }, "board_pins.unread_count"],
    [{ status: "closed" }, "board_pins.status"],
    [{ updatedAtMs: Number.NaN }, "board_pins.updated_at"]
  ];
  for (const [override, error] of bad) {
    const result = createBoardPin({
      pinId: "pin-1",
      anchorKind: "node",
      anchorId: "node-1",
      authorUserId: "editor",
      lastMessage: "текст",
      unreadCount: 0,
      status: "open",
      updatedAtMs: 1,
      ...override
    });
    assert.equal(result.ok, false, `должен быть отказ: ${JSON.stringify(override)}`);
    assert.equal(result.error, error);
  }

  assert.equal(isPinAnchorKind("edge"), true);
  assert.equal(isPinAnchorKind("scene"), true);
  assert.equal(isPinAnchorKind("layer"), false);
  assert.equal(isPinStatus("open"), true);
  assert.equal(isPinStatus("resolved"), true);
  assert.equal(isPinStatus("done"), false);
  assert.equal(boardPinAnchorLabel({ anchorKind: "node", anchorId: "n1" }), "Узел n1");
  assert.equal(boardPinAnchorLabel({ anchorKind: "scene", anchorId: "workshop" }), "Сцена workshop");
  assert.equal(boardPinAnchorLabel({ anchorKind: "edge", anchorId: "s:c" }), "Связь s:c");
});

/* ------------------------------------------------------------------ */
/* 2. Проекция: маркер вне габаритов карточки                          */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: маркер стоит над правым верхним углом карточки и никогда не ложится под неё", () => {
  for (const [x, y, width, height] of [[0, 0, 248, 112], [100, 200, 248, 112], [640, 32, 248, 112], [-40, -80, 248, 112]]) {
    const projection = projectBoardPins([pin()], [anchor({ x, y, width, height })]);
    assert.equal(projection.orphans.length, 0);
    assert.equal(projection.markers.length, 1);
    const marker = projection.markers[0];
    // Карточка занимает [x, x+width] × [y, y+height]; маркер целиком вне её.
    assert.ok(marker.x - PIN_MARKER_RADIUS >= x + width, `маркер правее карточки (${JSON.stringify(marker)})`);
    assert.ok(marker.y + PIN_MARKER_RADIUS <= y, `маркер выше карточки (${JSON.stringify(marker)})`);
    assert.equal(marker.slot, 0);
    assert.equal(marker.slotCount, 1);
    assert.equal(marker.anchorId, "node-1");
  }
  // Опорная точка отступает от угла ровно на PIN_MARKER_MARGIN.
  const single = projectBoardPins([pin()], [anchor({ x: 10, y: 20 })]);
  assert.deepEqual(
    { x: single.markers[0].x, y: single.markers[0].y },
    { x: 10 + 248 + PIN_MARKER_MARGIN, y: 20 - PIN_MARKER_MARGIN }
  );
});

test("FIN-12 пины: связи (edge) привязываются к середине линии, а не к карточке", () => {
  const model = {
    nodes: [
      { id: "a", type: "character", label: "A", x: 0, y: 0, block: {} },
      { id: "b", type: "location", label: "B", x: 600, y: 400, block: {} }
    ],
    edges: [{ id: "a->b", source: "a", target: "b" }],
    entryLocationId: null,
    positions: new Map()
  };
  const anchors = boardModelPinAnchors(model);
  assert.equal(anchors.length, 3);
  const edgeAnchor = anchors.find((entry) => entry.anchorKind === "edge");
  assert.ok(edgeAnchor);
  assert.equal(edgeAnchor.anchorId, "a->b");
  assert.equal(edgeAnchor.x, 124 + 300);
  assert.equal(edgeAnchor.y, 56 + 200);

  const projection = projectBoardPins([pin({ anchorKind: "edge", anchorId: "a->b" })], anchors);
  assert.equal(projection.orphans.length, 0);
  assert.equal(projection.markers.length, 1);
  assert.equal(projection.markers[0].x, edgeAnchor.x + PIN_MARKER_MARGIN);
  assert.equal(projection.markers[0].y, edgeAnchor.y - PIN_MARKER_MARGIN);
});

test("FIN-12 пины: якоря доски сюжета (сцены и выборы) читаются из реальной модели story-model", () => {
  const story = {
    nodes: [
      { id: "workshop", type: "scene", title: "Мастерская", isEntry: true, x: 48, y: 64 },
      { id: "finale", type: "ending", title: "Финал", isEntry: false, x: 648, y: 64 }
    ],
    edges: [
      { id: "workshop:c1", source: "workshop", target: "finale", label: "Уйти", targetTitle: "Финал", choiceId: "c1" }
    ],
    entrySceneId: "workshop",
    positions: new Map()
  };
  const anchors = storyModelPinAnchors(story);
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors[0], { anchorKind: "scene", anchorId: "workshop", x: 48, y: 64, width: 248, height: 112 });

  const projection = projectBoardPins(
    [pin({ pinId: "p-scene", anchorKind: "scene", anchorId: "finale" }), pin({ pinId: "p-edge", anchorKind: "edge", anchorId: "workshop:c1" })],
    anchors
  );
  assert.equal(projection.orphans.length, 0);
  assert.deepEqual(projection.markers.map((marker) => marker.pinId).sort(), ["p-edge", "p-scene"]);
});

/* ------------------------------------------------------------------ */
/* 3. Веер без наложений                                               */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: несколько пинов на одном якоре раскладываются веером без наложений", () => {
  const pins = [pin({ pinId: "p-1" }), pin({ pinId: "p-2" }), pin({ pinId: "p-3" }), pin({ pinId: "p-4" }), pin({ pinId: "p-5" })];
  const projection = projectBoardPins(pins, [anchor({ x: 100, y: 200 })]);
  assert.equal(projection.markers.length, 5);
  assert.equal(projection.orphans.length, 0);

  for (const marker of projection.markers) {
    assert.equal(marker.slotCount, 5);
    // Каждый маркер по-прежнему вне карточки.
    assert.ok(marker.x - PIN_MARKER_RADIUS >= 100 + 248);
    assert.ok(marker.y + PIN_MARKER_RADIUS <= 200);
  }
  for (let i = 0; i < projection.markers.length; i += 1) {
    for (let j = i + 1; j < projection.markers.length; j += 1) {
      const gap = distance(projection.markers[i], projection.markers[j]);
      assert.ok(gap >= 2 * PIN_MARKER_RADIUS, `маркеры ${i} и ${j} накладываются: ${gap}`);
    }
  }
  // Слоты уникальны и идут по порядку.
  assert.deepEqual(projection.markers.map((marker) => marker.slot), [0, 1, 2, 3, 4]);

  // Раскладка детерминирована и не зависит от порядка входного массива.
  const shuffled = [pins[3], pins[1], pins[4], pins[0], pins[2]];
  const again = projectBoardPins(shuffled, [anchor({ x: 100, y: 200 })]);
  assert.deepEqual(again.markers, projection.markers);
  assert.deepEqual(pinMarkerOffsets(5), pinMarkerOffsets(5));
  assert.deepEqual(pinMarkerOffsets(0), []);
  assert.deepEqual(pinMarkerOffsets(-3), []);
  assert.deepEqual(pinMarkerOffsets(1), [{ dx: 0, dy: 0 }]);
});

/* ------------------------------------------------------------------ */
/* 4. Отсев исчезнувших якорей                                         */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: пин с исчезнувшим якорем отсеивается и возвращается явным списком «якорь удалён»", () => {
  const projection = projectBoardPins(
    [pin({ pinId: "p-live", anchorId: "node-1" }), pin({ pinId: "p-dead", anchorKind: "scene", anchorId: "removed-scene" })],
    [anchor({ anchorId: "node-1" })]
  );
  assert.deepEqual(projection.markers.map((marker) => marker.pinId), ["p-live"]);
  assert.equal(projection.orphans.length, 1);
  assert.deepEqual(projection.orphans[0], {
    pinId: "p-dead",
    anchorKind: "scene",
    anchorId: "removed-scene",
    reason: "anchor_deleted",
    message: `Сцена removed-scene — ${PIN_ORPHAN_REASON_TEXT}`
  });
  assert.deepEqual(boardPinOrphanMessages(projection.orphans), [`Сцена removed-scene — ${PIN_ORPHAN_REASON_TEXT}`]);

  // Разный вид якоря с тем же id — это другой якорь: пин на связь не прилипает к узлу.
  const kindMismatch = projectBoardPins([pin({ anchorKind: "edge", anchorId: "node-1" })], [anchor({ anchorId: "node-1" })]);
  assert.equal(kindMismatch.markers.length, 0);
  assert.equal(kindMismatch.orphans.length, 1);

  // Пустой черновик отсеивает всё, но ничего не теряет молча.
  const nothing = projectBoardPins([pin({ pinId: "p-a" }), pin({ pinId: "p-b" })], []);
  assert.deepEqual(nothing.markers, []);
  assert.deepEqual(nothing.orphans.map((orphan) => orphan.pinId), ["p-a", "p-b"]);
});

test("FIN-12 пины: отсеянные пины сортируются детерминированно и не зависят от порядка входа", () => {
  const pins = [
    pin({ pinId: "p-b", anchorKind: "scene", anchorId: "gone" }),
    pin({ pinId: "p-a", anchorKind: "node", anchorId: "gone" }),
    pin({ pinId: "p-c", anchorKind: "edge", anchorId: "gone" })
  ];
  const first = projectBoardPins(pins, []);
  const second = projectBoardPins([pins[1], pins[0], pins[2]], []);
  assert.deepEqual(first.orphans.map((orphan) => orphan.pinId), ["p-c", "p-a", "p-b"]);
  assert.deepEqual(second.orphans, first.orphans);
});

/* ------------------------------------------------------------------ */
/* 5. Сводка панели                                                    */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: сводка сортирует непрочитанные вперёд, внутри группы — самые свежие", () => {
  const pins = [
    pin({ pinId: "old-read", unreadCount: 0, updatedAtMs: 100 }),
    pin({ pinId: "fresh-read", unreadCount: 0, updatedAtMs: 900 }),
    pin({ pinId: "old-unread", unreadCount: 2, updatedAtMs: 300 }),
    pin({ pinId: "fresh-unread", unreadCount: 1, updatedAtMs: 800 }),
    pin({ pinId: "tie-b", unreadCount: 0, updatedAtMs: 900 }),
    pin({ pinId: "tie-a", unreadCount: 0, updatedAtMs: 900 })
  ];
  const summary = boardPinSummary(pins);
  assert.deepEqual(
    summary.rows.map((row) => row.pinId),
    ["fresh-unread", "old-unread", "fresh-read", "tie-a", "tie-b", "old-read"]
  );
  assert.equal(summary.rows[0].anchorLabel, "Узел node-1");
  assert.equal(summary.rows[0].unreadCount, 1);
  assert.ok(Object.isFrozen(summary.rows));
});

test("FIN-12 пины: счётчики сводки считают всего/открыто/закрыто/непрочитанные", () => {
  const summary = boardPinSummary([
    pin({ pinId: "p-1", status: "open", unreadCount: 2 }),
    pin({ pinId: "p-2", status: "open", unreadCount: 0 }),
    pin({ pinId: "p-3", status: "resolved", unreadCount: 1 }),
    pin({ pinId: "p-4", status: "resolved", unreadCount: 0 })
  ]);
  assert.deepEqual(summary.counts, { total: 4, open: 2, resolved: 2, withUnread: 2, unreadMessages: 3 });

  const empty = boardPinSummary([]);
  assert.deepEqual(empty.counts, { total: 0, open: 0, resolved: 0, withUnread: 0, unreadMessages: 0 });
  assert.deepEqual(empty.rows, []);
});

/* ------------------------------------------------------------------ */
/* 6. Текст маркера не обрезается многоточием                          */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: текст маркера — это последняя реплика целиком, без обрезки многоточием", () => {
  const long = "Проверить свет в мастерской и заодно подписать краску на полке у окна, потому что художник просил именно этот кадр";
  const subject = pin({ lastMessage: long, unreadCount: 4 });
  assert.equal(boardPinMarkerText(subject), long);
  const label = boardPinMarkerLabel(subject);
  assert.equal(label, `4 непрочитанных · ${long}`);
  assert.ok(label.includes(long), "полный текст присутствует в подписи маркера");
  assert.ok(!label.includes("…") && !label.includes("..."), "многоточие в маркер не добавляется — правило владельца");
  assert.equal(boardPinMarkerLabel(pin({ lastMessage: long, unreadCount: 0 })), long);
});

test("FIN-12 пины: панель пинов рисует полный текст, счётчики и статусы, экранируя разметку", () => {
  const summary = boardPinSummary([
    pin({ pinId: "p-1", anchorKind: "scene", anchorId: "workshop", lastMessage: "Длинная реплика без обрезки", unreadCount: 3 }),
    pin({ pinId: "p-2", anchorKind: "edge", anchorId: "s:c", status: "resolved", lastMessage: "<script>alert(1)</script>" })
  ]);
  const html = renderBoardPinsPanel(summary, panelOptions());
  assert.match(html, /data-board-pins/);
  assert.match(html, /data-pin-id="p-1"/);
  assert.match(html, /data-status="resolved"/);
  assert.match(html, /Сцена workshop/);
  assert.match(html, /Связь s:c/);
  assert.match(html, /непрочитанных: 3/);
  assert.match(html, /Длинная реплика без обрезки/);
  assert.match(html, /Всего <strong>2<\/strong> · Открыто <strong>1<\/strong> · Закрыто <strong>1<\/strong> · С непрочитанными <strong>1<\/strong>/);
  // Экранирование: серверный текст не становится разметкой.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes("…"), "панель не добавляет многоточие");

  const readOnly = renderBoardPinsPanel(boardPinSummary([pin()]), panelOptions({ canWrite: false, currentUserId: "tester" }));
  assert.match(readOnly, /Только чтение/);
  assert.match(readOnly, /tester/);
  assert.match(renderBoardPinsPanel(boardPinSummary([]), panelOptions()), /Пинов пока нет/);
});

test("FIN-12 пины: отсеянные пины показываются отдельным блоком «якорь удалён», пустой список даёт пустую строку", () => {
  const projection = projectBoardPins([pin({ pinId: "p-dead", anchorKind: "node", anchorId: "removed" })], []);
  const html = renderBoardPinOrphans(projection.orphans);
  assert.match(html, /data-board-pin-orphans/);
  assert.match(html, new RegExp(PIN_ORPHAN_REASON_TEXT));
  assert.match(html, /data-pin-id="p-dead"/);
  assert.match(html, /Узел removed/);
  assert.equal(renderBoardPinOrphans([]), "");
});

/* ------------------------------------------------------------------ */
/* 7. Сериализация                                                     */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: сериализация и десериализация дают round-trip, включая пустой набор", () => {
  const pins = [
    pin({ pinId: "p-1", anchorKind: "node", anchorId: "n1", unreadCount: 2, status: "open", updatedAtMs: 10 }),
    pin({ pinId: "p-2", anchorKind: "scene", anchorId: "workshop", lastMessage: "Нужен другой фон", status: "resolved", updatedAtMs: 20 }),
    pin({ pinId: "p-3", anchorKind: "edge", anchorId: "s:c", lastMessage: "", updatedAtMs: 30 })
  ];
  const raw = serializeBoardPins(pins);
  assert.equal(JSON.parse(raw).schemaVersion, BOARD_PINS_SCHEMA_VERSION);
  const decoded = deserializeBoardPins(raw);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.pins, pins);
  assert.ok(Object.isFrozen(decoded.pins));
  assert.deepEqual(decoded.pins, deserializeBoardPins(serializeBoardPins(decoded.pins)).pins);

  const empty = deserializeBoardPins(serializeBoardPins([]));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.pins, []);
});

test("FIN-12 пины: десериализация отклоняет мусор с кодом ошибки, а не отдаёт пустой список", () => {
  const cases = [
    [null, "board_pins.not_json"],
    [42, "board_pins.not_json"],
    ["{не json", "board_pins.not_json"],
    ["[]", "board_pins.shape"],
    ['"строка"', "board_pins.shape"],
    [JSON.stringify({ schemaVersion: "2.0", pins: [] }), "board_pins.schema_version"],
    [JSON.stringify({ schemaVersion: BOARD_PINS_SCHEMA_VERSION }), "board_pins.pins"],
    [JSON.stringify({ schemaVersion: BOARD_PINS_SCHEMA_VERSION, pins: "нет" }), "board_pins.pins"],
    [JSON.stringify({ schemaVersion: BOARD_PINS_SCHEMA_VERSION, pins: [null] }), "board_pins.pin_shape"],
    [JSON.stringify({ schemaVersion: BOARD_PINS_SCHEMA_VERSION, pins: [["x"]] }), "board_pins.pin_shape"],
    [serializeBoardPins([pin()]).replace('"unreadCount":0', '"unreadCount":-4'), "board_pins.unread_count"],
    [serializeBoardPins([pin()]).replace('"anchorKind":"node"', '"anchorKind":"board"'), "board_pins.anchor_kind"],
    [serializeBoardPins([pin()]).replace('"status":"open"', '"status":"closed"'), "board_pins.status"],
    [serializeBoardPins([pin()]).replace('"authorUserId":"editor"', '"authorUserId":""'), "board_pins.author"]
  ];
  for (const [raw, error] of cases) {
    const decoded = deserializeBoardPins(raw);
    assert.equal(decoded.ok, false, `мусор должен быть отвергнут: ${String(raw)}`);
    assert.equal(decoded.error, error);
  }

  // Дубликат pinId — не «две записи», а повреждённое состояние.
  const duplicate = JSON.stringify({
    schemaVersion: BOARD_PINS_SCHEMA_VERSION,
    pins: [JSON.parse(serializeBoardPins([pin()])).pins[0], JSON.parse(serializeBoardPins([pin()])).pins[0]]
  });
  const decoded = deserializeBoardPins(duplicate);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, "board_pins.duplicate_pin");
});

/* ------------------------------------------------------------------ */
/* 8. Правило владельца: в модуле нет обрезки многоточием              */
/* ------------------------------------------------------------------ */

test("FIN-12 пины: исходник модуля не содержит обрезки многоточием и не копирует escapeHtml", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/board-pins.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /text-overflow\s*:/);
  assert.doesNotMatch(source, /-webkit-line-clamp/);
  assert.doesNotMatch(source, /…/);
  assert.match(source, /from "\.\/dom-escape\.js"/, "escapeHtml/escapeAttr берутся из dom-escape.ts, а не копируются");
  assert.doesNotMatch(source, /const HTML_ESCAPES/);
});
