import fs from "node:fs";
const path = "apps/studio/test/author-assistant-ui.test.mjs";
let text = fs.readFileSync(path, "utf8");
const oldBlock = `  const unsafeRead = read(job(), unsafeProposal);\n  unsafeRead.messages[1] = Object.freeze({ ...unsafeRead.messages[1], text: "<script>alert(1)</script>" });\n`;
const newBlock = `  const baseUnsafeRead = read(job(), unsafeProposal);\n  const unsafeRead = Object.freeze({\n    ...baseUnsafeRead,\n    messages: Object.freeze([\n      baseUnsafeRead.messages[0],\n      Object.freeze({ ...baseUnsafeRead.messages[1], text: "<script>alert(1)</script>" })\n    ])\n  });\n`;
if (!text.includes(oldBlock)) throw new Error("unsafe fixture anchor missing");
text = text.replace(oldBlock, newBlock);
fs.writeFileSync(path, text);
