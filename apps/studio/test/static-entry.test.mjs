import test from "node:test";
import assert from "node:assert/strict";
import { createStudioDevServer } from "../dist/src/dev-server.js";

// V00: статика Studio живёт только в /studio-assets/* (разводка со стилями Player, F01).
test("B05-02 compiled browser entry is actually served by Studio dev server", async () => {
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1" });
  const address = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const script = await fetch(`${origin}/studio-assets/dist/src/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
    const source = await script.text();
    assert.match(source, /Living History Studio|StudioApp|startStudio/);

    const css = await fetch(`${origin}/studio-assets/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /\.studio-shell/);

    // Корневые пути больше не обслуживаются (их перехватывал Player).
    assert.equal((await fetch(`${origin}/dist/src/app.js`)).status, 404);
    assert.equal((await fetch(`${origin}/styles.css`)).status, 404);
    assert.equal((await fetch(`${origin}/studio-assets/unknown.js`)).status, 404);
  } finally {
    await studio.close();
  }
});
