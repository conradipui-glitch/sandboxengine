// CARD-META: карточка миссии в списке проекта показывает реальные метаданные и
// различает копии.
//
// Дефект: «Мастерская под давлением» и её копия «миссия 2» выглядели в списке
// одинаково — заголовок и всё. Карточка добавляет создано/изменено, автора,
// ревизию и публикацию; отсутствующее поле честно говорит «нет данных», а
// выдуманного ярлыка «копия» нет — различие несут настоящие данные.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_NO_DATA,
  MISSION_PUBLISHED_LABEL,
  MISSION_DRAFT_LABEL,
  formatMissionDate,
  missionAuthorLabel,
  missionRevisionLabel,
  missionPublicationLabel,
  missionCardHtml,
  missionRailItemHtml
} from "../dist/src/mission-card.js";

const CREATED = Date.UTC(2026, 0, 5, 9, 30);
const UPDATED = Date.UTC(2026, 1, 14, 18, 5);

function card(overrides = {}) {
  return {
    questId: "florence",
    title: "Мастерская под давлением",
    draftRevision: 3,
    metadata: {
      contentRevision: 3,
      createdAtMs: CREATED,
      updatedAtMs: UPDATED,
      authorUserId: "user-1",
      authorName: "anna",
      published: true,
      publishedAtMs: UPDATED
    },
    ...overrides
  };
}

test("CARD-META: карточка миссии показывает создано, изменено, автора и ревизию", () => {
  const html = missionCardHtml(card());
  assert.match(html, /Мастерская под давлением/);
  assert.ok(html.includes(formatMissionDate(CREATED)), "строка «Создано» с настоящей датой");
  assert.ok(html.includes(formatMissionDate(UPDATED)), "строка «Изменено» с настоящей датой");
  assert.match(html, /anna/, "имя автора");
  assert.match(html, /Ревизия 3/);
  assert.ok(html.includes(MISSION_PUBLISHED_LABEL), "ярлык публикации");
  assert.match(html, /ID: florence/, "id миссии — последняя честная опора различия");
  // Текст переносится, а не обрезается многоточием.
  assert.doesNotMatch(html, /line-clamp/);
  assert.doesNotMatch(html, /…/);
});

test("CARD-META: копии с одинаковым названием различимы по реальным метаданным", () => {
  const original = card();
  const copy = card({
    questId: "florence-copy",
    title: "Мастерская под давлением",
    metadata: {
      contentRevision: 1,
      createdAtMs: UPDATED,
      updatedAtMs: UPDATED,
      authorUserId: "user-2",
      authorName: "boris",
      published: false,
      publishedAtMs: null
    }
  });
  const first = missionCardHtml(original);
  const second = missionCardHtml(copy);
  assert.notEqual(first, second, "одинаковые названия дают разные карточки");
  assert.match(second, /boris/);
  assert.match(second, /Ревизия 1/);
  assert.ok(second.includes(MISSION_DRAFT_LABEL), "неопубликованная миссия подписана");
  assert.match(second, /ID: florence-copy/);
  assert.doesNotMatch(first, /ID: florence-copy/);
});

test("CARD-META: без данных — честная подпись, а не выдуманное значение", () => {
  assert.equal(formatMissionDate(null), MISSION_NO_DATA);
  assert.equal(formatMissionDate(undefined), MISSION_NO_DATA);
  assert.equal(formatMissionDate(Number.NaN), MISSION_NO_DATA);
  assert.equal(missionAuthorLabel(null), MISSION_NO_DATA);
  assert.equal(missionAuthorLabel({}), MISSION_NO_DATA);
  assert.equal(missionRevisionLabel({ questId: "q", title: "t", draftRevision: Number.NaN }), MISSION_NO_DATA);
  // Неизвестность публикации — не «черновик».
  assert.equal(missionPublicationLabel(null), null);
  assert.equal(missionPublicationLabel(undefined), null);

  const bare = missionCardHtml({ questId: "bare", title: "Пустая", draftRevision: 0 });
  assert.ok(bare.includes(MISSION_NO_DATA), "даты честно «нет данных»");
  assert.match(bare, /Черновик 0/, "при отсутствии ревизии миссии показана ревизия черновика");
  assert.doesNotMatch(bare, new RegExp(MISSION_PUBLISHED_LABEL));
  assert.doesNotMatch(bare, new RegExp(MISSION_DRAFT_LABEL));
});

test("CARD-META: автор без имени показывается по id, а не молчанием", () => {
  const html = missionCardHtml(card({
    metadata: { contentRevision: 2, createdAtMs: CREATED, updatedAtMs: UPDATED, authorUserId: "user-9", authorName: null, published: null, publishedAtMs: null }
  }));
  assert.match(html, /user-9/);
  assert.doesNotMatch(html, new RegExp(MISSION_DRAFT_LABEL));
  assert.doesNotMatch(html, new RegExp(MISSION_PUBLISHED_LABEL));
});

test("CARD-META: кнопка-карточка сохраняет контракт выбора миссии", () => {
  const html = missionRailItemHtml(card(), true);
  assert.match(html, /data-action="select-quest"/);
  assert.match(html, /data-quest-id="florence"/);
  assert.match(html, /class="rail-item active"/);
  assert.match(html, /class="rail-meta"/);
});
