# ADR 0029 — authenticated Control access boundary

Status: accepted for B09-01  
Date: 2026-09-07

## Context

B05 deliberately kept Control loopback-only. B09 must allow a network-capable authoring surface without turning browser visibility or route obscurity into authorization.

Runtime guest credentials and Control author credentials are different trust domains. Existing optimistic draft concurrency, frozen validation/playtest identity and Runtime gameplay authority must remain unchanged.

## Decision

Control has two explicit access modes:

1. `local-loopback-owner` — development-only synthetic owner, loopback bind only;
2. authenticated mode — closed provisioned users, durable server-side sessions and per-project roles.

Authenticated mode uses:

- roles exactly `owner | editor | tester`;
- scrypt password verifiers with random per-user salt and timing-safe comparison;
- opaque random session and CSRF secrets, stored only as hashes;
- HttpOnly, SameSite=Strict Control cookie; `Secure` required for non-loopback listen;
- CSRF proof for authenticated mutations except login;
- explicit browser Origin allowlist and credentialed CORS/preflight support;
- bounded process-local login throttling using injected service wall time;
- deny-by-default project authorization before project content is read;
- owner-only membership administration with last-owner protection;
- project creation + creator owner membership atomic in SQLite;
- no public registration/reset/invite flow.

Runtime guest authentication remains independent and receives no authority from a Control cookie/session.

## Role matrix

- owner: read, mutate draft/create quest, validate/playtest, manage membership;
- editor: read, mutate draft/create quest, validate/playtest;
- tester: read, validate/playtest only.

Publish/rollback authority is intentionally not implemented or advertised in B09-01. B09-02 will reserve it to owner and bind it to immutable release validation/hash/plugin-sidecar preflight.

## Browser/network consequences

Checking `Origin` alone is insufficient. Authenticated browser clients using credentials and `X-CSRF-Token` require explicit CORS response headers and `OPTIONS` handling. B09-01 therefore treats allowlisted credentialed CORS as part of the security boundary, not as presentation plumbing.

Non-loopback authenticated listen fails closed unless secure cookies are enabled and at least one allowed origin is configured.

## Consequences

- local Studio development remains simple and loopback-only;
- network-capable Control no longer depends on host secrecy;
- inaccessible project IDs do not disclose draft/validation/playtest data;
- sessions survive SQLite restart; revocation survives restart;
- authentication/session time is service time, never gameplay time;
- B09-02 can add publication authority without redesigning identity or roles.

## Explicit non-goals

Public signup, password reset, OAuth/OIDC/SAML, distributed abuse prevention, AI-key management UI, B09-02 publish/rollback, and enterprise IAM are not part of this decision.