// FIN-03 (hosted risk): decision-table tests for the public-mission-asset cache
// policy. Pure module, no network, no filesystem, no HTTP: every case is a
// function call against an explicit input.
//
// The two properties that must never regress:
//   1. `immutable` is emitted ONLY for a content-hashed path — a non-hashed,
//      revision-bound URL must always revalidate, so a shared cache can never
//      pin stale bytes under a URL that later denotes a different revision.
//   2. the ETag is a function of the revision — a changed revision yields a
//      different ETag, and an ETag minted for the old revision never produces a
//      304 for the new one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  IMMUTABLE_MAX_AGE_SECONDS,
  computePublicAssetEtag,
  decidePublicAssetCache,
  ifNoneMatchMatches,
  parseIfNoneMatch,
  pathEmbedsContentHash,
  resolvePublicAssetCache
} from "../dist/public-asset-cache.js";

const MISSION_ASSET_PATH = "/public/v1/missions/cargo/assets/cellar-bg";
const SESSION_ASSET_PATH = "/public/v1/missions/cargo/sessions/session-a/assets/cellar-bg";
const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

function input(overrides = {}) {
  return {
    path: MISSION_ASSET_PATH,
    assetId: "cellar-bg",
    hashed: false,
    revision: REVISION_A,
    assetType: "image/png",
    authorized: false,
    ...overrides
  };
}

// --- decision table --------------------------------------------------------

const DECISION_TABLE = [
  {
    name: "hashed + public -> long max-age + immutable",
    in: input({ path: `/public/assets/cellar-bg/${REVISION_A}`, hashed: true }),
    immutable: true,
    mustRevalidate: false,
    visibility: "public",
    etag: null,
    cacheControlExact: `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`
  },
  {
    name: "hashed + authorized -> private, long max-age + immutable",
    in: input({ path: `/public/assets/cellar-bg/${REVISION_A}`, hashed: true, authorized: true }),
    immutable: true,
    mustRevalidate: false,
    visibility: "private",
    etag: null,
    cacheControlExact: `private, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`
  },
  {
    name: "non-hashed public, revision-bound -> no-cache + must-revalidate + ETag",
    in: input(),
    immutable: false,
    mustRevalidate: true,
    visibility: "public",
    etagNotNull: true,
    cacheControlExact: "public, no-cache, must-revalidate"
  },
  {
    name: "non-hashed authorized, revision-bound -> private + no-cache + must-revalidate + ETag",
    in: input({ path: SESSION_ASSET_PATH, authorized: true }),
    immutable: false,
    mustRevalidate: true,
    visibility: "private",
    etagNotNull: true,
    vary: "authorization",
    cacheControlExact: "private, no-cache, must-revalidate"
  },
  {
    name: "non-hashed without any revision identity -> no-store, no ETag",
    in: input({ revision: "" }),
    immutable: false,
    mustRevalidate: true,
    visibility: "public",
    etag: null,
    cacheControlExact: "no-store"
  },
  {
    name: "non-hashed authorized without revision -> no-store + Vary: authorization",
    in: input({ path: SESSION_ASSET_PATH, authorized: true, revision: "   " }),
    immutable: false,
    mustRevalidate: true,
    visibility: "private",
    etag: null,
    vary: "authorization",
    cacheControlExact: "no-store"
  }
];

for (const row of DECISION_TABLE) {
  test(`FIN-03 cache decision: ${row.name}`, () => {
    const decision = decidePublicAssetCache(row.in);
    assert.equal(decision.cacheControl, row.cacheControlExact, "exact Cache-Control value");
    assert.equal(decision.immutable, row.immutable, "immutable flag");
    assert.equal(decision.mustRevalidate, row.mustRevalidate, "mustRevalidate flag");
    assert.equal(decision.visibility, row.visibility, "visibility");
    if (row.etag === null) assert.equal(decision.etag, null, "no ETag is offered");
    if (row.etagNotNull) assert.equal(typeof decision.etag, "string", "a strong ETag is offered");
    if (row.vary) assert.equal(decision.vary, row.vary, "Vary header");
    else assert.equal(decision.vary, null, "no Vary header");

    // The load-bearing invariant, checked on every row: `immutable` iff hashed.
    assert.equal(
      /immutable/.test(decision.cacheControl),
      row.in.hashed,
      `immutable must track hashed: cache-control=${decision.cacheControl}`
    );
  });
}

test("FIN-03 cache decision: immutable is NEVER emitted for any non-hashed path", () => {
  const paths = [MISSION_ASSET_PATH, SESSION_ASSET_PATH, "/public/v1/missions/mission:project:quest/assets/bg"];
  for (const path of paths) {
    for (const authorized of [false, true]) {
      for (const revision of [REVISION_A, "", "   "]) {
        for (const assetType of ["image/png", "audio/ogg", "model/gltf+json"]) {
          const decision = decidePublicAssetCache(input({ path, authorized, revision, assetType, hashed: false }));
          assert.equal(decision.immutable, false, `immutable flag for ${path}`);
          assert.doesNotMatch(decision.cacheControl, /immutable/, `Cache-Control for ${path} (rev=${JSON.stringify(revision)})`);
          assert.ok(
            decision.cacheControl.includes("no-cache") || decision.cacheControl === "no-store",
            `non-hashed path must revalidate: ${decision.cacheControl}`
          );
        }
      }
    }
  }
});

// --- ETag identity ---------------------------------------------------------

test("FIN-03 ETag: a changed revision yields a different ETag", () => {
  const a = computePublicAssetEtag(input({ revision: REVISION_A }));
  const b = computePublicAssetEtag(input({ revision: REVISION_B }));
  assert.equal(typeof a, "string");
  assert.equal(typeof b, "string");
  assert.notEqual(a, b, "different revisions must not share an ETag");
  assert.match(a, /^"[0-9a-f]{32}"$/, "ETag is a quoted strong tag");
});

test("FIN-03 ETag: assetId and assetType are part of the identity", () => {
  const base = computePublicAssetEtag(input());
  assert.notEqual(computePublicAssetEtag(input({ assetId: "other-bg" })), base);
  assert.notEqual(computePublicAssetEtag(input({ assetType: "audio/ogg" })), base);
});

test("FIN-03 ETag: deterministic, and absent without a revision identity", () => {
  assert.equal(computePublicAssetEtag(input()), computePublicAssetEtag(input()), "same input -> same ETag");
  assert.equal(computePublicAssetEtag(input({ revision: "" })), null);
  assert.equal(computePublicAssetEtag(input({ revision: "  " })), null);
  // An immutable (hashed) path does not depend on a revision ETag.
  const hashed = decidePublicAssetCache(input({ hashed: true }));
  assert.equal(hashed.etag, null);
});

// --- conditional requests --------------------------------------------------

test("FIN-03 304: matching ETag -> 304, otherwise 200", () => {
  const current = computePublicAssetEtag(input());
  assert.equal(typeof current, "string");

  const miss = resolvePublicAssetCache(input(), null);
  assert.equal(miss.status, 200);
  assert.equal(miss.notModified, false);
  assert.equal(miss.headers.etag, current);
  assert.equal(miss.headers["cache-control"], "public, no-cache, must-revalidate");

  const hit = resolvePublicAssetCache(input(), current);
  assert.equal(hit.status, 304);
  assert.equal(hit.notModified, true);
  assert.equal(hit.headers.etag, current);
  assert.equal(hit.headers["cache-control"], "public, no-cache, must-revalidate", "304 still revalidates downstream");

  assert.equal(resolvePublicAssetCache(input(), '"deadbeef"').status, 200, "unrelated ETag -> 200");
  assert.equal(resolvePublicAssetCache(input(), "").status, 200, "empty header -> 200");
  assert.equal(resolvePublicAssetCache(input(), "not-an-etag").status, 200, "garbage -> 200");
});

test("FIN-03 304: weak and multi-tag If-None-Match are honored carefully", () => {
  const current = computePublicAssetEtag(input());
  const inner = current.slice(1, -1);

  assert.equal(resolvePublicAssetCache(input(), `W/${current}`).status, 304, "weak prefix still matches");
  assert.equal(resolvePublicAssetCache(input(), `"x", ${current} , "y"`).status, 304, "match inside a list");
  assert.equal(resolvePublicAssetCache(input(), "*").status, 304, "wildcard matches an existing representation");
  assert.equal(resolvePublicAssetCache(input(), `W/"other", "another"`).status, 200, "no match in a list -> 200");

  assert.deepEqual(parseIfNoneMatch(`W/"a" , "b"`), ["a", "b"]);
  assert.deepEqual(parseIfNoneMatch("*"), ["*"]);
  assert.deepEqual(parseIfNoneMatch(null), []);
  assert.deepEqual(parseIfNoneMatch("   "), []);
  assert.equal(ifNoneMatchMatches(`W/${current}`, current), true);
  assert.equal(ifNoneMatchMatches(`"${inner}"`, current), true);
  assert.equal(ifNoneMatchMatches(null, current), false);
  assert.equal(ifNoneMatchMatches(current, null), false, "no current ETag -> never matches");
});

test("FIN-03 304: an ETag minted for an old revision never matches a new revision", () => {
  const oldRevision = input({ revision: REVISION_A });
  const newRevision = input({ revision: REVISION_B });
  const oldEtag = computePublicAssetEtag(oldRevision);
  const newEtag = computePublicAssetEtag(newRevision);
  assert.notEqual(oldEtag, newEtag);

  const stale = resolvePublicAssetCache(newRevision, oldEtag);
  assert.equal(stale.status, 200, "a stale client must not be told 304 for a newer revision");
  assert.equal(stale.notModified, false);
  assert.equal(stale.headers.etag, newEtag, "the response advertises the new revision's ETag");

  // And the reverse: the new ETag does not resurrect the old representation.
  assert.equal(resolvePublicAssetCache(oldRevision, newEtag).status, 200);
  // Only the exact revision match revalidates.
  assert.equal(resolvePublicAssetCache(newRevision, newEtag).status, 304);
});

test("FIN-03 304: an immutable (hashed) path offers no conditional revalidation", () => {
  const hashed = input({ path: `/public/assets/cellar-bg/${REVISION_A}`, hashed: true });
  const resolution = resolvePublicAssetCache(hashed, `"${REVISION_A}"`);
  assert.equal(resolution.status, 200, "no ETag means no 304");
  assert.equal(resolution.notModified, false);
  assert.equal(resolution.headers.etag, undefined);
  assert.match(resolution.headers["cache-control"], /immutable/);
});

// --- path helper -----------------------------------------------------------

test("FIN-03 pathEmbedsContentHash: only a whole 64-hex segment counts", () => {
  assert.equal(pathEmbedsContentHash(`/a/assets/bg/${REVISION_A}`), true);
  assert.equal(pathEmbedsContentHash(`/a/assets/${REVISION_A.toUpperCase()}/bg.png`), true);
  assert.equal(pathEmbedsContentHash(MISSION_ASSET_PATH), false);
  assert.equal(pathEmbedsContentHash(SESSION_ASSET_PATH), false);
  assert.equal(pathEmbedsContentHash(`/a/${"a".repeat(63)}`), false, "63 hex chars is not a hash");
  assert.equal(pathEmbedsContentHash(`/a/${"z".repeat(64)}`), false, "non-hex 64 chars is not a hash");
  assert.equal(pathEmbedsContentHash(`/a/${REVISION_A}?v=1`), true, "query string does not hide the hash");
});
