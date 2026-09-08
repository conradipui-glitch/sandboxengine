# B10.c.14 — Codex account/login/quota isolation

Bounded slice: add subscription-account semantics outside `AgentBackend`; do not add browser token forwarding, API-key fallback, experimental borrowed tokens, Luna Reserve fallback or B13 authority.

Current upstream protocol evidence checked before implementation: `account/login/start` supports managed `chatgpt` and `chatgptDeviceCode`; `chatgptAuthTokens` is explicitly experimental/internal, and `account/rateLimits/read` has a `supportsLunaReserve` capability flag. B10 sends only the two supported subscription login modes and always sends `supportsLunaReserve: false`.

Required evidence before GREEN:

- account transport is local-stdio/protocol pinned and dedicated to exact owner + connection; shared cross-user process scope fails closed;
- browser and device-code login are distinct; refusal, auth expiry, missing account, API-key paid mode and unsupported mode are distinct;
- account read uses `refreshToken: false`; no token borrowing or API-key fallback exists;
- rate-limit read preserves false/zero/null/reset values and explicitly disables Luna Reserve;
- sparse rate-limit notification mutates only the active controller cache;
- cache key includes owner, connection, account and credential revision;
- logout/credential rotation clear identity/quota and invalidate already-open author backend handles via generation-bound lease;
- targeted AI/server/boundary/docs gates and final B10 exact-head root verify are GREEN.

Live-path note: CI uses a deterministic protocol transport because no real authenticated Codex App Server account/process is configured in the repository environment. Do not claim a live subscription run until one is explicitly configured.
