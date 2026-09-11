# FIN-04 (B01) — the delivered composition names what is running

Date: 2026-09-11
Card: FIN-04 / defect B01. Reproduction test authored by the B01/B04 repro
subagent (`apps/server/test/fin04-delivery-manifest.test.mjs`), fix here.

## Defect

`docs/FIN-CHECKLIST.md` recorded B01 as: Studio `main.ts` keeps its own Control
writer and publication store, and the delivery had no version manifest, so
"the host checkout is correct" was the only evidence of what actually ran. The
reproduction test fails on the missing deliverable (RED: 1 pass / 1 fail) and
its second case documents the topology that makes the manifest necessary —
engine and studio are two independent Control compositions opening the same
SQLite file as writers, with no writer identity recorded anywhere.

## Change

- `deploy/vps/delivery-manifest.mjs` (new): generates the manifest from facts —
  the delivered commit (`--commit`, default `git rev-parse HEAD`) and the
  SHA-256 of the gate file that compose mounts (`deploy/vps/lhc-gate.mjs`).
  Nothing is hand-written: re-run it on the host after a delivery.
- `deploy/vps/delivery-manifest.json` (new): the generated snapshot for the
  currently delivered commit `7e61f98`.

## Test

`apps/server/test/fin04-delivery-manifest.test.mjs`: 2 tests / 2 pass after the
manifest is committed (1 pass / 1 fail before — the manifest candidate list was
empty). The test parses `docker-compose.yml` as the source of truth for running
components, then requires a manifest entry per service with an immutable
identity (40-hex commit or full `sha256:` digest) and a `sharedDatabase` block
naming writers that must themselves be declared components.

## Not verified

- The manifest is a snapshot of the *delivered* commit (`7e61f98`), not of the
  repository head: the FIN branches add engine fixes that are not deployed yet.
  A fresh delivery must regenerate it, and the hosted smoke has not been re-run.
- No check that a stale Control writer is actually detected at runtime —
  only that the manifest declares the writers (the second test documents the
  two-writer topology as it stands).
