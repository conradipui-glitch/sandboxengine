# B11-04 — remaining client and asset gates

Status: **OPEN**

This task exists to keep the final B11 work bounded after semantic/runtime acceptance became green.

## Gate A — client-compatible Engine rollout

Current `sandbox` BFF deliberately returns an Engine test envelope for Engine-bound sessions. The legacy React client expects legacy `GameState`, so production `ENGINE_FLORENCE_ROLLOUT=on` is not yet allowed.

Acceptance:

- player can render a newly Engine-bound Florence session without casting the Engine payload to legacy `GameState`;
- current authored beat and prepared options are supplied by the Engine/server, not recalculated in the browser;
- prepared click sends `authored.option`; free text uses the intent boundary;
- no client-side resource arithmetic or terminal decision;
- legacy session rendering remains unchanged;
- test rollout and rollback remain new-session-only.

## Gate B — Florence binary assets

`examples/florence/source-assets.json` pins exact source commit/paths/blob identities. Migration is not complete until bytes are transferred through a byte-safe path and verified.

Acceptance:

- six pinned WebP visuals copied or ingested byte-for-byte from source SHA;
- six source MP3 tracks reconstructed from their ordered pinned parts or ingested from an equivalent exact-byte source;
- content hashes are recorded in Engine asset metadata;
- source provenance remains attached;
- `binaryCopyStatus` is no longer `pending-byte-safe-transfer` only after verification;
- no binary identity is inferred from filename alone.

## Final B11 gate

After A + B:

1. exact-head root CI green in `sandboxengine`;
2. exact-head tests/build green in `sandbox`;
3. update B11 semantic/rollout evidence with final SHAs;
4. update `STATUS.md` and `HANDOFF.md`;
5. only then make the B11 PR ready/publish/merge and consider enabling production rollout.
