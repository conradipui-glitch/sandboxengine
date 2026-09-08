from pathlib import Path

path = Path("packages/control/src/author-agent-jobs.ts")
text = path.read_text()

text = text.replace(
    '  | { readonly kind: "job.created" }\n',
    '  | { readonly kind: "job.created" }\n  | { readonly kind: "job.started" }\n',
    1,
)

old_call = '    const fact = transitionFact(input.to, input.failureCode, updated);'
new_call = '    const fact = transitionFact(current.state, input.to, input.failureCode, updated);'
if text.count(old_call) != 2:
    raise SystemExit(f"expected two transitionFact call anchors, found {text.count(old_call)}")
text = text.replace(old_call, new_call)

old_with_state = '''function withState(job: AuthorAgentJobRecord, state: AuthorAgentJobState, atMs: number): AuthorAgentJobRecord {\n  return deepFreeze({ ...job, state, jobVersion: job.jobVersion + 1, updatedAtMs: atMs });\n}\n\nfunction transitionFact(\n  state: AuthorAgentJobState,\n  failureCode: string | undefined,\n  job: AuthorAgentJobRecord\n): AuthorAgentCheckpointFact | null {\n  if (state === "running") return { kind: "job.resumed" };'''
new_with_state = '''function withState(job: AuthorAgentJobRecord, state: AuthorAgentJobState, atMs: number): AuthorAgentJobRecord {\n  const resetSegmentBudget = job.state === "paused_budget" && state === "running";\n  return deepFreeze({\n    ...job,\n    state,\n    jobVersion: job.jobVersion + 1,\n    toolCallsUsed: resetSegmentBudget ? 0 : job.toolCallsUsed,\n    activeTimeMsUsed: resetSegmentBudget ? 0 : job.activeTimeMsUsed,\n    updatedAtMs: atMs\n  });\n}\n\nfunction transitionFact(\n  from: AuthorAgentJobState,\n  state: AuthorAgentJobState,\n  failureCode: string | undefined,\n  job: AuthorAgentJobRecord\n): AuthorAgentCheckpointFact | null {\n  if (state === "running") {\n    if (from === "queued") return { kind: "job.started" };\n    if (from === "paused_budget" || from === "waiting_user") return { kind: "job.resumed" };\n    return null;\n  }'''
if old_with_state not in text:
    raise SystemExit("withState/transitionFact anchor not found")
text = text.replace(old_with_state, new_with_state, 1)

text = text.replace(
    '    case "job.created":\n    case "job.resumed":',
    '    case "job.created":\n    case "job.started":\n    case "job.resumed":',
    1,
)

path.write_text(text)
