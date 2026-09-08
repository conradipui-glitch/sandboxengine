import fs from "node:fs";

function patch(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`no change for ${path}`);
  fs.writeFileSync(path, after);
}

patch("packages/control/src/index.ts", (text) => {
  const anchor = '} from "./author-agent-artifacts.js";\n';
  if (!text.includes(anchor)) throw new Error("control export anchor missing");
  return text.replace(anchor, anchor + `export {\n  MAX_AUTHOR_CONVERSATION_MESSAGES,\n  MAX_AUTHOR_CONVERSATION_TEXT_CHARS,\n  MemoryAuthorConversationStore,\n  SQLiteAuthorConversationStore,\n  type AppendAuthorConversationMessageInput,\n  type AppendAuthorConversationMessageResult,\n  type AuthorConversationMessage,\n  type AuthorConversationRole,\n  type AuthorConversationStore\n} from "./author-conversation.js";\n`);
});

patch("apps/server/src/draft-version-http.ts", (text) => {
  const typeAnchor = '  type ControlProjectRole,\n';
  if (!text.includes(typeAnchor)) throw new Error("draft version control type anchor missing");
  text = text.replace(typeAnchor, '  type AuthorConversationStore,\n' + typeAnchor);
  const contextAnchor = '  readonly authorAssistant: AuthorAssistantDependencies | null;\n';
  if (!text.includes(contextAnchor)) throw new Error("draft version assistant context anchor missing");
  return text.replace(contextAnchor, contextAnchor + '  readonly authorConversation: AuthorConversationStore | null;\n');
});

patch("apps/server/src/control-server.ts", (text) => {
  const importAnchor = '  type ControlProjectRole,\n';
  if (!text.includes(importAnchor)) throw new Error("control import anchor missing");
  text = text.replace(importAnchor, '  type AuthorConversationStore,\n' + importAnchor);
  const depsAnchor = '  readonly authorAssistant?: Omit<AuthorAssistantDependencies, "store">;\n';
  if (!text.includes(depsAnchor)) throw new Error("control assistant deps anchor missing");
  text = text.replace(depsAnchor, '  readonly authorAssistant?: Omit<AuthorAssistantDependencies, "store"> & { readonly conversation: AuthorConversationStore };\n');
  const routeContext = '    authorAssistant: authorAssistant ? { ...authorAssistant, store } : null,\n    actorUserId: identity?.user.userId ?? "local-owner",\n';
  if (!text.includes(routeContext)) throw new Error("control draft context anchor missing");
  return text.replace(routeContext, '    authorAssistant: authorAssistant ? { ...authorAssistant, store } : null,\n    authorConversation: authorAssistant?.conversation ?? null,\n    actorUserId: identity?.user.userId ?? "local-owner",\n');
});

patch("apps/server/src/author-job-http.ts", (text) => {
  const importAnchor = '  type AuthorAgentJobRecord,\n';
  if (!text.includes(importAnchor)) throw new Error("author http import anchor missing");
  text = text.replace(importAnchor, importAnchor + '  type AuthorConversationStore,\n');
  const contextAnchor = '  readonly authorAssistant: AuthorAssistantDependencies | null;\n';
  if (!text.includes(contextAnchor)) throw new Error("author http context anchor missing");
  text = text.replace(contextAnchor, contextAnchor + '  readonly authorConversation: AuthorConversationStore | null;\n');

  text = text.replaceAll('context.authorAssistant === null', '(context.authorAssistant === null || context.authorConversation === null)');

  const getAnchor = '    const checkpoints = await context.authorAssistant.jobs.listCheckpoints(jobId);\n    if (!checkpoints) { context.sendNotFound(); return true; }\n    context.sendJson(200, { job, checkpoints });\n';
  if (!text.includes(getAnchor)) throw new Error("author get anchor missing");
  text = text.replace(getAnchor, `    const checkpoints = await context.authorAssistant.jobs.listCheckpoints(jobId);\n    const messages = await context.authorConversation.listMessages(jobId);\n    if (!checkpoints || !messages) { context.sendNotFound(); return true; }\n    const proposalArtifacts = [];\n    const seenTurnKeys = new Set();\n    for (const message of messages) {\n      if (message.proposalTurnKey === null || seenTurnKeys.has(message.proposalTurnKey)) continue;\n      const artifact = await context.authorAssistant.artifacts.getProposalArtifact(jobId, message.proposalTurnKey);\n      if (!artifact || artifact.proposal.proposalId !== message.proposalId) {\n        context.sendJson(500, { error: { code: "AUTHOR_CONVERSATION_ARTIFACT_MISSING" } });\n        return true;\n      }\n      seenTurnKeys.add(message.proposalTurnKey);\n      proposalArtifacts.push(artifact);\n    }\n    context.sendJson(200, { job, checkpoints, messages, proposalArtifacts });\n`);

  const beforeRun = '    const result = await runAuthorAssistantSegment(context.authorAssistant, {\n';
  if (!text.includes(beforeRun)) throw new Error("author segment run anchor missing");
  text = text.replace(beforeRun, `    const authorMessage = await context.authorConversation.appendMessage(jobId, {\n      messageId: \`author-msg-\${requestId.slice("segment-".length)}\`,\n      role: "author",\n      text: body.instruction,\n      proposalId: null,\n      proposalTurnKey: null,\n      createdAtMs: now(context.authorAssistant)\n    });\n    if (authorMessage.kind === "message_id_reused") {\n      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });\n      return true;\n    }\n    if (authorMessage.kind !== "appended" && authorMessage.kind !== "replay") {\n      context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_UNAVAILABLE" } });\n      return true;\n    }\n\n    const result = await runAuthorAssistantSegment(context.authorAssistant, {\n`);

  const sendAnchor = '    sendSegmentResult(context, result);\n    return true;\n';
  if (!text.includes(sendAnchor)) throw new Error("segment send anchor missing");
  text = text.replace(sendAnchor, `    if (result.kind === "proposal_ready") {\n      const proposalTurnKey = sha256(canonicalStringify({\n        jobId,\n        instruction: body.instruction,\n        draftRevision: result.proposal.baseRevision,\n        draftContentHash: result.proposal.baseContentHash\n      }));\n      const assistantMessage = await context.authorConversation.appendMessage(jobId, {\n        messageId: \`assistant-msg-\${requestId.slice("segment-".length)}\`,\n        role: "assistant",\n        text: result.proposal.explanation,\n        proposalId: result.proposal.proposalId,\n        proposalTurnKey,\n        createdAtMs: now(context.authorAssistant)\n      });\n      if (assistantMessage.kind === "message_id_reused") {\n        context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_CONFLICT" } });\n        return true;\n      }\n      if (assistantMessage.kind !== "appended" && assistantMessage.kind !== "replay") {\n        context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_UNAVAILABLE" } });\n        return true;\n      }\n    }\n    sendSegmentResult(context, result);\n    return true;\n`);
  return text;
});

patch("apps/server/test/author-job-http.test.mjs", (text) => {
  const importAnchor = '  MemoryAuthorAgentProposalArtifactStore,\n';
  if (!text.includes(importAnchor)) throw new Error("author HTTP test import anchor missing");
  text = text.replace(importAnchor, importAnchor + '  MemoryAuthorConversationStore,\n');
  const artifactAnchor = '  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);\n';
  if (!text.includes(artifactAnchor)) throw new Error("author HTTP test artifact anchor missing");
  text = text.replace(artifactAnchor, artifactAnchor + '  const conversation = new MemoryAuthorConversationStore(jobs);\n');
  const composeAnchor = '      authorAssistant: { jobs, artifacts, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 }\n';
  if (!text.includes(composeAnchor)) throw new Error("author HTTP test compose anchor missing");
  text = text.replace(composeAnchor, '      authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 }\n');
  const returnAnchor = '  return { store, jobs, artifacts, backend, control, base: `http://${address.host}:${address.port}` };\n';
  if (!text.includes(returnAnchor)) throw new Error("author HTTP test return anchor missing");
  text = text.replace(returnAnchor, '  return { store, jobs, artifacts, conversation, backend, control, base: `http://${address.host}:${address.port}` };\n');
  const readAssert = '    assert.equal(kinds.filter((kind) => kind === "proposal.produced").length, 1);\n    assert.ok(await jobs.getJob(jobId));\n';
  if (!text.includes(readAssert)) throw new Error("author HTTP read assertion anchor missing");
  return text.replace(readAssert, `    assert.equal(kinds.filter((kind) => kind === "proposal.produced").length, 1);\n    assert.equal(read.body.messages.length, 2);\n    assert.equal(read.body.messages[0].role, "author");\n    assert.equal(read.body.messages[0].text, "Add paint");\n    assert.equal(read.body.messages[1].role, "assistant");\n    assert.equal(read.body.messages[1].proposalId, first.body.proposal.proposalId);\n    assert.equal(read.body.proposalArtifacts.length, 1);\n    assert.deepEqual(read.body.proposalArtifacts[0].proposal, first.body.proposal);\n    assert.ok(await jobs.getJob(jobId));\n`);
});
