import fs from "node:fs";
const path = "apps/server/src/control-server.ts";
let text = fs.readFileSync(path, "utf8");
const oldValue = '  authorAssistant: Omit<AuthorAssistantDependencies, "store"> | null,\n';
const newValue = '  authorAssistant: (Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore }) | null,\n';
if (!text.includes(oldValue)) throw new Error("author assistant route type anchor missing");
text = text.replace(oldValue, newValue);
fs.writeFileSync(path, text);
