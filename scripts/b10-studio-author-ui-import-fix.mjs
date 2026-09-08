import fs from "node:fs";
const path = "apps/studio/test/author-assistant-ui.test.mjs";
let text = fs.readFileSync(path, "utf8");
const oldValue = 'from "../dist/author-assistant.js";';
const newValue = 'from "../dist/src/author-assistant.js";';
if (!text.includes(oldValue)) throw new Error("Studio author UI import anchor missing");
text = text.replace(oldValue, newValue);
fs.writeFileSync(path, text);
