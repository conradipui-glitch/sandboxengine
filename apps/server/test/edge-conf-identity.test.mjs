// FIN-06 / C18 — край (nginx) обязан доносить ассерт личности до Studio.
//
// Урок стенда 2026-09-16: `auth_request_set` внутри внутреннего `/_gate_check`
// переменные главному запросу НЕ выставляет — ассерт доезжал пустым, и Studio
// отвечала 401 на любой вход (владелец оказался бы заперт снаружи). Переменные
// обязаны жить в том же location, что и `auth_request`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CONF_URL = new URL("../../../deploy/vps/nginx-lhc.conf", import.meta.url);

function locationBlocks(text) {
  const blocks = [];
  const re = /location\s+([^\n{]+)\{/g;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf("\n    }", start);
    if (end === -1) continue;
    const body = text.slice(start, end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    blocks.push({ head: match[1].trim(), body });
  }
  return blocks;
}

test("FIN-06/EDGE: nginx пробрасывает ассерт из того же location, где стоит auth_request", async () => {
  const conf = await readFile(CONF_URL, "utf8");
  const blocks = locationBlocks(conf);
  assert.ok(blocks.length >= 6, `ожидались location-блоки, нашли ${blocks.length}`);

  const studioBlocks = blocks.filter((block) => block.body.includes("X-LHC-Gate-Identity"));
  assert.equal(studioBlocks.length, 2, "ассерт пробрасывают ровно два Studio-location: / и /studio-assets/");
  for (const block of studioBlocks) {
    assert.match(block.body, /auth_request\s+\/_gate_check;/, `location ${block.head}: ассерт без auth_request`);
    assert.match(
      block.body,
      /auth_request_set\s+\$gate_identity\s+\$upstream_http_x_lhc_gate_identity;/,
      `location ${block.head}: нет auth_request_set рядом с auth_request — ассерт доедет пустым`
    );
    assert.match(
      block.body,
      /auth_request_set\s+\$auth_telegram_id\s+\$upstream_http_x_telegram_id;/,
      `location ${block.head}: нет проброса telegram id рядом с auth_request`
    );
  }

  const gateCheck = blocks.find((block) => block.head === "= /_gate_check");
  assert.ok(gateCheck, "внутренний /_gate_check на месте");
  assert.doesNotMatch(
    gateCheck.body,
    /auth_request_set/,
    "auth_request_set внутри /_gate_check не выставляет переменные главного запроса — только рядом с auth_request"
  );
});
