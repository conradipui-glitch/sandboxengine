import { readFileSync, writeFileSync } from "node:fs";
import { renderPaletteCss } from "./apps/studio/dist/src/theme-palettes.js";

const path = "apps/studio/styles.css";
const raw = readFileSync(path, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const START = "/* ==== theme tokens: start ==== */";
const END = "/* ==== theme tokens: end ==== */";
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end <= start) throw new Error("нет маркеров блока токенов");
src = src.slice(0, start) + renderPaletteCss().trimEnd() + src.slice(end + END.length);

for (const must of ["--canvas: #12110f", "--on-accent: #ffffff", ':root[data-theme="graphite"]', "--font-display"]) {
  if (!src.includes(must)) throw new Error(`пропало: ${must}`);
}
if ((src.match(/theme tokens: start/g) ?? []).length !== 1) throw new Error("дублирован блок токенов");

writeFileSync(path, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src);
console.log("блок токенов перегенерирован:", src.length, "символов");
