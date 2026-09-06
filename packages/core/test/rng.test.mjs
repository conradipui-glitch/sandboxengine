import test from "node:test";
import assert from "node:assert/strict";
import {
  DETERMINISTIC_RNG_ALGORITHM,
  UINT32_MAX,
  createDeterministicRngState,
  drawDeterministicInt
} from "../dist/index.js";

function drawSequence(seed, count, maxExclusive) {
  let state = createDeterministicRngState(seed, "test-stream");
  assert.notEqual(state, null);
  const draws = [];
  for (let index = 0; index < count; index += 1) {
    const draw = drawDeterministicInt(state, maxExclusive);
    assert.equal(draw.ok, true);
    draws.push(draw.provenance);
    state = draw.state;
  }
  return { state, draws };
}

test("same explicit seed and draw sequence is byte-for-byte reproducible", () => {
  const first = drawSequence(123456789, 4, 100);
  const second = drawSequence(123456789, 4, 100);

  assert.deepEqual(first, second);
  assert.deepEqual(first.draws.map(({ rawUint32, value }) => ({ rawUint32, value })), [
    { rawUint32: 920370032, value: 21 },
    { rawUint32: 3761641487, value: 87 },
    { rawUint32: 2252023330, value: 52 },
    { rawUint32: 1475571481, value: 34 }
  ]);
  assert.equal(first.draws[0].algorithm, DETERMINISTIC_RNG_ALGORITHM);
  assert.equal(first.draws[0].seed, 123456789);
  assert.equal(first.draws[0].streamId, "test-stream");
  assert.deepEqual(first.draws.map((draw) => draw.drawIndex), [0, 1, 2, 3]);
});

test("RNG uses explicit immutable state and reports invalid seed/bounds", () => {
  assert.equal(createDeterministicRngState(-1, "x"), null);
  assert.equal(createDeterministicRngState(UINT32_MAX + 1, "x"), null);
  assert.equal(createDeterministicRngState(1, ""), null);

  const state = createDeterministicRngState(1, "x");
  assert.notEqual(state, null);
  const before = JSON.stringify(state);
  assert.deepEqual(drawDeterministicInt(state, 0), { ok: false, code: "invalid_bound" });
  assert.deepEqual(drawDeterministicInt(state, UINT32_MAX + 2), { ok: false, code: "invalid_bound" });
  assert.equal(JSON.stringify(state), before);
});

test("draw index overflow is explicit and no hidden process entropy is consulted", () => {
  const overflow = {
    algorithm: DETERMINISTIC_RNG_ALGORITHM,
    seed: 7,
    streamId: "x",
    state: 7,
    drawIndex: Number.MAX_SAFE_INTEGER
  };
  assert.deepEqual(drawDeterministicInt(overflow, 10), {
    ok: false,
    code: "draw_index_overflow"
  });
});
