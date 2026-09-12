// Мутационная приёмка: стражи обязаны КРАСНЕТЬ, когда тему убирают.
// Откат — только копией файла (cp), никакого git checkout.
import { copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const NODE = process.execPath;

function runTests(files) {
  const r = spawnSync(NODE, ["--test", ...files], { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  const fail = /^ℹ fail (\d+)/m.exec(out);
  const pass = /^ℹ pass (\d+)/m.exec(out);
  const failing = [...out.matchAll(/^✖ (.+)$/gm)].map((m) => m[1]).slice(0, 6);
  return { code: r.status, fail: fail ? Number(fail[1]) : -1, pass: pass ? Number(pass[1]) : -1, failing };
}

const THEME_TESTS = ["apps/studio/test/themes-site.test.mjs", "apps/studio/test/theme-styles.test.mjs"];
const GUI = ["apps/studio/test/ui-guards.test.mjs"];
const ICON = ["apps/studio/test/themes-site.test.mjs"];

const mutations = [
  {
    id: "M1: убрать светлую тему из styles.css",
    file: "apps/studio/styles.css",
    tests: THEME_TESTS,
    mutate(text) {
      const start = text.indexOf(':root[data-theme="light"] {');
      if (start < 0) throw new Error("нет блока светлой темы");
      const end = text.indexOf("}", start) + 1;
      return text.slice(0, start) + text.slice(end);
    }
  },
  {
    id: "M2: светлая тема стала копией графита (реестр тем)",
    file: "apps/studio/src/theme-palettes.ts",
    tests: THEME_TESTS,
    build: true,
    mutate(text) {
      return text.replace("  light: LIGHT_PALETTE,", "  light: GRAPHITE_PALETTE,");
    }
  },
  {
    id: "M3: вернуть текстовый символ вместо иконки зума",
    file: "apps/studio/src/board-dom.ts",
    tests: ICON,
    build: true,
    mutate(text) {
      return text.replace('makeZoomButton("minus", "Отдалить")', 'makeZoomButton("\u2212", "Отдалить")');
    }
  },
  {
    id: "M4: опустить зум доски ниже 40px",
    file: "apps/studio/styles.css",
    tests: THEME_TESTS,
    mutate(text) {
      return text.replace(/(\.board-zoom button \{\r?\n  width: )40px(;\r?\n  height: )40px/, "$132px$232px");
    }
  },
  {
    id: "M5: вернуть обрезку текста многоточием",
    file: "apps/studio/styles.css",
    tests: THEME_TESTS,
    mutate(text) {
      return text.replace(".ed-save-state { font-size: 12px;", ".ed-save-state { text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-size: 12px;");
    }
  }
];

const results = [];
for (const m of mutations) {
  const backup = `${m.file}.mutation-backup`;
  copyFileSync(m.file, backup);
  try {
    const original = readFileSync(m.file, "utf8");
    const mutated = m.mutate(original);
    if (mutated === original) throw new Error("мутация ничего не изменила");
    writeFileSync(m.file, mutated);
    if (m.build) {
      const b = spawnSync(NODE, ["node_modules/typescript/bin/tsc", "-b", "--force"], { encoding: "utf8" });
      if (b.status !== 0) console.log(`  (сборка мутанта дала код ${b.status} — это тоже отказ)`);
    }
    const r = runTests(m.tests);
    results.push({ id: m.id, red: r.fail > 0 || r.code !== 0, ...r });
    console.log(`[${r.fail > 0 ? "RED (верно)" : "GREEN (мутация не поймана)"}] ${m.id} — fail=${r.fail}, pass=${r.pass}`);
    for (const f of r.failing) console.log(`      ✖ ${f}`);
  } catch (error) {
    results.push({ id: m.id, error: String(error.message) });
    console.log(`[ОШИБКА МУТАЦИИ] ${m.id}: ${error.message}`);
  } finally {
    copyFileSync(backup, m.file);
    unlinkSync(backup);
    if (m.build) spawnSync(NODE, ["node_modules/typescript/bin/tsc", "-b", "--force"], { encoding: "utf8" });
  }
}

const missed = results.filter((r) => !r.red && !r.error);
console.log(`\nмутации: ${results.filter((r) => r.red).length}/${results.length} пойманы стражами`);
writeFileSync("artifacts/themes/mutations.json", `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.exitCode = missed.length === 0 ? 0 : 1;
