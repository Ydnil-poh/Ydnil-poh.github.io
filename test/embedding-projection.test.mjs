import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectEmbeddingsToPositions,
  projectionMethod,
  projectionStateSchemaVersion,
  resolveEmbeddingProjection,
  selectProjectionAxes,
} from '../src/lib/archive/embeddingProjection.mjs';

const model = 'local-feature-hash-ko-en-4';

function embeddingsWithVarianceOn(dimensions, highA, highB) {
  const base = Array(dimensions).fill(0.1);
  return [1, -1, 2, -2].map((scale) => base.map((value, index) => {
    if (index === highA) return value + scale;
    if (index === highB) return value + scale * 0.5;
    return value;
  }));
}

test('selectProjectionAxes ranks the two highest-variance dimensions', () => {
  const { xAxis, yAxis } = selectProjectionAxes(embeddingsWithVarianceOn(4, 2, 0));
  assert.equal(xAxis, 2);
  assert.equal(yAxis, 0);
});

test('resolveEmbeddingProjection creates state on first bootstrap', () => {
  const resolved = resolveEmbeddingProjection({
    previous: null,
    embeddings: embeddingsWithVarianceOn(4, 3, 1),
    dimensions: 4,
    embeddingModel: model,
    now: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(resolved.reused, false);
  assert.equal(resolved.reason, 'no-previous-projection');
  assert.deepEqual(resolved.state, {
    schemaVersion: projectionStateSchemaVersion,
    method: projectionMethod,
    dimensions: 4,
    xAxis: 3,
    yAxis: 1,
    embeddingModel: model,
    createdAt: '2026-07-16T00:00:00.000Z',
  });
});

test('resolveEmbeddingProjection reuses persisted axes even when variance ranking drifts', () => {
  const previous = {
    schemaVersion: projectionStateSchemaVersion,
    method: projectionMethod,
    dimensions: 4,
    xAxis: 0,
    yAxis: 2,
    embeddingModel: model,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const resolved = resolveEmbeddingProjection({
    previous,
    embeddings: embeddingsWithVarianceOn(4, 3, 1),
    dimensions: 4,
    embeddingModel: model,
    now: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(resolved.reused, true);
  assert.equal(resolved.reason, 'reused-persisted-axes');
  assert.equal(resolved.state, previous);
});

test('resolveEmbeddingProjection recomputes on explicit recalculate request', () => {
  const previous = {
    schemaVersion: projectionStateSchemaVersion,
    method: projectionMethod,
    dimensions: 4,
    xAxis: 0,
    yAxis: 2,
    embeddingModel: model,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const resolved = resolveEmbeddingProjection({
    previous,
    embeddings: embeddingsWithVarianceOn(4, 3, 1),
    dimensions: 4,
    embeddingModel: model,
    recalculate: true,
    now: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(resolved.reused, false);
  assert.equal(resolved.reason, 'recalculate-requested');
  assert.equal(resolved.state.xAxis, 3);
  assert.equal(resolved.state.yAxis, 1);
  assert.equal(resolved.state.createdAt, '2026-07-16T00:00:00.000Z');
});

test('resolveEmbeddingProjection rejects persisted axes that no longer fit the embedding space', () => {
  const base = {
    schemaVersion: projectionStateSchemaVersion,
    method: projectionMethod,
    dimensions: 4,
    xAxis: 0,
    yAxis: 2,
    embeddingModel: model,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const cases = [
    [{ ...base, embeddingModel: 'gemini-embedding-001' }, 'embedding-model-changed'],
    [{ ...base, dimensions: 64 }, 'dimensions-changed'],
    [{ ...base, xAxis: 9 }, 'invalid-axes'],
    [{ ...base, xAxis: 2 }, 'invalid-axes'],
    [{ ...base, yAxis: null }, 'invalid-axes'],
  ];

  for (const [previous, reason] of cases) {
    const resolved = resolveEmbeddingProjection({
      previous,
      embeddings: embeddingsWithVarianceOn(4, 3, 1),
      dimensions: 4,
      embeddingModel: model,
      now: '2026-07-16T00:00:00.000Z',
    });
    assert.equal(resolved.reused, false, `expected recompute for ${reason}`);
    assert.equal(resolved.reason, reason);
  }
});

test('projectEmbeddingsToPositions normalizes along the pinned axes only', () => {
  const records = [
    { id: 'a', embedding: [0, 5, 0, 9] },
    { id: 'b', embedding: [1, 5, 0.5, 7] },
    { id: 'c', embedding: [2, 5, 1, 8] },
  ];
  const positions = projectEmbeddingsToPositions(records, { xAxis: 0, yAxis: 2 });

  assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
  assert.deepEqual(positions.get('b'), { x: 0.5, y: 0.5 });
  assert.deepEqual(positions.get('c'), { x: 1, y: 1 });

  const flat = projectEmbeddingsToPositions(records, { xAxis: 1, yAxis: 2 });
  assert.deepEqual(flat.get('b'), { x: 0.5, y: 0.5 });
});
