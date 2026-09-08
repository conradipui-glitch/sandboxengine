# B10.b.12 — external task package

Bounded slice: export a deterministic inert standalone task package only from an exact server-persisted proposal missing capability.

Required evidence before GREEN:

- package includes exact installed engine/schema/plugin/API/registry/docs identity and exact missing capability ID;
- package contains allowlisted plugin change paths, embedded bounded schema snapshots, plugin recipe, invariants/forbidden actions, verification commands, test examples, expected changes and migration notes;
- builder receives no ControlStore/draft/conversation and structurally omits project/quest/explanation/unrelated blocks;
- credential-shaped goal text fails closed;
- a capability already installed in the current registry is treated as stale instead of exported;
- HTTP reads only the editor-owned persisted proposal artifact and current job docsHash pin; no browser proposal/reason becomes authority;
- repeated export is byte-equivalent even after unrelated draft mutation;
- tester is denied and malformed selectors fail closed;
- generated registry/docs, targeted contracts/server/boundary/docs checks and exact-head root `npm run verify` are GREEN.

Targeted gate evidence:

- one-shot run `34204111069` completed success;
- Typecheck, Contracts regressions, full Server regressions, boundary gate, deterministic docs regeneration/check and diff gate all passed;
- production commit after self-clean: `53551702d73da64215840030962f49c8711b887b`;
- all staging patchers and `.github/workflows/b10-external-task-package-apply.yml` are absent from the production tree;
- generated compatibility now reports `availableOperationCount: 42`, registry hash `7698f2010c44648a8473b7423a8c9d9104cecf0a9b1f0979c3a528834646aebb`, API hash `a6b98cb1c10d2ca47a0cbbb6b1122b62de44778d91695b3efcf058f7cfce070d` and docs hash `da1f6201634875103031e0d9bb6197e534837ea0696863162a5927151a43e6f7`;
- final exact-head root CI is the remaining closing proof before calling B10.b.12 GREEN.
