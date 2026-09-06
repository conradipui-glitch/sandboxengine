import test from "node:test";
import assert from "node:assert/strict";
import { createStudioDevServer } from "../dist/src/dev-server.js";

test("B05-02 compiled browser entry is actually served by Studio dev server", async () => {
  const studio = createStudioDevServer({ controlOrigin: "http://127.0.0.1:1" });
  const address = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const script = await fetch(`${origin}/dist/src/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
    const source = await script.text();
    assert.match(source, /Living History Studio|StudioApp|startStudio/);
  } finally {
    await studio.close();
  }
});
