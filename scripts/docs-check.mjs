import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGeneratedDocs,
  findStaleGeneratedPaths,
  readCommittedGeneratedDocs
} from "./generated-docs.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/SPECIFICATION.md",
  "docs/STATUS.md",
  "docs/HANDOFF.md",
  "docs/RELEASE-REPORT.md",
  "docs/B12-ACCEPTANCE-MATRIX.md",
  "docs/RUNBOOK.md",
  "docs/MVP.md",
  "docs/BASELINE.md",
  "docs/TEAM.md",
  "docs/agent/README.md"
];

const missing = [];
for (const relative of required) {
  try {
    await readFile(resolve(root, relative), "utf8");
  } catch {
    missing.push(relative);
  }
}
if (missing.length > 0) {
  console.error("Missing required project documents:\n" + missing.join("\n"));
  process.exitCode = 1;
} else {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const agentIndex = await readFile(resolve(root, "docs/agent/README.md"), "utf8");
  const requiredReadmeLinks = [
    "docs/SPECIFICATION.md",
    "docs/HANDOFF.md",
    "docs/RELEASE-REPORT.md",
    "docs/B12-ACCEPTANCE-MATRIX.md",
    "docs/RUNBOOK.md",
    "CHANGELOG.md"
  ];
  const missingReadmeLinks = requiredReadmeLinks.filter((path) => !readme.includes(path));
  if (missingReadmeLinks.length > 0) {
    throw new Error("README must link release navigation: " + missingReadmeLinks.join(", "));
  }
  if (!agentIndex.includes("docs/SPECIFICATION.md")) {
    throw new Error("Agent entry point must point to the specification");
  }

  const expected = await buildGeneratedDocs(root);
  const actual = await readCommittedGeneratedDocs(root);
  const stale = findStaleGeneratedPaths(expected, actual);
  if (stale.length > 0) {
    console.error("Generated agent contracts are stale. Run npm run docs:generate:\n" + stale.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`docs:check ok — ${required.length} navigation documents and ${expected.size} generated contracts are current`);
  }
}
