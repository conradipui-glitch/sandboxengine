#!/usr/bin/env node
// FIN-14: пакет передачи проекта команде.
//
//   node scripts/handoff-package.mjs \
//     --mission <projectId>/<questId>[/<slug>] \
//     --mission <projectId>/<questId>[/<slug>] \
//     [--out <path>] [--root <repo>] [--now <iso>]
//
// Собирает deploy/vps/handoff-manifest.json — один JSON, из которого приглашённый
// участник и следующий разработчик видят: адреса компонентов стенда, состав
// (git SHA, версии Node/npm, имена compose-сервисов), две показательные миссии
// (идентификаторы задаёт оператор в CLI, генератор их не выдумывает), роли и что
// каждая может, и какие инструкции читать.
//
// Честность важнее полноты:
//   - значение, которого нет, — это null и причина, а не правдоподобная заглушка;
//   - секреты, токены, пароли и персональные числовые Telegram ID в манифест не
//     попадают ни как значения, ни как имена переменных (имена отфильтрованы и
//     заменены счётчиком);
//   - идентификаторы миссий берутся только из --mission: генератор офлайн и
//     каталог стенда не опрашивает (см. demoMissions[].verifiedFromCatalog = null).
//
// Коды выхода: 0 — пакет полный; 2 — пакет собран, но данных не хватает
// (меньше двух миссий, недоступны роли из capability-матрицы, нет compose:
// blockers[] перечисляет причины); 1 — ошибка выполнения/аргументов.
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { missions: [], out: null, root: null, now: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mission") options.missions.push(argv[++index] ?? "");
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--now") options.now = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// Идентификатор миссии в CLI: projectId/questId[/slug]. Принимаем без выдумывания:
// что оператор не передал, то и остаётся null с причиной.
function parseMission(spec) {
  const parts = String(spec).split("/").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`invalid --mission "${spec}": expected <projectId>/<questId>[/<slug>]`);
  }
  return { projectId: parts[0], questId: parts[1], slug: parts.length === 3 ? parts[2] : null };
}

const USAGE =
  "usage: node scripts/handoff-package.mjs --mission <projectId>/<questId>[/<slug>] " +
  "--mission <projectId>/<questId>[/<slug>] [--out <path>] [--root <repo>] [--now <iso>]";

// ---------------------------------------------------------------------------
// Правила неразглашения
// ---------------------------------------------------------------------------

// Имена переменных, которыми обозначен секретный материал или персональный
// числовой идентификатор, не перечисляются в манифесте. Пакет передачи не должен
// содержать даже намёка на то, какие именно сущности хранят доступ.
const WITHHELD_NAME = /TOKEN|SECRET|PASSWORD|COOKIE|KEY|TELEGRAM/i;

function publicEnvNames(names) {
  const kept = [];
  let withheld = 0;
  for (const name of names) {
    if (WITHHELD_NAME.test(name)) withheld += 1;
    else kept.push(name);
  }
  return { kept, withheld };
}

// ---------------------------------------------------------------------------
// Чтение фактов из репозитория
// ---------------------------------------------------------------------------

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Имена compose-сервисов и их переменные окружения — из deploy/vps/docker-compose.yml,
// то есть из фактического состава стенда, а не из пересказа.
function parseCompose(text) {
  const services = new Map();
  let current = null;
  let inEnvironment = false;
  let inServices = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[A-Za-z]/.test(raw)) {
      inServices = /^services:\s*$/.test(raw);
      current = null;
      inEnvironment = false;
      continue;
    }
    if (!inServices) continue;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(raw);
    if (header) {
      current = header[1];
      services.set(current, { env: [] });
      inEnvironment = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}environment:\s*$/.test(raw)) { inEnvironment = true; continue; }
    if (/^ {4}[A-Za-z].*:\s*$/.test(raw)) { inEnvironment = false; continue; }
    if (inEnvironment) {
      const entry = /^\s+- ([A-Z0-9_]+)=/.exec(raw);
      if (entry && !services.get(current).env.includes(entry[1])) services.get(current).env.push(entry[1]);
    }
  }
  return services;
}

function gitCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function npmVersion() {
  try {
    const raw = execSync("npm --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d+\.\d+\.\d+/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Роли и права — из docs/CAPABILITY-MATRIX.md. Матрица маршрутов берётся из той же
// таблицы, что проверяет код: пересказывать её своими словами значило бы обещать
// больше, чем доказано.
async function readRoles(root) {
  const relative = "docs/CAPABILITY-MATRIX.md";
  const text = await readText(join(root, relative));
  if (text === null) {
    return { available: false, source: relative, reason: `${relative} не найден: роли и права не подтверждены`, roles: null, routes: null };
  }
  const lines = text.split(/\r?\n/);
  const roles = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^-\s+\*\*(owner|editor|tester)\*\*\s+—\s+(.+)$/.exec(lines[index]);
    if (match) roles.push({ name: match[1], summary: match[2].trim(), sourceLine: index + 1 });
  }
  if (roles.length === 0) {
    return { available: false, source: relative, reason: `${relative} прочитан, но раздел ролей не распознан`, roles: null, routes: null };
  }
  const routes = new Map(roles.map((role) => [role.name, []]));
  for (const line of lines) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] !== "") continue;
    const route = cells[1].replace(/`/g, "");
    const method = cells[2];
    const role = cells[3];
    // Маршрут цитируется как в матрице: часть строк — продолжения с префиксом "...".
    if (!(route.startsWith("/") || route.startsWith("...")) || !routes.has(role)) continue;
    if (method === "Роль") continue;
    routes.get(role).push(`${method.replace(/\s*\(.*\)$/, "")} ${route}`);
  }
  return {
    available: true,
    source: relative,
    rank: "owner > editor > tester (строгий ранг; роль выдаётся участнику проекта и проверяется на сервере)",
    roles: roles.map((role) => ({ ...role, routes: routes.get(role.name) }))
  };
}

const INSTRUCTION_FILES = [
  { path: "docs/TEAM-HANDOFF.md", purpose: "человеческая инструкция: вход, миссия, прохождение, комментарий, частые проблемы" },
  { path: "docs/CAPABILITY-MATRIX.md", purpose: "роли участников и что каждая может (источник roles в этом манифесте)" },
  { path: "deploy/vps/README.md", purpose: "размещение на стенде, вход через gate-бота, приёмка, известные ограничения" },
  { path: "deploy/vps/ACCEPTANCE-checklist.md", purpose: "живая приёмка входа и сессий с реальными людьми" },
  { path: "docs/RUNBOOK.md", purpose: "эксплуатация: запуск, диагностика, восстановление" },
  { path: "docs/TEAM.md", purpose: "зоны ответственности команды и порядок подключения" },
  { path: "docs/STATUS.md", purpose: "текущее состояние проекта и открытые задачи" }
];

async function readInstructions(root) {
  const list = [];
  for (const entry of INSTRUCTION_FILES) {
    const exists = existsSync(join(root, entry.path));
    list.push({
      path: entry.path,
      purpose: entry.purpose,
      exists,
      reason: exists ? null : `${entry.path} отсутствует в этом checkout: инструкция недоступна по указанному пути`
    });
  }
  return list;
}

// Адреса стенда. Хост подтверждается конфигурацией nginx; порты — тем же
// размещением, что описано в deploy/vps/README.md. Ни одно поле не содержит
// секретов: только публичные точки входа и имена переменных окружения.
async function buildAddresses(root, compose) {
  const nginx = await readText(join(root, "deploy/vps/nginx-lhc.conf"));
  let host = null;
  let hostReason = null;
  if (nginx === null) {
    hostReason = "deploy/vps/nginx-lhc.conf не найден: адрес стенда не подтверждён конфигурацией";
  } else {
    const match = /^\s*server_name\s+([^;\s]+)\s*;/m.exec(nginx);
    host = match ? match[1] : null;
    if (host === null) hostReason = "в deploy/vps/nginx-lhc.conf не найден server_name: адрес стенда не подтверждён";
  }
  const envOf = (service) => {
    const entry = compose?.get(service);
    if (!entry) return { envVars: null, envVarsWithheld: null, envVarsReason: `сервис "${service}" не найден в deploy/vps/docker-compose.yml` };
    const { kept, withheld } = publicEnvNames(entry.env);
    return {
      envVars: kept.sort(),
      envVarsWithheld: withheld,
      envVarsReason: kept.length === 0 ? `у сервиса "${service}" не осталось публичных переменных после сокрытия чувствительных имён` : null
    };
  };
  const https = (port, suffix = "/") => (host === null ? null : `https://${host}:${port}${suffix}`);
  const engine = envOf("engine");
  const studio = envOf("studio");
  const gate = envOf("gate");
  const authored = envOf("authored");
  return {
    host,
    hostReason,
    scheme: "https",
    components: [
      {
        name: "studio",
        purpose: "мастерская автора: редактор, доска, ИИ-композер, запуск playtest",
        url: https(8741),
        publicPort: host === null ? null : 8741,
        loopbackPort: 8740,
        composeService: "studio",
        envVars: studio.envVars,
        envVarsWithheld: studio.envVarsWithheld,
        envVarsReason: studio.envVarsReason,
        reason: host === null ? hostReason : null
      },
      {
        name: "control",
        purpose: "Control API движка (сессии, черновики, релизы, публикация)",
        url: null,
        publicPort: null,
        loopbackPort: 8788,
        composeService: "engine",
        envVars: engine.envVars,
        envVarsWithheld: engine.envVarsWithheld,
        envVarsReason: engine.envVarsReason,
        reason: "Control API слушает loopback: наружу выходит только Engine через nginx, прямого публичного адреса нет"
      },
      {
        name: "engine",
        purpose: "runtime API для приложения и Player",
        url: https(8743),
        publicPort: host === null ? null : 8743,
        loopbackPort: 8742,
        composeService: "engine",
        envVars: engine.envVars,
        envVarsWithheld: engine.envVarsWithheld,
        envVarsReason: engine.envVarsReason,
        reason: host === null ? hostReason : null
      },
      {
        name: "authored",
        purpose: "legacy authored-scenario runtime (:8746)",
        url: null,
        publicPort: null,
        loopbackPort: 8746,
        composeService: "authored",
        envVars: authored.envVars,
        envVarsWithheld: authored.envVarsWithheld,
        envVarsReason: authored.envVarsReason,
        reason: "legacy authored runtime слушает loopback :8746 и вызывается движком: публичного адреса у него нет"
      },
      {
        name: "site",
        purpose: "публичный каталог миссий и просмотр playtest",
        url: https(8745),
        publicPort: host === null ? null : 8745,
        loopbackPort: 8745,
        composeService: "studio",
        envVars: studio.envVars,
        envVarsWithheld: studio.envVarsWithheld,
        envVarsReason: studio.envVarsReason,
        reason: host === null ? hostReason : null,
        note: "страница конкретного playtest открывается по пути /p/<playerId>/"
      },
      {
        name: "gate",
        purpose: "Telegram-вход и проверка сессии для Studio и Player",
        url: https(8741, "/gate/"),
        publicPort: host === null ? null : 8741,
        loopbackPort: 8744,
        composeService: "gate",
        envVars: gate.envVars,
        envVarsWithheld: gate.envVarsWithheld,
        envVarsReason: gate.envVarsReason,
        reason: host === null ? hostReason : null
      }
    ],
    accessNote:
      "Вход участника — только через gate-бота: персональная одноразовая ссылка в личном сообщении " +
      "Telegram ставит сессию для Studio. Постоянных ссылок со встроенным доступом в пакет передачи " +
      "не входит по устройству входа."
  };
}

// ---------------------------------------------------------------------------
// Сборка манифеста
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const root = resolve(options.root ?? join(here, ".."));
const outPath = resolve(options.out ?? join(root, "deploy/vps/handoff-manifest.json"));
const now = options.now ? new Date(options.now) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`handoff-package: --now is not a valid date: ${options.now}`);
  process.exit(1);
}

let missionSpecs;
try {
  missionSpecs = options.missions.map(parseMission);
} catch (error) {
  console.error(`handoff-package: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const composeText = await readText(join(root, "deploy/vps/docker-compose.yml"));
  const compose = composeText === null ? null : parseCompose(composeText);
  const commit = gitCommit(root);
  const observedNpm = npmVersion();
  const packageJson = await readText(join(root, "package.json"));
  const declaredNpm = packageJson === null ? null : JSON.parse(packageJson).packageManager ?? null;
  const roles = await readRoles(root);
  const instructions = await readInstructions(root);
  const addresses = await buildAddresses(root, compose);

  const blockers = [];
  if (missionSpecs.length < 2) {
    blockers.push(
      `показательных миссий ${missionSpecs.length} из 2: передайте два --mission <projectId>/<questId>[/<slug>]`
    );
  }
  if (compose === null) blockers.push("deploy/vps/docker-compose.yml не найден: состав сервисов не подтверждён");
  if (!roles.available) blockers.push(roles.reason);
  if (commit === null) blockers.push("git HEAD не определён: версия состава не подтверждена");
  if (addresses.host === null) blockers.push(addresses.hostReason);

  const demoMissions = missionSpecs.map((spec, index) => ({
    index: index + 1,
    id: `mission:${spec.projectId}:${spec.questId}`,
    projectId: spec.projectId,
    questId: spec.questId,
    slug: spec.slug,
    source: `CLI --mission (порядок ${index + 1})`,
    slugReason: spec.slug === null ? "slug не передан в CLI: назначается автором в Studio, генератор его не придумывает" : null,
    verifiedFromCatalog: null,
    verifiedReason:
      "генератор офлайн: каталог стенда не опрашивается, поэтому наличие и публикация миссии этим манифестом не подтверждены"
  }));

  const manifest = {
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    generatedAtMs: now.getTime(),
    status: blockers.length === 0 ? "complete" : "incomplete",
    blockers,
    source: {
      commit,
      commitShort: commit === null ? null : commit.slice(0, 7),
      commitReason: commit === null ? "git rev-parse HEAD недоступен в этом checkout" : null,
      node: process.version,
      npmObserved: observedNpm,
      npmObservedReason: observedNpm === null ? "npm --version не ответил: версия npm в этом окружении не подтверждена" : null,
      npmDeclared: declaredNpm,
      composeServices: compose === null ? null : [...compose.keys()].sort(),
      composeReason: compose === null ? "deploy/vps/docker-compose.yml не найден" : null
    },
    addresses,
    demoMissions,
    roles,
    instructions,
    standOnlySettings: {
      enumerated: false,
      where: "deploy/vps/.env на стенде; имена переменных — в deploy/vps/docker-compose.yml и deploy/vps/README.md",
      note:
        "Значения настроек доступа в пакет передачи не входят и здесь намеренно не перечисляются: " +
        "имена, обозначающие материал доступа или персональный идентификатор, заменены счётчиком envVarsWithheld."
    },
    knownLimitations: [
      "Один активный Player на стенде: одновременный второй playtest даст честный listen_failed (LH_PLAYER_FIXED_PORT).",
      "Права привязаны к подтверждённому числовому Telegram ID; приглашение по @username — предзаявка до первого /start.",
      "Размещение на стенде не является изоляцией исполнения (B13.a2 остаётся PARTIAL).",
      "Этот манифест не подтверждает содержание каталога: идентификаторы миссий заданы оператором в CLI."
    ]
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`handoff-package: ${outPath}`);
  console.log(`  status: ${manifest.status}`);
  console.log(`  commit: ${commit ?? "(не определён)"}  node: ${process.version}  npm: ${observedNpm ?? "(не подтверждён)"}`);
  console.log(`  compose services: ${manifest.source.composeServices?.join(", ") ?? "(не подтверждено)"}`);
  console.log(`  host: ${addresses.host ?? "(не подтверждён)"}  components: ${addresses.components.map((c) => c.name).join(", ")}`);
  for (const mission of demoMissions) {
    console.log(`  mission ${mission.index}: ${mission.id} slug=${mission.slug ?? "(не передан)"}`);
  }
  console.log(`  roles: ${roles.available ? roles.roles.map((r) => r.name).join(", ") : "(недоступны)"}`);
  for (const blocker of blockers) console.log(`  BLOCKER ${blocker}`);
  process.exitCode = blockers.length === 0 ? 0 : 2;
} catch (error) {
  console.error(`handoff-package: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
