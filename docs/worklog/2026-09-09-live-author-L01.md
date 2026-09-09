# 2026-09-09 — L01 local HTTP boundaries

Branch: `feat/live-author-studio`
Baseline commit: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b`

## Result

L01 closes the local-only boundary consistently across Studio settings, the Studio Control proxy and direct loopback Control:

- shared `@living-history/control` policy validates literal loopback Host and the bound port;
- present Origin must be HTTP loopback and `Sec-Fetch-Site: cross-site` is rejected;
- documented local CLI requests without browser headers remain allowed;
- Studio proxy rejects foreign/fake requests before upstream fetch, limits request bodies and rejects unsupported methods;
- local settings rejects unknown fields, forbidden provider targets and oversized/invalid JSON without replacing the working configuration;
- direct loopback Control applies the same Host/Origin/fetch-metadata gate before routing or draft mutation;
- rejected requests return bounded error codes and never echo request bodies, credentials or provider responses.

## Verification

- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-boundary.test.mjs` — exit 0, 1/1 pass;
- `node --test apps/studio/test/proxy-auth.test.mjs apps/server/test/control-http.test.mjs` — exit 0, 7/7 pass;
- combined boundary run — exit 0, 8/8 pass;
- test evidence covers allowed CLI/same-loopback path, foreign Origin, fake Host/DNS-rebinding-shaped Host, cross-site fetch metadata without Origin, unsupported method, unknown settings field, forbidden metadata target, proxy/direct body limits, no upstream call and no draft mutation.

Node is `24.18.0` rather than the required `>=24.19.0 <25`; this remains an environment limitation. No live provider call was made.

## Acceptance

L01 accepted on the local HTTP boundary and regression evidence above. Authenticated non-loopback Control keeps its existing Origin allowlist/CSRF policy and was covered by the existing `control-http` test.

Next card: L02 — complete ModelProvider → AgentBackend lifecycle and failure bridge.
