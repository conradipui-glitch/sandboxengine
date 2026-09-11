// FIN-04 — the coordinated delivery scripts must be fail-closed, secret-free and
// honest about dry-run. This suite statically audits deploy/vps/deliver-all.sh and
// deploy/vps/deliver-rollback.sh and exercises --dry-run locally.
//
// It never runs a delivery: no SSH, no docker, no git fetch. Only `bash -n` and
// the two scripts' own --dry-run paths are executed, and --dry-run is required to
// execute nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DELIVER = join(REPO_ROOT, "deploy", "vps", "deliver-all.sh");
const ROLLBACK = join(REPO_ROOT, "deploy", "vps", "deliver-rollback.sh");
const PIN = "7e61f9889724f01a5f5c1c2e511093c177ceac6b"; // the currently delivered SHA

const deliverText = readFileSync(DELIVER, "utf8");
const rollbackText = readFileSync(ROLLBACK, "utf8");

function linesOf(text) {
  return text.split(/\r?\n/);
}

function lineIndex(text, needle) {
  const index = linesOf(text).findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `expected to find a line containing ${JSON.stringify(needle)}`);
  return index;
}

// Commands that change state on the stand. Every one of them must be issued
// through run()/capture(), whose bodies are the only place the dry-run switch
// lives — so a dangerous command can never execute outside a dry-run guard.
const DANGEROUS = /(^|\s)(docker\s+compose|git\s+reset\s+--hard|npm\s+--prefix|npm\s+run)\b/;

function assertDangerousCallsAreGuarded(text, name) {
  const offenders = [];
  for (const raw of linesOf(text)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    if (!DANGEROUS.test(line)) continue;
    if (/^(run|capture)\s/.test(line)) continue;
    offenders.push(line);
  }
  assert.deepEqual(offenders, [], `${name}: state-changing commands must be issued via run()/capture() (the dry-run guard), found: ${JSON.stringify(offenders)}`);

  // run() and capture() must actually honour the dry-run switch.
  for (const helper of ["run", "capture"]) {
    const start = text.indexOf(`${helper}() {`);
    assert.ok(start >= 0, `${name}: missing ${helper}() helper`);
    const end = text.indexOf("\n}", start);
    const body = text.slice(start, end);
    assert.match(body, /\[ "\$DRY_RUN" -eq 1 \]/, `${name}: ${helper}() must check $DRY_RUN`);
    assert.match(body, /return 0/, `${name}: ${helper}() must return without executing when dry-run`);
  }
}

test("FIN-04: both delivery scripts pass a bash syntax check (bash -n)", () => {
  for (const [name, file] of [["deliver-all.sh", DELIVER], ["deliver-rollback.sh", ROLLBACK]]) {
    const result = spawnSync("bash", ["-n", file], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: bash -n failed (exit ${result.status})\n${result.stderr || result.error || ""}`);
    assert.equal(result.stdout, "", `${name}: bash -n produced output`);
  }
});

test("FIN-04: deliver-all.sh is fail-closed — the pin is proven an ancestor before any write", () => {
  // A full 40-hex SHA is mandatory and short SHAs are refused.
  assert.match(deliverText, /\[ "\$\{#PIN\}" -eq 40 \]/, "must require a FULL 40-hex pin");
  assert.match(deliverText, /\[!0-9a-f\]/, "must reject non-hex pin characters");

  // fetch → ancestry proof → reset → read-back → clean tree.
  assert.match(deliverText, /git fetch --prune/, "must fetch before resolving the pin");
  assert.match(deliverText, /git merge-base --is-ancestor "\$CURRENT_REMOTE" "\$PIN"/, "must prove the current remote head is an ancestor of the pin");
  assert.match(deliverText, /git cat-file -e "\$\{PIN\}\^\{commit\}"/, "must prove the pin exists after fetch");
  assert.match(deliverText, /git reset --hard "\$PIN"/, "must reset --hard to the pin");
  assert.match(deliverText, /HEAD_SHA="\$\(capture git rev-parse HEAD\)"/, "must read the delivered SHA back");
  assert.match(deliverText, /\[ "\$HEAD_SHA" = "\$PIN" \]/, "must compare the read-back SHA to the pin");
  assert.match(deliverText, /git status --porcelain/, "must check the tree is clean");
  assert.match(deliverText, /\[ -z "\$DIRTY" \]/, "must fail when the tree is dirty");

  // No write may precede the verification: the reset line comes before the
  // first compose build/up line, and every delivery step is guarded.
  const resetAt = lineIndex(deliverText, "git reset --hard \"$PIN\"");
  const firstWriteAt = lineIndex(deliverText, "build engine authored");
  assert.ok(resetAt < firstWriteAt, `pin verification (line ${resetAt}) must precede the first write (line ${firstWriteAt})`);

  const guardCalls = linesOf(deliverText).filter((line) => line.trim() === "require_verified_pin").length;
  assert.ok(guardCalls >= 3, `each delivery step must call require_verified_pin (found ${guardCalls})`);
  assert.match(deliverText, /PIN_VERIFIED=1/, "the guard flag must only flip after the pin is verified");
  const guardFlagAt = lineIndex(deliverText, "PIN_VERIFIED=1");
  assert.ok(guardFlagAt < firstWriteAt, "PIN_VERIFIED must be set before any write");

  // Engine + authored are delivered in one command; gate is never recreated.
  assert.match(deliverText, /up -d --no-deps --force-recreate engine authored/, "engine and authored are delivered by one up command");
  assert.doesNotMatch(deliverText, /force-recreate gate|up[^\n]*\bgate\b/, "this script must never recreate gate");
});

test("FIN-04: secrets live only in the stand file — neither script embeds a key", () => {
  const SECRET_ISH = [
    /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)\s*=\s*["']?[A-Za-z0-9_\-./+]{12,}/,
    /sk-[A-Za-z0-9]{16,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /xox[bap]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b[0-9a-f]{40,}\b/
  ];
  for (const [name, text] of [["deliver-all.sh", deliverText], ["deliver-rollback.sh", rollbackText]]) {
    for (const pattern of SECRET_ISH) {
      assert.doesNotMatch(text, pattern, `${name}: looks like an embedded secret matching ${pattern}`);
    }
    // Secrets are injected by name via --env-file, never read into the script.
    assert.match(text, /--env-file "\$ENV_FILE"/, `${name}: must hand secrets to compose via --env-file "$ENV_FILE"`);
    assert.match(text, /grep -q "\^\$\{key\}=" "\$ENV_FILE"/, `${name}: must check secret variable NAMES in the stand file, not values`);
  }
});

test("FIN-04: --dry-run prints the whole sequence and executes nothing", () => {
  const result = spawnSync("bash", [DELIVER, PIN, "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `dry-run must exit 0, got ${result.status}: ${result.stderr}`);
  const out = `${result.stdout}\n${result.stderr}`;

  for (const expected of [
    "git fetch --prune origin",
    `git reset --hard ${PIN}`,
    "docker compose --env-file deploy/vps/.env -f deploy/vps/docker-compose.yml build engine authored",
    "up -d --no-deps --force-recreate engine authored",
    "build studio",
    "up -d --no-deps studio",
    "127.0.0.1:8742",
    "127.0.0.1:8746",
    "127.0.0.1:8740",
    "gate"
  ]) {
    assert.ok(out.includes(expected), `dry-run output must print ${JSON.stringify(expected)}`);
  }
  assert.ok(out.includes("DRY-RUN: nothing above was executed."), "dry-run must state that nothing was executed");
  assert.ok(/site.*пропущено/.test(out), "without --site the dry-run must report Site as skipped");

  // Dangerous commands only ever appear behind the run()/capture() guard.
  assertDangerousCallsAreGuarded(deliverText, "deliver-all.sh");

  // With --site the site deploy command is part of the printed sequence.
  const withSite = spawnSync("bash", [DELIVER, PIN, "--site", "--site-root", "/tmp/lhc-site", "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(withSite.status, 0, `dry-run with --site must exit 0: ${withSite.stderr}`);
  assert.ok(`${withSite.stdout}`.includes("npm --prefix /tmp/lhc-site run deploy"), "dry-run must print the site deploy command when --site is given");

  // ...but --site without a root is refused, not silently "delivered".
  const missingRoot = spawnSync("bash", [DELIVER, PIN, "--site", "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(missingRoot.status, 1, "--site without --site-root must fail closed");
  assert.match(`${missingRoot.stderr}`, /--site requires --site-root/);
});

test("FIN-04: deliver-rollback.sh resets to the previous SHA and rebuilds ONLY the named images", () => {
  assert.match(rollbackText, /git cat-file -e "\$\{TARGET\}\^\{commit\}"/, "must prove the rollback target exists");
  assert.match(rollbackText, /git reset --hard "\$TARGET"/, "must reset --hard to the target");
  assert.match(rollbackText, /\[ "\$HEAD_SHA" = "\$TARGET" \]/, "must read the SHA back and compare");
  assert.match(rollbackText, /git status --porcelain/, "must check the tree is clean");
  assert.match(rollbackText, /\[ "\$\{#TARGET\}" -eq 40 \]/, "must require a FULL 40-hex target");
  assert.match(rollbackText, /--images is mandatory/, "--images must be mandatory so nothing is rebuilt by surprise");
  assert.match(rollbackText, /is_known_image "\$image"/, "must reject images outside the allowed set");

  // The rebuild loop iterates the requested list only — no hardcoded full stack.
  const buildLoopAt = lineIndex(rollbackText, "build \"$image\"");
  const upLoopAt = lineIndex(rollbackText, "up -d --no-deps --force-recreate \"$image\"");
  assert.ok(buildLoopAt > 0 && upLoopAt > buildLoopAt, "rebuild must build then recreate the same named image");

  const dry = spawnSync("bash", [ROLLBACK, PIN, "--images", "engine", "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(dry.status, 0, `rollback dry-run must exit 0: ${dry.stderr}`);
  const out = `${dry.stdout}\n${dry.stderr}`;
  assert.ok(out.includes("build engine"), "must print the requested engine rebuild");
  assert.ok(out.includes("up -d --no-deps --force-recreate engine"), "must print the engine recreate");
  assert.ok(!out.includes("build studio"), "must NOT rebuild studio when it was not requested");
  assert.ok(!out.includes("build authored"), "must NOT rebuild authored when it was not requested");

  assertDangerousCallsAreGuarded(rollbackText, "deliver-rollback.sh");

  const noImages = spawnSync("bash", [ROLLBACK, PIN, "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(noImages.status, 1, "rollback without --images must fail closed");

  const badImage = spawnSync("bash", [ROLLBACK, PIN, "--images", "gate", "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(badImage.status, 1, "rollback must reject an unknown image name");
});
