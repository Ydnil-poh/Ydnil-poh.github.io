export const projectionStateSchemaVersion = 1;
export const projectionMethod = 'variance-top2';

// Axes are selected from record embeddings (not Region centroids) so the
// persisted state matches analyze-embedding.mjs diagnostics and does not
// depend on how records happen to be grouped into Regions.
export function selectProjectionAxes(embeddings) {
  if (embeddings.length === 0) return { xAxis: 0, yAxis: 1, variance: [] };

  const dimensions = embeddings[0].length;
  const mean = Array(dimensions).fill(0);
  const variance = Array(dimensions).fill(0);

  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i += 1) mean[i] += embedding[i];
  }
  for (let i = 0; i < dimensions; i += 1) mean[i] /= embeddings.length;
  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i += 1) {
      const diff = embedding[i] - mean[i];
      variance[i] += diff * diff;
    }
  }

  const ranked = variance
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);

  return { xAxis: ranked[0]?.index ?? 0, yAxis: ranked[1]?.index ?? 1, variance };
}

function reuseBlocker(previous, { dimensions, embeddingModel }) {
  if (!previous || typeof previous !== 'object') return 'no-previous-projection';
  if (previous.embeddingModel !== embeddingModel) return 'embedding-model-changed';
  if (previous.dimensions !== dimensions) return 'dimensions-changed';
  const { xAxis, yAxis } = previous;
  const validAxis = (axis) => Number.isInteger(axis) && axis >= 0 && axis < dimensions;
  if (!validAxis(xAxis) || !validAxis(yAxis) || xAxis === yAxis) return 'invalid-axes';
  return null;
}

// Projection axes are state, not a derived value: once chosen at bootstrap they
// are carried forward verbatim so that variance-rank churn from new records
// cannot silently re-orient the field. A fresh selection happens only when the
// persisted state is unusable or explicitly requested (--recalculate-projection).
export function resolveEmbeddingProjection({ previous, embeddings, dimensions, embeddingModel, recalculate = false, now }) {
  const blocker = reuseBlocker(previous, { dimensions, embeddingModel });
  if (!recalculate && !blocker) {
    return { state: previous, reused: true, reason: 'reused-persisted-axes' };
  }

  const { xAxis, yAxis } = selectProjectionAxes(embeddings);
  return {
    state: {
      schemaVersion: projectionStateSchemaVersion,
      method: projectionMethod,
      dimensions,
      xAxis,
      yAxis,
      embeddingModel,
      createdAt: now,
    },
    reused: false,
    reason: recalculate ? 'recalculate-requested' : blocker,
  };
}

export function projectEmbeddingsToPositions(records, { xAxis, yAxis }) {
  if (records.length === 0) return new Map();

  const xs = records.map((record) => record.embedding[xAxis]);
  const ys = records.map((record) => record.embedding[yAxis]);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const positions = new Map();

  records.forEach((record) => {
    const x = maxX === minX ? 0.5 : (record.embedding[xAxis] - minX) / (maxX - minX);
    const y = maxY === minY ? 0.5 : (record.embedding[yAxis] - minY) / (maxY - minY);
    positions.set(record.id, { x, y });
  });

  return positions;
}
