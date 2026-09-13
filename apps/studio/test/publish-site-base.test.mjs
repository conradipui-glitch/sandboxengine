import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createStudioDevServer } from "../dist/src/dev-server.js";

/*
 * meta[name="lh-site-base"] — адрес сайта, по которому панель публикации
 * показывает ссылку игрокам (<site-base>/p/<slug>/). Страж держит два обещания:
 *  1) стенд с настроенным адресом отдаёт тег в своём index.html — приложение
 *     (studioSiteBaseUrl) читает его из живой разметки, а не из сборки;
 *  2) без настройки (или с мусором в переменной) тег не выдумывается, и панель
 *     честно сообщает «адрес сайта не настроен».
 */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function fetchIndex(studioPort) {
  const response = await fetch(`http://127.0.0.1:${studioPort}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  return await response.text();
}

const META = /<meta name="lh-site-base" content="([^"]*)">/;

async function withStudio(siteBaseUrl, run) {
  // Статике Control не нужен: заглушка отвечает 404, до неё запросы не доходят.
  const controlStub = createServer((_request, response) => {
    response.statusCode = 404;
    response.end("stub");
  });
  const controlPort = await listen(controlStub);
  const studio = createStudioDevServer({
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    siteBaseUrl
  });
  const studioPort = await studio.listen(0, "127.0.0.1").then((value) => value.port);
  try {
    await run(studioPort);
  } finally {
    await studio.close();
    await close(controlStub);
  }
}

test("стенд с адресом сайта отдаёт meta[name=lh-site-base] в index.html", async () => {
  await withStudio("https://living-history-florence-preview.conradipui.workers.dev/", async (port) => {
    const html = await fetchIndex(port);
    const match = META.exec(html);
    assert.ok(match, "в отданном index.html есть тег адреса сайта");
    assert.equal(match[1], "https://living-history-florence-preview.conradipui.workers.dev");
    assert.ok(html.indexOf('name="lh-site-base"') < html.indexOf("</head>"), "тег стоит внутри <head>");
    // Ровно один источник адреса: повторная вставка не дублирует тег.
    assert.equal(html.match(/lh-site-base/g).length, 1);
  });
});

test("локальный стенд принимает http-адрес и срезает хвостовые слэши", async () => {
  await withStudio("http://127.0.0.1:8791///", async (port) => {
    const html = await fetchIndex(port);
    const match = META.exec(html);
    assert.ok(match);
    assert.equal(match[1], "http://127.0.0.1:8791");
    // Ссылка панели собирается как <base>/p/<slug>/ — с таким content она корректна.
    assert.equal(`${match[1]}/p/example/`, "http://127.0.0.1:8791/p/example/");
  });
});

test("без настройки адрес сайта не выдумывается", async () => {
  await withStudio(null, async (port) => {
    const html = await fetchIndex(port);
    assert.doesNotMatch(html, /lh-site-base/);
  });
});

test("мусор и учётные данные в адресе не превращаются в тег", async () => {
  for (const bad of ["", "   ", "not a url", "javascript:alert(1)", "https://user:pass@site.example", "https://site.example/?next=1", "https://site.example/#x"]) {
    await withStudio(bad, async (port) => {
      const html = await fetchIndex(port);
      assert.doesNotMatch(html, /lh-site-base/, `значение ${JSON.stringify(bad)} не должно давать тег`);
    });
  }
});

test("статика Studio не заражена: css отдаётся как раньше", async () => {
  await withStudio("https://site.example", async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/studio-assets/styles/publish.css`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /lh-site-base/);
  });
});
