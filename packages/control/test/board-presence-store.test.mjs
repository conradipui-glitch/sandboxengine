import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_BOARD_PRESENCE_TTL_MS,
  MAX_BOARD_PRESENCE_PARTICIPANTS,
  MemoryControlBoardPresenceStore,
  SQLiteControlBoardPresenceStore
} from "@living-history/control";

/*
 * FIN-13: присутствие доски и конкурентное сохранение раскладки.
 *
 * Обе реализации (Memory и SQLite) прогоняются одним и тем же сценарием: у них
 * один интерфейс, значит и поведение должно совпадать — включая порядок списка,
 * форму конфликта ревизий и идемпотентный повтор. Время всегда передаётся
 * снаружи (`atMs`), поэтому истечение TTL проверяется детерминированно, без
 * ожиданий и таймеров.
 *
 * SQLite-специфичные проверки (два соединения к одному файлу, SQLITE_BUSY,
 * перезапуск процесса) вынесены в хвост: у памяти этих свойств нет.
 */

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const PROJECT = "project-1";
const QUEST = "quest-1";

const KINDS = ["memory", "sqlite"];

async function harness(kind, t) {
  if (kind === "memory") return { store: new MemoryControlBoardPresenceStore(), path: null };
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-presence-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, path };
}

function joined(result) {
  assert.equal(result.kind, "joined");
  return result.participant;
}

function subject(subjectId, overrides = {}) {
  return { projectId: PROJECT, questId: QUEST, subjectId, displayName: `Участник ${subjectId}`, atMs: 1_000, ...overrides };
}

function saveInput(overrides = {}) {
  return {
    projectId: PROJECT,
    questId: QUEST,
    subjectId: "subject-a",
    nodeId: "node-1",
    position: { x: 10, y: 20 },
    baseRevision: 0,
    idempotencyKey: "save-1",
    requestHash: H1,
    atMs: 5_000,
    ...overrides
  };
}

/* ───────────────────────────── общий сценарий ──────────────────────────────── */

for (const kind of KINDS) {
  test(`FIN-13 (${kind}): участник появляется в списке, повторный вход не дублирует его`, async (t) => {
    const { store } = await harness(kind, t);

    const first = joined(await store.join(subject("subject-a", { displayName: "Аня", cursor: { x: 1, y: 2 }, nodeId: "node-7" })));
    assert.equal(first.subjectId, "subject-a");
    assert.equal(first.displayName, "Аня");
    assert.deepEqual(first.cursor, { x: 1, y: 2 });
    assert.equal(first.nodeId, "node-7");
    assert.equal(first.joinedAtMs, 1_000);
    assert.equal(first.lastSeenAtMs, 1_000);

    const listed = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], first);

    // Повторный вход — это тот же участник: имя и позиция обновляются,
    // а joinedAtMs остаётся исходным, иначе порядок списка «прыгал» бы.
    const again = joined(await store.join(subject("subject-a", { displayName: "Аня-2", atMs: 1_200 })));
    assert.equal(again.joinedAtMs, 1_000);
    assert.equal(again.lastSeenAtMs, 1_200);
    assert.equal(again.displayName, "Аня-2");
    assert.equal(again.cursor, null);

    const afterSecondJoin = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_200 });
    assert.equal(afterSecondJoin.length, 1);
    assert.equal(afterSecondJoin[0].displayName, "Аня-2");
  });

  test(`FIN-13 (${kind}): TTL считается по внешнему времени, устаревший участник исчезает из списка`, async (t) => {
    const { store } = await harness(kind, t);
    assert.equal(DEFAULT_BOARD_PRESENCE_TTL_MS, 15_000);

    joined(await store.join(subject("subject-a", { atMs: 1_000 })));
    joined(await store.join(subject("subject-b", { atMs: 2_000 })));

    // Ровно на границе TTL участник ещё жив: решение принимается по
    // (lastSeenAtMs, atMs, ttlMs), а не по «примерно».
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 16_000 })).length, 2);

    // На миллисекунду позже — subject-a устарел и в списке его нет.
    const expired = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 16_001 });
    assert.deepEqual(expired.map((entry) => entry.subjectId), ["subject-b"]);

    // Через произвольное время ничего не «воскресает».
    assert.deepEqual((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 999_999 })).map((entry) => entry.subjectId), []);

    // Явный TTL-переопределение действует на конкретное чтение.
    const longLived = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 16_001, ttlMs: 100_000 });
    assert.deepEqual(longLived.map((entry) => entry.subjectId), ["subject-a", "subject-b"]);
  });

  test(`FIN-13 (${kind}): пульс продлевает присутствие и обновляет курсор с узлом`, async (t) => {
    const { store } = await harness(kind, t);
    joined(await store.join(subject("subject-a", { cursor: { x: 1, y: 1 }, nodeId: "node-1" })));

    const pulsed = await store.heartbeat({
      projectId: PROJECT, questId: QUEST, subjectId: "subject-a", cursor: { x: 5, y: 6 }, nodeId: "node-9", atMs: 5_000
    });
    assert.equal(pulsed.kind, "accepted");
    assert.equal(pulsed.participant.lastSeenAtMs, 5_000);
    assert.deepEqual(pulsed.participant.cursor, { x: 5, y: 6 });
    assert.equal(pulsed.participant.nodeId, "node-9");

    // Пульс без координат сохраняет прежние курсор и узел — это heartbeat, не сброс.
    const bare = await store.heartbeat({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a", atMs: 6_000 });
    assert.equal(bare.kind, "accepted");
    assert.deepEqual(bare.participant.cursor, { x: 5, y: 6 });
    assert.equal(bare.participant.nodeId, "node-9");

    // Продлённый пульсом участник жив там, где без пульса уже истёк бы.
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 20_000 })).length, 1);
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 21_001 })).length, 0);

    const ghost = await store.heartbeat({ projectId: PROJECT, questId: QUEST, subjectId: "subject-ghost", atMs: 6_000 });
    assert.equal(ghost.kind, "unknown_subject");
  });

  test(`FIN-13 (${kind}): выход снимает участника сразу, неизвестный выход — absent`, async (t) => {
    const { store } = await harness(kind, t);
    assert.equal((await store.leave({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a" })).kind, "absent");

    joined(await store.join(subject("subject-a")));
    assert.equal((await store.leave({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a" })).kind, "left");
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 })).length, 0);

    // После выхода участник не воскресает пульсом.
    assert.equal((await store.heartbeat({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a", atMs: 1_500 })).kind, "unknown_subject");
    assert.equal((await store.leave({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a" })).kind, "absent");
  });

  test(`FIN-13 (${kind}): порядок списка детерминирован и не зависит от порядка входов`, async (t) => {
    const { store } = await harness(kind, t);
    joined(await store.join(subject("subject-c", { atMs: 3_000 })));
    joined(await store.join(subject("subject-b", { atMs: 1_000 })));
    joined(await store.join(subject("subject-a", { atMs: 1_000 })));

    const listed = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 3_000 });
    assert.deepEqual(listed.map((entry) => entry.subjectId), ["subject-a", "subject-b", "subject-c"]);

    // Вторая комната с обратным порядком входов даёт тот же порядок.
    joined(await store.join(subject("subject-a", { questId: "quest-2" })));
    joined(await store.join(subject("subject-b", { questId: "quest-2", atMs: 1_000 })));
    const other = await store.listPresence({ projectId: PROJECT, questId: "quest-2", atMs: 3_000 });
    assert.deepEqual(other.map((entry) => entry.subjectId), ["subject-a", "subject-b"]);
  });

  test(`FIN-13 (${kind}): структурно неверный запрос отвергается и ничего не пишет`, async (t) => {
    const { store } = await harness(kind, t);

    assert.equal((await store.join(subject(" bad id"))).kind, "invalid_request");
    assert.equal((await store.join(subject("subject-a", { cursor: { x: Number.NaN, y: 0 } }))).kind, "invalid_request");
    assert.equal((await store.join(subject("subject-a", { displayName: "" }))).kind, "invalid_request");
    assert.equal((await store.join(subject("subject-a", { atMs: -1 }))).kind, "invalid_request");
    assert.equal((await store.heartbeat({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a", atMs: 1.5 })).kind, "invalid_request");
    assert.equal((await store.leave({ projectId: "", questId: QUEST, subjectId: "subject-a" })).kind, "invalid_request");
    assert.equal((await store.saveNodePosition(saveInput({ requestHash: "no" }))).kind, "invalid_request");
    assert.equal((await store.saveNodePosition(saveInput({ baseRevision: -1 }))).kind, "invalid_request");
    assert.equal((await store.saveNodePosition(saveInput({ position: { x: 0, y: 10_000_000 } }))).kind, "invalid_request");

    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 })).length, 0);
    assert.equal((await store.getBoard(PROJECT, QUEST)).revision, 0);
  });

  test(`FIN-13 (${kind}): комната ограничена по числу живых участников`, async (t) => {
    const { store } = await harness(kind, t);
    for (let index = 0; index < MAX_BOARD_PRESENCE_PARTICIPANTS; index += 1) {
      assert.equal((await store.join(subject(`subject-${index}`, { atMs: 1_000 }))).kind, "joined");
    }
    assert.equal((await store.join(subject("subject-overflow", { atMs: 1_000 }))).kind, "room_full");
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 })).length, MAX_BOARD_PRESENCE_PARTICIPANTS);

    // Устаревшие не занимают место: после истечения TTL новый участник входит.
    assert.equal((await store.join(subject("subject-later", { atMs: 100_000 }))).kind, "joined");
    // Повторный вход того же участника комнату не переполняет.
    assert.equal((await store.join(subject("subject-0", { atMs: 100_000 }))).kind, "joined");
  });

  test(`FIN-13 (${kind}): правка узла на актуальной ревизии сохраняется и поднимает ревизию`, async (t) => {
    const { store } = await harness(kind, t);

    const empty = await store.getBoard(PROJECT, QUEST);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.positions, {});
    assert.equal(empty.updatedAtMs, null);

    const first = await store.saveNodePosition(saveInput());
    assert.equal(first.kind, "saved");
    assert.equal(first.revision, 1);
    assert.deepEqual(first.positions, { "node-1": { x: 10, y: 20 } });

    const second = await store.saveNodePosition(saveInput({ nodeId: "node-2", position: { x: -4, y: 8 }, baseRevision: 1, idempotencyKey: "save-2", requestHash: H2 }));
    assert.equal(second.kind, "saved");
    assert.equal(second.revision, 2);
    assert.deepEqual(second.positions, { "node-1": { x: 10, y: 20 }, "node-2": { x: -4, y: 8 } });

    const board = await store.getBoard(PROJECT, QUEST);
    assert.equal(board.revision, 2);
    assert.deepEqual(board.positions, { "node-1": { x: 10, y: 20 }, "node-2": { x: -4, y: 8 } });
    assert.equal(board.updatedAtMs, 5_000);

    // Правка того же узла — это новая позиция, а не второй узел.
    const moved = await store.saveNodePosition(saveInput({ position: { x: 11, y: 21 }, baseRevision: 2, idempotencyKey: "save-3", requestHash: H2 }));
    assert.equal(moved.kind, "saved");
    assert.equal(moved.revision, 3);
    assert.deepEqual(moved.positions, { "node-1": { x: 11, y: 21 }, "node-2": { x: -4, y: 8 } });
  });

  test(`FIN-13 (${kind}): устаревшая базовая ревизия даёт конфликт с актуальным состоянием`, async (t) => {
    const { store } = await harness(kind, t);
    assert.equal((await store.saveNodePosition(saveInput({ subjectId: "subject-a" }))).kind, "saved");

    const stale = await store.saveNodePosition(saveInput({
      subjectId: "subject-b", nodeId: "node-2", position: { x: 1, y: 1 }, baseRevision: 0, idempotencyKey: "save-b", requestHash: H2
    }));
    assert.equal(stale.kind, "revision_conflict");
    assert.equal(stale.currentRevision, 1);
    assert.deepEqual(stale.currentPositions, { "node-1": { x: 10, y: 20 } });

    // Проигравший ничего не записал: живая доска осталась прежней.
    const board = await store.getBoard(PROJECT, QUEST);
    assert.equal(board.revision, 1);
    assert.deepEqual(board.positions, { "node-1": { x: 10, y: 20 } });
    assert.equal((await store.saveNodePosition(saveInput({
      subjectId: "subject-b", nodeId: "node-2", position: { x: 1, y: 1 }, baseRevision: 1, idempotencyKey: "save-b2", requestHash: H2
    }))).kind, "saved");
  });

  test(`FIN-13 (${kind}): повтор с тем же ключом — replay, другой запрос с тем же ключом — переиспользование`, async (t) => {
    const { store } = await harness(kind, t);
    const first = await store.saveNodePosition(saveInput());
    assert.equal(first.kind, "saved");
    assert.equal(first.revision, 1);

    // Тот же ключ и тот же хеш запроса — повторная доставка: ответ тот же.
    const replay = await store.saveNodePosition(saveInput());
    assert.equal(replay.kind, "replay");
    assert.equal(replay.revision, 1);
    assert.deepEqual(replay.positions, first.positions);

    // Тот же ключ, но другое тело запроса (иной хеш) — это уже переиспользование.
    const reused = await store.saveNodePosition(saveInput({ nodeId: "node-9", requestHash: H2 }));
    assert.equal(reused.kind, "idempotency_key_reused");

    // Переиспользованный ключ ничего не сломал в живой доске.
    assert.equal((await store.getBoard(PROJECT, QUEST)).revision, 1);
    assert.deepEqual((await store.getBoard(PROJECT, QUEST)).positions, { "node-1": { x: 10, y: 20 } });

    // Новый ключ со свежей базовой ревизией проходит как обычно.
    const next = await store.saveNodePosition(saveInput({ nodeId: "node-2", baseRevision: 1, idempotencyKey: "save-2", requestHash: H2 }));
    assert.equal(next.kind, "saved");
    assert.equal(next.revision, 2);
  });

  test(`FIN-13 (${kind}): параллельные одинаковые правки дают одну победу и один повтор`, async (t) => {
    const { store } = await harness(kind, t);
    const [left, right] = await Promise.all([store.saveNodePosition(saveInput()), store.saveNodePosition(saveInput())]);
    assert.deepEqual([left.kind, right.kind].sort(), ["replay", "saved"]);
    assert.equal(left.revision, 1);
    assert.equal(right.revision, 1);
    assert.deepEqual(left.positions, right.positions);
    assert.equal((await store.getBoard(PROJECT, QUEST)).revision, 1);
  });

  test(`FIN-13 (${kind}): prune снимает только устаревших и сообщает, сколько снял`, async (t) => {
    const { store } = await harness(kind, t);
    joined(await store.join(subject("subject-a", { atMs: 1_000 })));
    joined(await store.join(subject("subject-b", { atMs: 20_000 })));

    const pruned = await store.prune({ atMs: 20_000 });
    assert.equal(pruned.kind, "pruned");
    assert.equal(pruned.removed, 1);
    assert.deepEqual((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 20_000 })).map((entry) => entry.subjectId), ["subject-b"]);

    // Повторный prune уже нечего снимать — и он честно об этом говорит.
    assert.equal((await store.prune({ atMs: 20_000 })).removed, 0);
    assert.equal((await store.prune({ atMs: -5 })).kind, "invalid_request");
  });

  test(`FIN-13 (${kind}): ответы заморожены и не дают испортить состояние стора`, async (t) => {
    const { store } = await harness(kind, t);
    joined(await store.join(subject("subject-a", { cursor: { x: 1, y: 2 }, nodeId: "node-1" })));
    const saved = await store.saveNodePosition(saveInput());
    assert.equal(saved.kind, "saved");

    assert.equal(Object.isFrozen(saved.positions), true);
    assert.equal(Object.isFrozen(saved.positions["node-1"]), true);
    assert.throws(() => { saved.positions["node-1"] = { x: 0, y: 0 }; }, TypeError);
    assert.throws(() => { saved.positions["node-1"].x = 999; }, TypeError);

    const board = await store.getBoard(PROJECT, QUEST);
    assert.equal(Object.isFrozen(board), true);
    assert.equal(Object.isFrozen(board.positions), true);
    assert.throws(() => { board.positions["node-2"] = { x: 0, y: 0 }; }, TypeError);
    assert.deepEqual(await store.getBoard(PROJECT, QUEST).then((snapshot) => snapshot.positions), { "node-1": { x: 10, y: 20 } });

    const listed = await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 });
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(listed[0]), true);
    assert.equal(Object.isFrozen(listed[0].cursor), true);
    assert.throws(() => { listed[0].displayName = "подмена"; }, TypeError);
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 }))[0].displayName, "Участник subject-a");
  });
}

/* ─────────────────────────── только SQLite ────────────────────────────────── */

async function sqlitePair(t) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-presence-pair-"));
  const path = join(dir, "control.sqlite");
  const left = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });
  const right = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });
  t.after(async () => { left.close(); right.close(); await rm(dir, { recursive: true, force: true }); });
  return { left, right, path };
}

test("FIN-13 (sqlite): два соединения к одному файлу — ровно одна победа, второй видит конфликт с живым состоянием", async (t) => {
  const { left, right } = await sqlitePair(t);

  const [leftResult, rightResult] = await Promise.all([
    left.saveNodePosition(saveInput({ subjectId: "subject-a", nodeId: "node-1", position: { x: 10, y: 20 }, idempotencyKey: "save-a", requestHash: H1 })),
    right.saveNodePosition(saveInput({ subjectId: "subject-b", nodeId: "node-2", position: { x: 30, y: 40 }, idempotencyKey: "save-b", requestHash: H2 }))
  ]);

  assert.deepEqual([leftResult.kind, rightResult.kind].sort(), ["revision_conflict", "saved"]);
  const winnerStore = leftResult.kind === "saved" ? left : right;
  const loserStore = leftResult.kind === "saved" ? right : left;
  const won = leftResult.kind === "saved" ? leftResult : rightResult;
  const lost = leftResult.kind === "saved" ? rightResult : leftResult;

  assert.equal(won.revision, 1);
  assert.equal(lost.currentRevision, 1);
  // Проигравший получил ровно то состояние, которое теперь живо, — не «пустое» и не своё.
  assert.deepEqual(lost.currentPositions, won.positions);
  assert.equal(Object.keys(won.positions).length, 1);

  // Оба соединения видят одно и то же: победила одна правка, второй узел не появился.
  const fromLeft = await left.getBoard(PROJECT, QUEST);
  const fromRight = await right.getBoard(PROJECT, QUEST);
  assert.equal(fromLeft.revision, 1);
  assert.deepEqual(fromLeft.positions, fromRight.positions);
  assert.deepEqual(fromLeft.positions, won.positions);
  assert.equal(winnerStore === loserStore, false);

  // Проигравший повторяет правку на актуальной ревизии — и сохраняет её.
  const retry = await loserStore.saveNodePosition(saveInput({
    subjectId: "subject-b", nodeId: "node-2", position: { x: 30, y: 40 }, baseRevision: 1, idempotencyKey: "save-b", requestHash: H2
  }));
  assert.equal(retry.kind, "saved");
  assert.equal(retry.revision, 2);
  assert.deepEqual(retry.positions, { "node-1": { x: 10, y: 20 }, "node-2": { x: 30, y: 40 } });
});

test("FIN-13 (sqlite): занятая база возвращает {kind:'busy'}, а не исключение", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-presence-busy-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });
  const holder = new DatabaseSync(path, { timeout: 0 });
  t.after(async () => { store.close(); holder.close(); await rm(dir, { recursive: true, force: true }); });

  holder.exec("CREATE TABLE IF NOT EXISTS busy_probe (id TEXT PRIMARY KEY) STRICT");
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO busy_probe (id) VALUES (?)").run("held");

  try {
    // Запись при чужой блокировке: honest-код, без исключения и без «тихого успеха».
    assert.equal((await store.join(subject("subject-a"))).kind, "busy");
    assert.equal((await store.heartbeat({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a", atMs: 1_000 })).kind, "busy");
    assert.equal((await store.leave({ projectId: PROJECT, questId: QUEST, subjectId: "subject-a" })).kind, "busy");
    assert.equal((await store.prune({ atMs: 1_000 })).kind, "busy");
    assert.equal((await store.saveNodePosition(saveInput())).kind, "busy");

    // Заблокированная запись не оставила следов: чтения по-прежнему свободны.
    assert.equal((await store.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 1_000 })).length, 0);
    assert.equal((await store.getBoard(PROJECT, QUEST)).revision, 0);
  } finally {
    holder.exec("COMMIT");
  }

  // Блокировка снята — стор снова работает.
  assert.equal((await store.join(subject("subject-a"))).kind, "joined");
  assert.equal((await store.saveNodePosition(saveInput())).kind, "saved");
});

test("FIN-13 (sqlite): схема создаётся идемпотентно, присутствие и доска переживают перезапуск", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-board-presence-restart-"));
  const path = join(dir, "control.sqlite");
  const first = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });

  joined(await first.join(subject("subject-a", { cursor: { x: 3, y: 4 }, nodeId: "node-1" })));
  assert.equal((await first.saveNodePosition(saveInput())).kind, "saved");
  first.close();

  // Второй инстанс на том же файле: CREATE TABLE IF NOT EXISTS не падает на
  // существующих таблицах, а данные не теряются.
  const second = new SQLiteControlBoardPresenceStore({ path, busyTimeoutMs: 0 });
  // Хуки выполняются в порядке регистрации, поэтому уборка идёт последней —
  // иначе Windows не даст удалить ещё открытый файл базы.
  t.after(async () => { second.close(); await rm(dir, { recursive: true, force: true }); });

  const listed = await second.listPresence({ projectId: PROJECT, questId: QUEST, atMs: 2_000 });
  assert.deepEqual(listed.map((entry) => entry.subjectId), ["subject-a"]);
  assert.deepEqual(listed[0].cursor, { x: 3, y: 4 });
  assert.equal(listed[0].nodeId, "node-1");

  // Журнал — WAL: читатели не блокируют писателей, а блокировка пишущих не
  // превращается в исключение (проверяется отдельным тестом выше).
  const probe = new DatabaseSync(path, { timeout: 0 });
  try {
    assert.equal(String(probe.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
  } finally {
    probe.close();
  }

  const board = await second.getBoard(PROJECT, QUEST);
  assert.equal(board.revision, 1);
  assert.deepEqual(board.positions, { "node-1": { x: 10, y: 20 } });

  // Идемпотентный журнал тоже пережил перезапуск: повтор даёт replay, а не вторую запись.
  const replay = await second.saveNodePosition(saveInput());
  assert.equal(replay.kind, "replay");
  assert.equal(replay.revision, 1);
  assert.equal((await second.getBoard(PROJECT, QUEST)).revision, 1);
});
