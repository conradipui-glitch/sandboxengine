# B10.c.13 — Codex App Server adapter boundary

Bounded slice: add Codex as a separate `AgentBackend` over a narrow local stdio transport contract without adding account/login/quota or B13 repository/deployment authority.

Required evidence before GREEN:

- exact installed App Server version + v2 schema hash pin is validated at construction and initialize;
- only local process stdio is eligible; browser WebSocket/auth-token forwarding is rejected;
- transport must prove native shell/filesystem/code/repository/deploy/browser/computer/apps/plugins/external tools are disabled and server approval/tool requests are auto-denied;
- adapter `safeView` remains the existing `toolPolicy: none` AgentBackend contract; host broker remains the only B10 reference-tool authority;
- author thread starts ephemeral with approval `never`, read-only sandbox, zero dynamic tools and the explicit disabled-native-feature set; these settings are defense in depth, not the authority proof;
- protocol drift/auth/rate-limit/session/deadline/output-bound failures stay typed with no alternate transport/provider fallback;
- any observed native-tool activity invalidates the turn and triggers best-effort interrupt;
- deterministic AI tests plus root typecheck/boundary verification are GREEN;
- live local Codex process/login is intentionally not claimed in this slice and belongs to B10.c.14.
