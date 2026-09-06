import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeGeneratedDocs } from "./generated-docs.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const generated = await writeGeneratedDocs(root);
console.log(`docs:generate ok — ${generated.size} generated contracts written`);
