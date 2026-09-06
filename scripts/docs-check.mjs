import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const required = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/SPECIFICATION.md",
  "docs/STATUS.md",
  "docs/HANDOFF.md",
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
  if (!readme.includes("docs/SPECIFICATION.md") || !readme.includes("docs/HANDOFF.md")) {
    throw new Error("README must link the specification and handoff");
  }
  if (!agentIndex.includes("docs/SPECIFICATION.md")) {
    throw new Error("Agent entry point must point to the specification");
  }
  console.log(`docs:check ok — ${required.length} navigation documents present`);
}

