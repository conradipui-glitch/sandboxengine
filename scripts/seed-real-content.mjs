// seed-real-content.mjs — наполнение базы реальным квестом Florence Workshop.
//
//   node scripts/seed-real-content.mjs --db <control.sqlite> [--confirm] [--report <file.json>]
//   LH_DATABASE_PATH=<control.sqlite> node scripts/seed-real-content.mjs [--confirm]
//
// Что делает скрипт (идемпотентно):
//   1. Загружает 12 настоящих материалов из examples/florence/assets
//      (6 webp + 6 mp3) через продукт-путь: ingestAsset (LocalAssetStore) +
//      SQLiteControlStore.registerProjectAsset.
//   2. Импортирует документ миссии florence-workshop через SQLiteControlStore.saveMission
//      (не raw INSERT). Тексты собраны ТОЛЬКО из авторитетных источников:
//         examples/florence/{quest-release,blocks,narrative-beats,source-assets,
//                            asset-migration-manifest}.json
//         и локальный checkout сайта (florence-engine.ts / florence.ts / florence-ai.ts /
//         App.tsx / world.ts / mission-legacy-adapter.ts) — процитировано построчно ниже.
//      Ни одного придуманного id или текста нет: для полей без источника оставлены
//      пустые значения, а поля-производные перечислены в отчёте (report.fieldsWithoutSource).
//
// Границы: скрипт пишет ТОЛЬКО в projectId=florence / questId=florence-workshop.
// Проекты acceptance / c18 / m06 не читаются для записи и никогда не изменяются;
// их «отпечаток» (материалы, ревизии квестов и документов) сверяется до/после — при
// расхождении скрипт завершается ошибкой (см. FORBIDDEN_PROJECTS).
//
// Коды выхода: 0 — успех, 2 — требуется --confirm, 1 — ошибка/нарушение границы.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missionContentHash, validateMissionDraft } from "../packages/contracts/dist/index.js";
import { SQLiteControlStore } from "../packages/control/dist/index.js";
import { LocalAssetStore, ingestAsset } from "../packages/assets/dist/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_ROOT = resolve(SCRIPT_DIR, "../examples/florence");
const PROJECT_ID = "florence";
const QUEST_ID = "florence-workshop";
const ACTOR_USER_ID = "local-owner";
// Эти проекты запрещено менять. Их отпечаток сверяется до и после записи.
const FORBIDDEN_PROJECTS = Object.freeze(["acceptance", "c18", "m06"]);

// ---------------------------------------------------------------------------
// Авторитетные русские тексты. Каждый литерал — дословная цитата из источника,
// checkout сайта C:/Temp/lhc-site-wave2 (ветка стенда). Ничего не досочинено.
// ---------------------------------------------------------------------------

// florence-engine.ts:florenceBriefing(turn) — нейтральная ветка (пустая память) для
// каждого хода-сцены. Scene N text = нейтральный briefing хода N.
const SCENE_TEXTS = Object.freeze({
  // florenceBriefing(1)
  "contract-pressure":
    "Лука Орсини ждёт у незакрытой двери. Кардинал обещал показать роспись гостям на закате, не спросив вас о сроке. Джулиано прячет дрожащую руку в фартук. В ящике осталось немного синей краски; на крышке — чужая сургучная печать. Что вы сделаете до того, как Лука раскроет договор?",
  // florenceBriefing(2), нейтральные ветки f.healer/f.closed/f.draft
  "evidence-and-team":
    "Лука ждёт продолжения разговора. Договор пока не изменён. Риччи, старшина гильдии, приносит счёт. В нём оплачена полная порция синего пигмента. Он смотрит на почти пустой ящик: «Кто принимал доставку?»",
  // florenceBriefing(3), нейтральная ветка f.ledger/f.team/f.refused
  "negotiation-position":
    "Лука возвращается к вопросу об оплате. Он хочет получить определённый ответ. Лука разворачивает чистовой договор. Под именем заказчика нет строки для мастерской. Деньги он положит на стол сразу после вашей подписи.",
  // florenceBriefing(4), нейтральная ветка f.advance/f.agreed
  "material-proof":
    "Денег от заказчика вы не получили. Вопрос о договоре остаётся открытым. При свете лампы синий слой выглядит мутным. Проба может объяснить причину; Джулиано тоже кое-что видел при доставке. На каждый из этих следов уйдут время и силы. Можно предложить, как совместить проверку и разговор.",
  // florenceBriefing(5), нейтральная ветка f.pigment/f.testimony/f.withdrawn
  "public-or-rest":
    "Подозрение о поставке ещё не стало доказательством. Лука просит закончить разговор до утра. У арки на площади ждёт Риччи. Ученики хотят знать, будут ли деньги утром. Можно открыть расчёт, остановить работу на ночь или попросить Риччи засвидетельствовать разговор с заказчиком.",
  // florenceBriefing(6), нейтральные ветки f.public/f.rested и f.withdrawn/f.agreed/f.advance
  "final-delivery":
    "Ученики ждут вашего последнего решения у сложенных лесов. Приёмка и оплата пока не согласованы. На стене готов только фрагмент. Утренний свет впервые позволяет увидеть его без лампы. Что вы оставите здесь: акт, расчёт или имя?"
});

// florence-engine.ts:acts — подписи вариантов (кнопок) по id опции, ход 1..6.
const OPTION_LABELS = Object.freeze({
  draft: "Показать незавершённый картон",
  healer: "Отправить Джулиано к лекарю",
  close: "Оставить заказчика за дверью",
  ledger: "Сверить счёт с накладной",
  team: "Спросить учеников об условиях",
  refuse: "Отклонить деньги без подписи",
  counter: "Приложить свои условия",
  advance: "Взять аванс на условиях заказчика",
  protect: "Подписать объяснение задержки",
  pigment: "Сделать пробу синей краски",
  testimony: "Выслушать Джулиано",
  withdraw: "Прекратить сделку",
  "share-ledger": "Положить книгу перед учениками",
  rest: "Погасить рабочие лампы",
  public: "Вынести спор на площадь",
  deliver: "Предъявить готовый фрагмент",
  workshop: "Закрыть заказ и рассчитаться",
  sign: "Оставить своё имя на стене"
});

// florence-engine.ts:ending(id, memory) — первый абзац нейтральной (безусловной)
// ветки для каждого терминального исхода narrative-beats.json.
// fragment-unsealed  <- ending('deliver') без f.agreed/f.advance/f.withdrawn
// authorship-preserved <- ending('sign') без f.agreed
// workshop-retained  <- ending('workshop')
const ENDING_TEXT = Object.freeze({
  "fragment-unsealed":
    "Вы снимаете покрывало с готового фрагмента и оставляете рядом перечень недоделанного. Лука осматривает стену, но без согласованного договора не ставит печать. Сегодня работу увидели. Принять и оплатить её ещё предстоит.",
  "authorship-preserved":
    "Вы ставите своё имя там, где Лука оставил пустое место. Он долго смотрит на буквы, затем закрывает папку: «На таких условиях я принять работу не могу». Имя остаётся на стене. Оплату это движение кисти не принесло.",
  "workshop-retained":
    "Вы закрываете заказ. Лука сворачивает договор, оставляя на столе прямоугольник чистой пыли. Риччи пересчитывает наличное и записывает обязательства: двери мастерской сегодня не опечатывают. Следующий заказ придётся искать заново."
});

// Карты сцен: персонаж-слой. meta — App.tsx (CHAR map: alt/defaultSide) и world.ts
// (имена). ids — движок florence-engine.ts (florence-juliano / florence-secretary /
// florence-guildmaster); мире соответствует source-assets.json
// juliano-portrait / luca-portrait / ricci-portrait.
const CHARACTERS = Object.freeze([
  { engineId: "florence-juliano", assetId: "juliano-portrait", nameMatch: /Джулиано/u, alt: "Ученик Джулиано с кистью и палитрой" },
  { engineId: "florence-secretary", assetId: "luca-portrait", nameMatch: /Лука/u, alt: "Секретарь кардинала с договором и пером" },
  { engineId: "florence-guildmaster", assetId: "ricci-portrait", nameMatch: /Риччи/u, alt: "Старшина флорентийской гильдии с книгой договоров" }
]);

// scene.locationId — florence-engine.ts (turn 2 -> guildhall, turn 5 -> square, иначе workshop).
// background assetId — App.tsx:florenceBackgroundAssets.
const SCENE_LOCATION = Object.freeze({
  "contract-pressure": "workshop",
  "evidence-and-team": "guildhall",
  "negotiation-position": "workshop",
  "material-proof": "workshop",
  "public-or-rest": "piazza",
  "final-delivery": "workshop"
});
const LOCATION_BACKGROUND = Object.freeze({
  workshop: "workshop-background",
  guildhall: "guildhall-background",
  piazza: "piazza-background"
});

// Музыка: сопоставление по смыслу названий треков (разрешено владельцем явно —
// код сайта музыкальный трек к сцене не привязывает). 1:1, все 6 треков.
const SCENE_MUSIC = Object.freeze({
  "contract-pressure": "threshold", // порог мастерской, ночное ожидание
  "evidence-and-team": "guildhall", // зал гильдии
  "negotiation-position": "deadline", // срок и условие заказчика
  "material-proof": "workshop-night", // мастерская ночью
  "public-or-rest": "decision-reveal", // перед решением
  "final-delivery": "dawn-finale" // утренний финал
});
const ENDING_SCREEN = Object.freeze({ background: "workshop-background", music: "dawn-finale" });

// Трансформации слоёв — дословные значения по умолчанию сайта
// (mission-legacy-adapter.ts: SIDE_X = { left: 0.24, center: 0.5, right: 0.76 },
//  y = 0.62, scale = 1, rotation = 0, flipH/flipV = false, opacity = 1, z = 10 + index).
// Слот (left/right) назначается по порядку персонажа — «выбранное значение по умолчанию».
const LAYER_SIDE_X = Object.freeze({ left: 0.24, right: 0.76 });
const LAYER_Y = 0.62;

function parseArgs(argv) {
  const options = { db: null, report: null, confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.db = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--confirm") options.confirm = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assetRef(assetId, hash) {
  return Object.freeze({ assetId, hash });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/seed-real-content.mjs [--db <path>] [--confirm] [--report <file.json>]");
    return 0;
  }
  const dbPath = resolve(options.db ?? process.env.LH_DATABASE_PATH ?? "./data/living-history.sqlite");
  if (!existsSync(dbPath)) {
    console.error(`seed-real-content: database not found: ${dbPath}`);
    return 1;
  }
  if (FORBIDDEN_PROJECTS.includes(PROJECT_ID)) {
    console.error(`seed-real-content: refusing to seed forbidden project ${PROJECT_ID}`);
    return 1;
  }
  const assetsRoot = resolve(dirname(dbPath), "assets");

  // ---- авторитетные источники из репозитория --------------------------------
  const release = await readJson(resolve(EXAMPLES_ROOT, "quest-release.json"));
  const blocks = await readJson(resolve(EXAMPLES_ROOT, "blocks.json"));
  const beatsDoc = await readJson(resolve(EXAMPLES_ROOT, "narrative-beats.json"));
  const sourceAssets = await readJson(resolve(EXAMPLES_ROOT, "source-assets.json"));
  const manifest = await readJson(resolve(EXAMPLES_ROOT, "asset-migration-manifest.json"));
  if (release.questId !== QUEST_ID) throw new Error(`unexpected questId in quest-release.json: ${release.questId}`);
  if (beatsDoc.beats.length !== 6) throw new Error(`expected 6 beats, found ${beatsDoc.beats.length}`);

  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const locationById = new Map(blocks.map((block) => [block.id, block]));

  // 12 материалов: id/kind/mime/alt — из source-assets.json + блоков + App.tsx.
  const materials = [
    ...sourceAssets.visuals.map((visual) => ({
      assetId: visual.id,
      relativePath: visual.targetPath,
      kind: "image",
      mimeType: "image/webp",
      altText: visual.kind === "background"
        ? locationById.get(
          visual.id === "workshop-background" ? "workshop" : visual.id === "guildhall-background" ? "guildhall" : "piazza"
        )?.description ?? null
        : CHARACTERS.find((character) => character.assetId === visual.id)?.alt ?? null
    })),
    ...sourceAssets.audio.map((audio) => ({
      assetId: audio.id,
      relativePath: audio.targetPath,
      kind: "audio",
      mimeType: "audio/mpeg",
      altText: null
    }))
  ];
  if (materials.length !== 12) throw new Error(`expected 12 materials, found ${materials.length}`);

  const store = new SQLiteControlStore({ path: dbPath });
  const assetStore = new LocalAssetStore(assetsRoot);
  try {
    const preflight = await fingerprintForbidden(store);
    const projectExists = (await store.listProjects()).some((project) => project.projectId === PROJECT_ID);
    const existingAssets = projectExists ? await store.listProjectAssets(PROJECT_ID, false) : [];
    const existingMission = projectExists ? await store.getMission(PROJECT_ID, QUEST_ID) : null;
    if ((projectExists || existingAssets.length > 0 || existingMission !== null) && !options.confirm) {
      console.error("seed-real-content: target project already has content; re-run with --confirm to seed idempotently.");
      return 2;
    }

    // ---- проект и квест (только при отсутствии; идемпотентно) ----------------
    if (!projectExists) {
      const created = await store.createProject({ projectId: PROJECT_ID, title: release.title });
      if (created.kind !== "created") throw new Error(`createProject failed: ${created.kind}`);
      console.log(`project: created ${PROJECT_ID} (${release.title})`);
    } else {
      console.log(`project: exists ${PROJECT_ID}`);
    }
    const quests = await store.listQuests(PROJECT_ID);
    if (quests === null) throw new Error("listQuests returned null for an existing project");
    if (!quests.some((quest) => quest.questId === QUEST_ID)) {
      const created = await store.createQuest({
        projectId: PROJECT_ID,
        questId: QUEST_ID,
        title: release.title,
        entryLocationId: release.entryLocationId,
        initialBlocks: blocks
      });
      if (created.kind !== "created") {
        throw new Error(`createQuest failed: ${created.kind} ${JSON.stringify(created.errors ?? [])}`);
      }
      console.log(`quest: created ${QUEST_ID}`);
    } else {
      console.log(`quest: exists ${QUEST_ID}`);
    }

    // ---- загрузка материалов -------------------------------------------------
    const refs = new Map();
    const assetReport = [];
    const byAssetId = new Map(existingAssets.map((entry) => [entry.assetId, entry]));
    for (const material of materials) {
      const filePath = resolve(EXAMPLES_ROOT, material.relativePath);
      const bytes = new Uint8Array(await readFile(filePath));
      const hash = sha256Hex(bytes);
      const expected = manifestByPath.get(`examples/florence/${material.relativePath}`);
      if (!expected) throw new Error(`no manifest entry for ${material.relativePath}`);
      if (expected.sha256 !== hash) {
        throw new Error(`source bytes for ${material.assetId} do not match the migration manifest`);
      }
      let entry = byAssetId.get(material.assetId);
      let action;
      if (entry && entry.hash === hash) {
        action = "reused";
      } else {
        const record = await ingestAsset(assetStore, {
          assetId: material.assetId,
          bytes,
          claimedMimeType: material.mimeType,
          originalFilename: basename(filePath),
          altText: material.altText,
          source: `${sourceAssets.source.repository}@${sourceAssets.source.commit}`,
          rights: null
        });
        const registered = await store.registerProjectAsset(PROJECT_ID, {
          assetId: record.manifest.id,
          hash: record.manifest.hash,
          filename: record.originalFilename,
          mimeType: record.manifest.mimeType,
          kind: record.manifest.kind,
          widthPx: record.manifest.widthPx,
          heightPx: record.manifest.heightPx,
          durationMs: record.manifest.durationMs,
          byteLength: record.byteLength,
          idempotencyKey: `seed-real-florence-asset-${material.assetId}-${hash.slice(0, 16)}`,
          actorUserId: ACTOR_USER_ID
        });
        if (registered.kind !== "registered" && registered.kind !== "replay") {
          throw new Error(`registerProjectAsset(${material.assetId}) failed: ${registered.kind} ${JSON.stringify(registered.errors ?? [])}`);
        }
        entry = registered.asset;
        action = registered.kind === "replay" ? "replayed" : "uploaded";
      }
      if (entry.hash !== hash) throw new Error(`stored hash mismatch for ${material.assetId}`);
      refs.set(material.assetId, assetRef(material.assetId, entry.hash));
      assetReport.push({
        assetId: material.assetId,
        kind: entry.kind,
        mimeType: entry.mimeType,
        sha256: entry.hash,
        byteLength: entry.byteLength,
        action
      });
    }

    // ---- документ миссии -----------------------------------------------------
    const mission = buildMission({ release, beats: beatsDoc.beats, refs });
    const semanticErrors = validateMissionDraft(mission);
    if (semanticErrors.length > 0) {
      throw new Error(`built mission failed validation: ${semanticErrors.join(",")}`);
    }
    const contentHash = await missionContentHash(mission);
    const desired = { ...mission, contentHash };

    const current = await store.getMission(PROJECT_ID, QUEST_ID);
    let missionAction;
    let saved = current;
    if (current && (await missionContentHash(current)) === contentHash) {
      missionAction = "unchanged";
    } else {
      const baseRevision = current ? current.contentRevision : (await store.getMissionHistory(PROJECT_ID, QUEST_ID)).length;
      const result = await store.saveMission(PROJECT_ID, QUEST_ID, {
        baseRevision,
        mission: { ...desired, contentRevision: baseRevision },
        idempotencyKey: `seed-real-florence-mission-${contentHash.slice(0, 32)}`,
        actorUserId: ACTOR_USER_ID
      });
      if (result.kind !== "saved" && result.kind !== "replay") {
        throw new Error(`saveMission failed: ${result.kind} ${JSON.stringify(result.errors ?? [])}`);
      }
      saved = result.mission;
      missionAction = result.kind;
    }

    const verify = await store.getMission(PROJECT_ID, QUEST_ID);
    if (!verify) throw new Error("mission document missing after save");
    if ((await missionContentHash(verify)) !== contentHash) throw new Error("stored mission content hash does not match");

    // ---- проверка границы: чужие проекты не изменены -------------------------
    const postflight = await fingerprintForbidden(store);
    for (const projectId of FORBIDDEN_PROJECTS) {
      if (JSON.stringify(preflight[projectId] ?? null) !== JSON.stringify(postflight[projectId] ?? null)) {
        throw new Error(`forbidden project ${projectId} changed during seeding`);
      }
    }

    const lockedFields = ["dialogue", "screens.intros", "listing.period", "listing.place", "listing.coverAssetId", "listing.estimatedMinutes"];
    const report = {
      dbPath,
      projectId: PROJECT_ID,
      questId: QUEST_ID,
      assets: assetReport,
      assetCount: assetReport.length,
      mission: {
        action: missionAction,
        contentRevision: verify.contentRevision,
        contentHash: verify.contentHash,
        scenes: verify.story.scenes.length,
        endings: verify.story.endings.length,
        reachableEndings: countReachableEndings(verify),
        entrySceneId: verify.story.entrySceneId
      },
      fieldsWithoutSource: [
        "scene.dialogue — статических реплик сцены-открытия в источниках нет, оставлено []",
        "screens.intros — вступительного экрана в источниках нет, оставлено []",
        "choice.conditions — условные ветки (cases) narrative-beats не выражены одним выбором, оставлено []",
        "ending.text — только первый абзац нейтральной ветки florence-engine.ts:ending()"
      ],
      derivedFields: [
        "listing.summary <- florence.ts:createFlorenceState objective",
        "listing.playerRole <- florence.ts:createFlorenceState role",
        "listing.period <- florence.ts date 1512-04-17",
        "listing.place <- title/opening «Флоренция»",
        "listing.coverAssetId <- background входной сцены (workshop-background)",
        "listing.estimatedMinutes <- сумма clockAdvanceSeconds canonicalRoute / 60",
        `screens.layers transform <- дефолты сайта mission-legacy-adapter (x ${LAYER_SIDE_X.left}/${LAYER_SIDE_X.right}, y ${LAYER_Y}, scale 1)`,
        "screens.*.music <- сопоставление по смыслу названий треков",
        "screens.*.layers <- персонаж присутствует, если сцена называет его по имени (иначе дефолт движка)"
      ],
      forbiddenProjectsUnchanged: FORBIDDEN_PROJECTS
    };
    if (options.report) {
      await mkdir(dirname(resolve(options.report)), { recursive: true });
      await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    printReport(report);
    return 0;
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }
}

function countReachableEndings(mission) {
  const reached = new Set();
  for (const scene of mission.story.scenes) {
    for (const choice of scene.choices) {
      if (typeof choice.endingId === "string" && choice.endingId.length > 0) reached.add(choice.endingId);
    }
  }
  return reached.size;
}

// Собирает MissionDraft строго из авторитетных источников.
function buildMission({ release, beats, refs }) {
  const sceneIds = beats.map((beat) => beat.id);
  const connection = (assetId) => refs.get(assetId) ?? null;

  const scenes = beats.map((beat, beatIndex) => {
    const nextSceneId = beatIndex + 1 < sceneIds.length ? sceneIds[beatIndex + 1] : null;
    const text = SCENE_TEXTS[beat.id] ?? "";
    const choices = beat.options.map((option) => {
      const isFinal = beat.id === "final-delivery";
      const endpoint = option.terminal?.reason ?? null;
      return {
        id: option.id,
        label: OPTION_LABELS[option.id] ?? beat.title,
        targetSceneId: isFinal ? null : nextSceneId,
        endingId: isFinal ? endpoint : null,
        conditions: [],
        // Безусловные эффекты опции из narrative-beats.json (type resource.change — валидный GameplayEffect).
        effects: Array.isArray(option.effects) ? option.effects.map((effect) => ({ ...effect })) : []
      };
    });
    return {
      id: beat.id,
      title: beat.title,
      text,
      dialogue: [],
      choices
    };
  });

  const endings = beats
    .find((beat) => beat.id === "final-delivery")
    .options.map((option) => ({
      id: option.terminal.reason,
      title: option.terminal.outcome,
      text: ENDING_TEXT[option.terminal.reason] ?? ""
    }));

  const screens = { intros: [], scenes: {}, endings: {} };
  for (const beat of beats) {
    const location = SCENE_LOCATION[beat.id];
    const backgroundId = LOCATION_BACKGROUND[location];
    const text = SCENE_TEXTS[beat.id] ?? "";
    const cast = CHARACTERS.filter((character) => character.nameMatch.test(text));
    const actors = cast.length > 0 ? cast : [CHARACTERS[1], CHARACTERS[2]];
    const layers = actors.slice(0, 3).map((character, index) => ({
      id: `layer-${beat.id}-${character.assetId}`,
      kind: "actor",
      name: character.alt,
      visible: true,
      locked: false,
      asset: connection(character.assetId),
      x: index === 0 ? LAYER_SIDE_X.left : LAYER_SIDE_X.right,
      y: LAYER_Y,
      scale: 1,
      rotation: 0,
      flipH: false,
      flipV: false,
      opacity: 1,
      z: 10 + index
    }));
    screens.scenes[beat.id] = {
      background: connection(backgroundId),
      inheritBackground: true,
      layers,
      music: connection(SCENE_MUSIC[beat.id])
    };
  }
  for (const ending of endings) {
    screens.endings[ending.id] = {
      background: connection(ENDING_SCREEN.background),
      inheritBackground: false,
      layers: [],
      music: connection(ENDING_SCREEN.music)
    };
  }

  return {
    schemaVersion: "1.0",
    projectId: PROJECT_ID,
    questId: release.questId,
    contentRevision: 0,
    contentHash: "0".repeat(64),
    listing: {
      title: release.title,
      slug: QUEST_ID,
      summary: "К утру договориться с заказчиком о судьбе незаконченной росписи. Вам решать, чем поступиться ради оплаты, здоровья учеников и права назвать себя автором.",
      coverAssetId: LOCATION_BACKGROUND[SCENE_LOCATION[beats[0].id]],
      period: "1512",
      place: "Флоренция",
      playerRole: "Художник и хозяин мастерской",
      estimatedMinutes: estimateMinutes(beats),
      supportedModes: ["choice"]
    },
    story: { entrySceneId: beats[0].id, scenes, endings },
    screens,
    defaults: { background: null, theme: "default", animationPreset: "none" }
  };
}

// estimatedMinutes: сумма clockAdvanceSeconds канонического маршрута (canonicalRoute),
// поделённая на 60 и округлённая. Каждый option.id канонического маршрута принадлежит
// своему beat в порядке beats.
function estimateMinutes(beats) {
  const canonicalRoute = ["draft", "ledger", "counter", "pigment", "public", "deliver"];
  let seconds = 0;
  beats.forEach((beat, index) => {
    const option = beat.options.find((entry) => entry.id === canonicalRoute[index]);
    if (option) seconds += option.clockAdvanceSeconds ?? 0;
  });
  return Math.max(1, Math.round(seconds / 60));
}

async function fingerprintForbidden(store) {
  const fingerprint = {};
  const projects = await store.listProjects();
  for (const project of projects) {
    if (!FORBIDDEN_PROJECTS.includes(project.projectId)) continue;
    const assets = (await store.listProjectAssets(project.projectId, false))
      .map((entry) => `${entry.assetId}:${entry.hash}`)
      .sort();
    const quests = (await store.listQuests(project.projectId)) ?? [];
    const questFingerprints = [];
    for (const quest of quests) {
      const history = await store.getMissionHistory(project.projectId, quest.questId);
      questFingerprints.push(`${quest.questId}:${quest.contentHash}:${history.map((entry) => entry.contentHash).join(",")}`);
    }
    fingerprint[project.projectId] = { assets, quests: questFingerprints.sort() };
  }
  return fingerprint;
}

function printReport(report) {
  console.log(`\nseed-real-content: ${report.projectId}/${report.questId}`);
  console.log(`materials (${report.assetCount}):`);
  for (const asset of report.assets) {
    console.log(`  ${asset.action.padEnd(8)} ${asset.assetId.padEnd(20)} ${asset.kind.padEnd(6)} ${asset.mimeType.padEnd(11)} ${asset.sha256}`);
  }
  console.log(`mission: ${report.mission.action} revision=${report.mission.contentRevision} scenes=${report.mission.scenes} endings=${report.mission.endings} reachable=${report.mission.reachableEndings}`);
  console.log(`mission contentHash: ${report.mission.contentHash}`);
  console.log("fields without source:");
  for (const field of report.fieldsWithoutSource) console.log(`  - ${field}`);
  console.log(`forbidden projects untouched: ${report.forbiddenProjectsUnchanged.join(", ")}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`seed-real-content: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
