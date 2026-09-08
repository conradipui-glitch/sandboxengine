import fs from "node:fs";

function patch(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`no change for ${path}`);
  fs.writeFileSync(path, after);
}

patch("packages/control/src/author-agent-jobs.ts", (text) => {
  const interfaceAnchor = '  getJob(jobId: string): Promise<AuthorAgentJobRecord | null>;\n';
  if (!text.includes(interfaceAnchor)) throw new Error("job store interface anchor missing");
  text = text.replace(interfaceAnchor, interfaceAnchor + '  listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]>;\n');

  const memoryAnchor = '  async getJob(jobId: string): Promise<AuthorAgentJobRecord | null> {\n    return this.#jobs.get(jobId) ?? null;\n  }\n\n';
  if (!text.includes(memoryAnchor)) throw new Error("memory getJob anchor missing");
  text = text.replace(memoryAnchor, memoryAnchor + `  async listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]> {\n    if (!isId(projectId) || !isId(questId) || !isId(ownerUserId)) return Object.freeze([]);\n    const values = [...this.#jobs.values()]\n      .filter((job) => job.projectId === projectId && job.questId === questId && job.ownerUserId === ownerUserId)\n      .sort(compareJobsNewestFirst)\n      .map(cloneJson);\n    return deepFreeze(values);\n  }\n\n`);

  const sqliteAnchor = '  async getJob(jobId: string): Promise<AuthorAgentJobRecord | null> {\n    this.#assertOpen();\n    if (!isId(jobId)) return null;\n    const row = this.#db.prepare("SELECT * FROM control_author_agent_jobs WHERE job_id = ?").get(jobId);\n    return row ? jobFromRow(row) : null;\n  }\n\n';
  if (!text.includes(sqliteAnchor)) throw new Error("sqlite getJob anchor missing");
  text = text.replace(sqliteAnchor, sqliteAnchor + `  async listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]> {\n    this.#assertOpen();\n    if (!isId(projectId) || !isId(questId) || !isId(ownerUserId)) return Object.freeze([]);\n    const rows = this.#db.prepare(\`\n      SELECT * FROM control_author_agent_jobs\n      WHERE project_id = ? AND quest_id = ? AND owner_user_id = ?\n      ORDER BY updated_at_ms DESC, created_at_ms DESC, job_id ASC\n    \`).all(projectId, questId, ownerUserId);\n    return deepFreeze(rows.map((row: any) => jobFromRow(row)));\n  }\n\n`);

  const helperAnchor = 'function budgetExhausted(job: AuthorAgentJobRecord): boolean {\n';
  if (!text.includes(helperAnchor)) throw new Error("job helper anchor missing");
  return text.replace(helperAnchor, `function compareJobsNewestFirst(left: AuthorAgentJobRecord, right: AuthorAgentJobRecord): number {\n  if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;\n  if (left.createdAtMs !== right.createdAtMs) return right.createdAtMs - left.createdAtMs;\n  return left.jobId.localeCompare(right.jobId);\n}\n\n` + helperAnchor);
});

patch("apps/server/src/author-job-http.ts", (text) => {
  const collectionStart = '  if (collection) {\n    if (context.method !== "POST") { context.sendNotFound(); return true; }\n    const projectId = collection[1];\n    const questId = collection[2];\n    if (!projectId || !questId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }\n    if (!(await context.requireRole(projectId, "editor"))) return true;\n    if (!hasExactQuery(context.url.searchParams, [])) {\n      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });\n      return true;\n    }\n    if (!(await context.requireMutation())) return true;\n';
  if (!text.includes(collectionStart)) throw new Error("author collection anchor missing");
  const replacement = `  if (collection) {\n    const projectId = collection[1];\n    const questId = collection[2];\n    if (!projectId || !questId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }\n    if (!(await context.requireRole(projectId, "editor"))) return true;\n    if (!hasExactQuery(context.url.searchParams, [])) {\n      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });\n      return true;\n    }\n    if (context.method === "GET") {\n      const jobs = await context.authorAssistant.jobs.listJobs(projectId, questId, context.actorUserId);\n      context.sendJson(200, { jobs });\n      return true;\n    }\n    if (context.method !== "POST") { context.sendNotFound(); return true; }\n    if (!(await context.requireMutation())) return true;\n`;
  return text.replace(collectionStart, replacement);
});

patch("apps/server/test/author-job-http.test.mjs", (text) => {
  const anchor = '    assert.ok(await jobs.getJob(jobId));\n\n    const replay = await createEditorJob(base, editorLogin);\n';
  if (!text.includes(anchor)) throw new Error("author HTTP discovery test anchor missing");
  return text.replace(anchor, `    assert.ok(await jobs.getJob(jobId));\n    const discovered = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {\n      headers: sessionHeaders(editorLogin)\n    });\n    assert.equal(discovered.status, 200);\n    assert.equal(discovered.body.jobs.length, 1);\n    assert.equal(discovered.body.jobs[0].jobId, jobId);\n\n    const replay = await createEditorJob(base, editorLogin);\n`);
});
