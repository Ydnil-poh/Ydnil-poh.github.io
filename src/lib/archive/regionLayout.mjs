import { fieldLayoutProfile, nearestOpenSlot } from './fieldViewModel.mjs';

export const regionDensityPolicy = {
  targetDensity: 0.72,
  expandAbove: 0.82,
  shrinkBelow: 0.48,
  minArea: 4,
};

export function regionIdForTag(tag) {
  return `tag:${tag}`;
}

export function primaryTagFor(record) {
  const tags = Array.isArray(record.tags) ? record.tags.filter(Boolean) : [];
  if (tags.length !== 1) {
    throw new Error(`record ${record.id} must have exactly one tag to resolve a Region`);
  }
  return tags[0];
}

export function slotToCell(slot, profile = fieldLayoutProfile) {
  return { col: slot % profile.cols, row: Math.floor(slot / profile.cols) };
}

export function cellToSlot(col, row, profile = fieldLayoutProfile) {
  return row * profile.cols + col;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function slotsInFootprint(footprint, profile = fieldLayoutProfile) {
  if (!footprint) return [];
  if (footprint.kind === 'cells') {
    return [...new Set((footprint.cells ?? [])
      .filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < profile.cols * profile.rows))];
  }
  if (footprint.kind !== 'rect') {
    throw new Error(`unsupported Region footprint kind: ${footprint.kind}`);
  }

  const rect = footprint.rect;
  const minCol = clamp(rect.minCol, 0, profile.cols - 1);
  const maxCol = clamp(rect.maxCol, 0, profile.cols - 1);
  const minRow = clamp(rect.minRow, 0, profile.rows - 1);
  const maxRow = clamp(rect.maxRow, 0, profile.rows - 1);
  const slots = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      slots.push(cellToSlot(col, row, profile));
    }
  }
  return slots;
}

export function isSlotInFootprint(slot, footprint, profile = fieldLayoutProfile) {
  if (!Number.isInteger(slot)) return false;
  if (footprint?.kind === 'cells') return (footprint.cells ?? []).includes(slot);
  if (footprint?.kind !== 'rect') return false;
  const { col, row } = slotToCell(slot, profile);
  const { minCol, maxCol, minRow, maxRow } = footprint.rect;
  return col >= minCol && col <= maxCol && row >= minRow && row <= maxRow;
}

export function footprintArea(footprint, profile = fieldLayoutProfile) {
  return slotsInFootprint(footprint, profile).length;
}

export function footprintIntersects(a, b, profile = fieldLayoutProfile) {
  const aSlots = new Set(slotsInFootprint(a, profile));
  return slotsInFootprint(b, profile).some((slot) => aSlots.has(slot));
}

export function nearestOpenSlotInFootprint(preferred, occupied, footprint, profile = fieldLayoutProfile) {
  if (isSlotInFootprint(preferred, footprint, profile) && !occupied.has(preferred)) return preferred;

  const preferredCell = slotToCell(preferred, profile);
  let best = -1;
  let bestDistance = Infinity;

  for (const slot of slotsInFootprint(footprint, profile)) {
    if (occupied.has(slot)) continue;
    const cell = slotToCell(slot, profile);
    const distance = Math.abs(cell.col - preferredCell.col) + Math.abs(cell.row - preferredCell.row);
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

function squareishDimensions(area) {
  const width = Math.max(1, Math.ceil(Math.sqrt(area)));
  return { width, height: Math.max(1, Math.ceil(area / width)) };
}

export function createRectFootprintAroundSeed(seedSlot, area, profile = fieldLayoutProfile, requiredSlots = []) {
  const targetArea = Math.max(regionDensityPolicy.minArea, area, requiredSlots.length || 0);
  const { width, height } = squareishDimensions(targetArea);
  const seed = slotToCell(seedSlot, profile);
  const requiredCells = requiredSlots.map((slot) => slotToCell(slot, profile));

  let minCol = seed.col - Math.floor(width / 2);
  let maxCol = minCol + width - 1;
  let minRow = seed.row - Math.floor(height / 2);
  let maxRow = minRow + height - 1;

  for (const cell of requiredCells) {
    minCol = Math.min(minCol, cell.col);
    maxCol = Math.max(maxCol, cell.col);
    minRow = Math.min(minRow, cell.row);
    maxRow = Math.max(maxRow, cell.row);
  }

  if (minCol < 0) { maxCol -= minCol; minCol = 0; }
  if (maxCol >= profile.cols) { minCol -= maxCol - profile.cols + 1; maxCol = profile.cols - 1; }
  if (minRow < 0) { maxRow -= minRow; minRow = 0; }
  if (maxRow >= profile.rows) { minRow -= maxRow - profile.rows + 1; maxRow = profile.rows - 1; }

  return {
    schemaVersion: 1,
    kind: 'rect',
    rect: {
      minCol: clamp(minCol, 0, profile.cols - 1),
      maxCol: clamp(maxCol, 0, profile.cols - 1),
      minRow: clamp(minRow, 0, profile.rows - 1),
      maxRow: clamp(maxRow, 0, profile.rows - 1),
    },
  };
}

function createCellFootprint(seedSlot, area, profile = fieldLayoutProfile, requiredSlots = [], blockedSlots = new Set()) {
  const cells = [];
  const seen = new Set();
  for (const slot of [seedSlot, ...requiredSlots]) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= profile.cols * profile.rows || seen.has(slot)) continue;
    seen.add(slot);
    cells.push(slot);
  }

  const preferredCell = slotToCell(seedSlot, profile);
  const candidates = Array.from({ length: profile.cols * profile.rows }, (_, slot) => slot)
    .filter((slot) => !seen.has(slot) && !blockedSlots.has(slot))
    .sort((a, b) => {
      const aCell = slotToCell(a, profile);
      const bCell = slotToCell(b, profile);
      const aDistance = Math.abs(aCell.col - preferredCell.col) + Math.abs(aCell.row - preferredCell.row);
      const bDistance = Math.abs(bCell.col - preferredCell.col) + Math.abs(bCell.row - preferredCell.row);
      return aDistance - bDistance || a - b;
    });

  for (const slot of candidates) {
    if (cells.length >= area) break;
    seen.add(slot);
    cells.push(slot);
  }

  return { schemaVersion: 1, kind: 'cells', cells: cells.sort((a, b) => a - b) };
}

export function calculateRegionStats(region, records, profile = fieldLayoutProfile, policy = regionDensityPolicy) {
  const footprintSlots = new Set(slotsInFootprint(region.footprint, profile));
  const occupiedSlots = records.filter((record) => record.regionId === region.id && footprintSlots.has(record.layoutSlot)).length;
  const area = footprintSlots.size;
  return {
    occupiedSlots,
    availableSlots: Math.max(0, area - occupiedSlots),
    density: Number((area === 0 ? 0 : occupiedSlots / area).toFixed(4)),
    targetDensity: policy.targetDensity,
  };
}

export function centroidEmbedding(records) {
  if (records.length === 0) return [];
  const dimensions = records[0].embedding.length;
  const centroid = Array.from({ length: dimensions }, () => 0);
  for (const record of records) {
    for (let i = 0; i < dimensions; i += 1) centroid[i] += record.embedding[i];
  }
  for (let i = 0; i < dimensions; i += 1) centroid[i] /= records.length;
  const magnitude = Math.hypot(...centroid) || 1;
  return centroid.map((value) => Number((value / magnitude).toFixed(6)));
}

export function groupRecordsByRegion(records) {
  const groups = new Map();
  for (const record of records) {
    const tag = primaryTagFor(record);
    const regionId = regionIdForTag(tag);
    if (!groups.has(regionId)) groups.set(regionId, { id: regionId, tag, records: [] });
    groups.get(regionId).records.push(record);
  }
  return groups;
}

function targetAreaForCount(count, policy = regionDensityPolicy) {
  return Math.max(policy.minArea, Math.ceil(count / policy.targetDensity));
}

function positionToSlot(position, profile = fieldLayoutProfile) {
  const col = clamp(Math.floor(Number(position?.x ?? 0.5) * profile.cols), 0, profile.cols - 1);
  const row = clamp(Math.floor(Number(position?.y ?? 0.5) * profile.rows), 0, profile.rows - 1);
  return cellToSlot(col, row, profile);
}

function slotToPosition(slot, profile = fieldLayoutProfile) {
  const { col, row } = slotToCell(slot, profile);
  return {
    x: Number(((col + 0.5) / profile.cols).toFixed(4)),
    y: Number(((row + 0.5) / profile.rows).toFixed(4)),
  };
}

function slotDistance(a, b, profile = fieldLayoutProfile) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  const aCell = slotToCell(a, profile);
  const bCell = slotToCell(b, profile);
  return Math.abs(aCell.col - bCell.col) + Math.abs(aCell.row - bCell.row);
}

// Drift is a consequence of insertion, not a nightly force: a newcomer that is
// more central to its Region (closer to the Region centroid in embedding
// space) may claim a cell nearer the seed, displacing the less central
// occupant one step outward. Seed distance thereby reads as semantic
// centrality. Runtime attention never participates.
export function centralityFor(record, centroid) {
  if (!Array.isArray(centroid) || centroid.length === 0) return 0;
  return cosineSimilarity(record.embedding, centroid);
}

// Walk the footprint from the seed outward; the newcomer claims the first cell
// that is open, or that is held by a strictly less central record of the same
// Region.
function insertionTarget(record, region, centroid, occupied, occupantBySlot, profile) {
  const newcomerCentrality = centralityFor(record, centroid);
  const cells = slotsInFootprint(region.footprint, profile)
    .map((slot) => ({ slot, distance: slotDistance(slot, region.seedSlot, profile) }))
    .sort((a, b) => a.distance - b.distance || a.slot - b.slot);

  for (const cell of cells) {
    if (!occupied.has(cell.slot)) {
      return { slot: cell.slot, displaced: null, newcomerCentrality };
    }
    const occupant = occupantBySlot.get(cell.slot);
    if (!occupant || occupant.regionId !== region.id) continue;
    const occupantCentrality = centralityFor(occupant, centroid);
    if (occupantCentrality < newcomerCentrality) {
      return {
        slot: cell.slot,
        displaced: { record: occupant, centrality: occupantCentrality },
        newcomerCentrality,
      };
    }
  }
  return { slot: -1, displaced: null, newcomerCentrality };
}

// A displaced record moves one ring outward: nearest open cell whose seed
// distance is not smaller than the vacated cell's, falling back to any open
// cell. Displacement never cascades — the target must already be open.
function outwardOpenSlot(fromSlot, seedSlot, occupied, footprint, profile) {
  const fromDistance = slotDistance(fromSlot, seedSlot, profile);
  const candidates = slotsInFootprint(footprint, profile)
    .filter((slot) => !occupied.has(slot))
    .map((slot) => ({
      slot,
      seedDistance: slotDistance(slot, seedSlot, profile),
      moveDistance: slotDistance(slot, fromSlot, profile),
    }));
  const outward = candidates.filter((candidate) => candidate.seedDistance >= fromDistance);
  const pool = outward.length > 0 ? outward : candidates;
  pool.sort((a, b) => a.moveDistance - b.moveDistance || a.seedDistance - b.seedDistance || a.slot - b.slot);
  return pool[0]?.slot ?? -1;
}

function cosineSimilarity(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function previousRecordSlotMaps(previousManifest, profile = fieldLayoutProfile) {
  const previousPositions = new Map((previousManifest?.records ?? [])
    .filter((record) => record?.id && record?.position)
    .map((record) => [record.id, record.position]));
  const previousSlots = new Map((previousManifest?.archiveView?.field?.records ?? [])
    .filter((record) => record?.id && Number.isInteger(record.slot))
    .map((record) => [record.id, record.slot]));

  return { previousPositions, previousSlots, slotFor(record) {
    const previousSlot = previousSlots.get(record.id);
    if (Number.isInteger(previousSlot)) return previousSlot;
    const previousPosition = previousPositions.get(record.id);
    return previousPosition ? positionToSlot(previousPosition, profile) : null;
  } };
}

function previousRecordIds(previousManifest) {
  return new Set((previousManifest?.records ?? [])
    .map((record) => record?.id)
    .filter(Boolean));
}

function occupiedRegionFootprintSlots(regions, profile) {
  const occupied = new Set();
  for (const region of regions) {
    for (const slot of slotsInFootprint(region.footprint, profile)) occupied.add(slot);
  }
  return occupied;
}

function nearestOpenRegionSeed(anchorSlot, regions, recordCount, profile) {
  const occupied = occupiedRegionFootprintSlots(regions, profile);
  const area = targetAreaForCount(recordCount);
  let preferred = anchorSlot;
  for (let attempts = 0; attempts < profile.cols * profile.rows; attempts += 1) {
    const slot = nearestOpenSlot(preferred, occupied, profile);
    if (slot === -1) break;
    const footprint = createRectFootprintAroundSeed(slot, area, profile);
    if (!regions.some((region) => footprintIntersects(footprint, region.footprint, profile))) return { seedSlot: slot, footprint };
    occupied.add(slot);
    preferred = slot;
  }
  throw new Error('unable to place new Region footprint');
}

function normalizeRegion(region, profile) {
  const seedSlot = region.seedSlot ?? positionToSlot(region.seedPosition, profile);
  return {
    ...region,
    seedSlot,
    seedPosition: region.seedPosition ?? slotToPosition(seedSlot, profile),
    footprint: region.footprint ?? createRectFootprintAroundSeed(seedSlot, region.stats?.occupiedSlots ?? 1, profile),
  };
}

function buildRegionCentroids(groups) {
  return new Map([...groups.values()].map((group) => [group.id, centroidEmbedding(group.records)]));
}

function nearestOpenBootstrapFootprint(projectedSlot, area, occupiedSeeds, occupiedFootprints, profile) {
  let preferred = projectedSlot;
  for (let attempts = 0; attempts < profile.cols * profile.rows; attempts += 1) {
    const seedSlot = nearestOpenSlot(preferred, occupiedSeeds, profile);
    if (seedSlot === -1) break;
    const footprint = createRectFootprintAroundSeed(seedSlot, area, profile);
    if (!slotsInFootprint(footprint, profile).some((slot) => occupiedFootprints.has(slot))) return { seedSlot, footprint };
    occupiedSeeds.add(seedSlot);
    preferred = seedSlot;
  }
  throw new Error('unable to place bootstrap Region footprint');
}

export function buildRegions(records, previousManifest, projectEmbeddings, profile = fieldLayoutProfile, options = {}) {
  const groups = groupRecordsByRegion(records);
  const centroids = buildRegionCentroids(groups);
  const previousRegions = options.regionReseed ? [] : (previousManifest?.archiveView?.field?.regions ?? []).map((region) => normalizeRegion(region, profile));
  const previousRecordSlots = options.regionReseed ? { slotFor: () => null } : previousRecordSlotMaps(previousManifest, profile);

  if (previousRegions.length === 0) {
    const centroidRecords = [...groups.values()].map((group) => ({ id: group.id, embedding: centroids.get(group.id) }));
    const projected = projectEmbeddings(centroidRecords);
    const occupiedSeeds = new Set();
    const occupiedFootprints = new Set();
    return [...groups.values()].map((group) => {
      const projectedSlot = positionToSlot(projected.get(group.id), profile);
      const requiredSlots = group.records.map((record) => previousRecordSlots.slotFor(record)).filter(Number.isInteger);
      const area = targetAreaForCount(group.records.length);
      const placed = requiredSlots.length > 0
        ? {
          seedSlot: nearestOpenSlot(projectedSlot, occupiedSeeds, profile),
          footprint: null,
        }
        : nearestOpenBootstrapFootprint(projectedSlot, area, occupiedSeeds, occupiedFootprints, profile);
      const seedSlot = placed.seedSlot;
      occupiedSeeds.add(seedSlot);
      const footprint = requiredSlots.length > 0
        ? createCellFootprint(seedSlot, area, profile, requiredSlots, occupiedFootprints)
        : placed.footprint;
      for (const slot of slotsInFootprint(footprint, profile)) occupiedFootprints.add(slot);
      return {
        id: group.id,
        tag: group.tag,
        seedSlot,
        seedPosition: slotToPosition(seedSlot, profile),
        footprint,
        stats: regionDensityPolicy,
      };
    });
  }

  const existingById = new Map(previousRegions.map((region) => [region.id, region]));
  const regions = [...previousRegions.filter((region) => groups.has(region.id))];

  for (const group of groups.values()) {
    if (existingById.has(group.id)) continue;
    const centroid = centroids.get(group.id);
    const anchor = regions
      .map((region) => ({ region, similarity: cosineSimilarity(centroid, centroids.get(region.id) ?? centroid) }))
      .sort((a, b) => b.similarity - a.similarity)[0]?.region;
    const anchorSlot = anchor?.seedSlot ?? Math.floor(profile.rows / 2) * profile.cols + Math.floor(profile.cols / 2);
    const { seedSlot, footprint } = nearestOpenRegionSeed(anchorSlot, regions, group.records.length, profile);
    regions.push({
      id: group.id,
      tag: group.tag,
      seedSlot,
      seedPosition: slotToPosition(seedSlot, profile),
      footprint,
      stats: regionDensityPolicy,
    });
  }

  return regions;
}

function nearestEmbeddingAnchors(record, placedRecords, limit = 2) {
  return placedRecords
    .map((candidate) => ({ candidate, similarity: cosineSimilarity(record.embedding, candidate.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function intersectsAnyOtherRegion(footprint, region, regions, profile) {
  return regions
    .filter((candidate) => candidate.id !== region.id)
    .some((candidate) => footprintIntersects(footprint, candidate.footprint, profile));
}

function expandRectFootprint(footprint, region, regions, profile) {
  if (footprint.kind !== 'rect') return footprint;
  let rect = { ...footprint.rect };
  const candidates = [
    { key: 'minCol', value: clamp(rect.minCol - 1, 0, profile.cols - 1) },
    { key: 'maxCol', value: clamp(rect.maxCol + 1, 0, profile.cols - 1) },
    { key: 'minRow', value: clamp(rect.minRow - 1, 0, profile.rows - 1) },
    { key: 'maxRow', value: clamp(rect.maxRow + 1, 0, profile.rows - 1) },
  ];

  for (const candidate of candidates) {
    if (rect[candidate.key] === candidate.value) continue;
    const nextFootprint = { ...footprint, rect: { ...rect, [candidate.key]: candidate.value } };
    if (intersectsAnyOtherRegion(nextFootprint, region, regions, profile)) continue;
    rect = nextFootprint.rect;
  }

  return {
    ...footprint,
    rect,
  };
}

function shrinkRectFootprint(footprint, region, records, profile) {
  if (footprint.kind !== 'rect') return footprint;
  const protectedSlots = [region.seedSlot, ...records
    .filter((record) => record.regionId === region.id && Number.isInteger(record.layoutSlot))
    .map((record) => record.layoutSlot)];
  if (protectedSlots.length === 0) return footprint;

  const cells = protectedSlots.map((slot) => slotToCell(slot, profile));
  const margin = 1;
  return {
    ...footprint,
    rect: {
      minCol: clamp(Math.min(...cells.map((cell) => cell.col)) - margin, 0, profile.cols - 1),
      maxCol: clamp(Math.max(...cells.map((cell) => cell.col)) + margin, 0, profile.cols - 1),
      minRow: clamp(Math.min(...cells.map((cell) => cell.row)) - margin, 0, profile.rows - 1),
      maxRow: clamp(Math.max(...cells.map((cell) => cell.row)) + margin, 0, profile.rows - 1),
    },
  };
}

function contestedSlotsBetween(a, b, profile) {
  const aSlots = new Set(slotsInFootprint(a.footprint, profile));
  return slotsInFootprint(b.footprint, profile).filter((slot) => aSlots.has(slot));
}

function overlapKeeperScore(region, contested, recordSlotsByRegion) {
  const owned = recordSlotsByRegion.get(region.id) ?? new Set();
  const seedScore = contested.includes(region.seedSlot) ? 2 : 0;
  return seedScore + contested.filter((slot) => owned.has(slot)).length;
}

// Try to clear the contested cells by shrinking one edge of the yielder's rect
// so it stays a rect (and keeps expandability). The seed must survive the crop;
// records caught in the cropped strip are a soft cost, cropped area a lighter
// one. Returns the best valid rect or null when every edge crop is invalid.
function cropRectAwayFromContested(region, contested, recordSlotsByRegion, profile) {
  const rect = region.footprint.rect;
  const cells = contested.map((slot) => slotToCell(slot, profile));
  const seed = slotToCell(region.seedSlot, profile);
  const owned = recordSlotsByRegion.get(region.id) ?? new Set();
  const candidates = [
    { ...rect, minRow: Math.max(...cells.map((cell) => cell.row)) + 1 },
    { ...rect, maxRow: Math.min(...cells.map((cell) => cell.row)) - 1 },
    { ...rect, minCol: Math.max(...cells.map((cell) => cell.col)) + 1 },
    { ...rect, maxCol: Math.min(...cells.map((cell) => cell.col)) - 1 },
  ];

  let best = null;
  let bestCost = Infinity;
  for (const candidate of candidates) {
    if (candidate.minCol > candidate.maxCol || candidate.minRow > candidate.maxRow) continue;
    if (seed.col < candidate.minCol || seed.col > candidate.maxCol || seed.row < candidate.minRow || seed.row > candidate.maxRow) continue;
    const keptSlots = new Set(slotsInFootprint({ kind: 'rect', rect: candidate }, profile));
    const lostRecords = [...owned].filter((slot) => !keptSlots.has(slot)).length;
    const removedArea = footprintArea(region.footprint, profile) - keptSlots.size;
    const cost = lostRecords * 10000 + removedArea;
    if (cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

function repairYielderFootprint(region, contested, recordSlotsByRegion, profile) {
  const footprint = region.footprint;
  if (footprint.kind === 'rect') {
    const cropped = cropRectAwayFromContested(region, contested, recordSlotsByRegion, profile);
    if (cropped) return { ...footprint, rect: cropped };
  }
  const contestedSet = new Set(contested.filter((slot) => slot !== region.seedSlot));
  return {
    schemaVersion: 1,
    kind: 'cells',
    cells: slotsInFootprint(footprint, profile).filter((slot) => !contestedSet.has(slot)).sort((a, b) => a - b),
  };
}

// Footprint exclusivity is an invariant: earlier unguarded expansion let
// neighboring Regions grow into each other, and carried-over manifests may
// still hold those overlaps. Every rebuild resolves them once here — the
// Region whose seed or records sit on the contested cells keeps them (ties go
// to the older Region), the yielder cedes and preferably stays a rect.
export function repairFootprintOverlaps(regions, recordSlotHints, profile = fieldLayoutProfile) {
  const recordSlotsByRegion = new Map();
  for (const hint of recordSlotHints) {
    if (!Number.isInteger(hint.slot)) continue;
    if (!recordSlotsByRegion.has(hint.regionId)) recordSlotsByRegion.set(hint.regionId, new Set());
    recordSlotsByRegion.get(hint.regionId).add(hint.slot);
  }

  const repaired = regions.map((region) => ({ ...region }));
  const events = [];

  for (let i = 0; i < repaired.length; i += 1) {
    for (let j = i + 1; j < repaired.length; j += 1) {
      const a = repaired[i];
      const b = repaired[j];
      const contested = contestedSlotsBetween(a, b, profile);
      if (contested.length === 0) continue;

      const keeper = overlapKeeperScore(b, contested, recordSlotsByRegion) > overlapKeeperScore(a, contested, recordSlotsByRegion) ? b : a;
      const yielder = keeper === a ? b : a;
      const footprintBefore = yielder.footprint;
      yielder.footprint = repairYielderFootprint(yielder, contested, recordSlotsByRegion, profile);

      events.push({
        eventType: 'region.footprint_overlap_repaired',
        recordId: null,
        regionId: yielder.id,
        fromSlot: null,
        toSlot: null,
        anchorId: null,
        anchorKind: null,
        metadata: {
          keeperRegionId: keeper.id,
          contestedSlots: contested,
          footprintKindBefore: footprintBefore.kind,
          footprintKindAfter: yielder.footprint.kind,
        },
      });
    }
  }

  return { regions: repaired, events };
}

export function maintainRegionFootprint(region, records, profile = fieldLayoutProfile, policy = regionDensityPolicy, regions = []) {
  const stats = calculateRegionStats(region, records, profile, policy);
  if (stats.density > policy.expandAbove) return expandRectFootprint(region.footprint, region, regions, profile);
  if (stats.density < policy.shrinkBelow) return shrinkRectFootprint(region.footprint, region, records, profile);
  return region.footprint;
}

// Insertion pressure between sleep rebuilds may fill a footprint before the
// nightly maintenance can grow it; rather than failing the build, grow the
// footprint on the spot with the same neighbor-guarded directional expansion.
function emergencyExpandRegion(region, regions, profile) {
  const areaBefore = footprintArea(region.footprint, profile);
  const expanded = expandRectFootprint(region.footprint, region, regions, profile);
  const areaAfter = footprintArea(expanded, profile);
  if (areaAfter <= areaBefore) return null;
  region.footprint = expanded;
  return { areaBefore, areaAfter };
}

export function incrementalRegionLayout(records, previousManifest, projectEmbeddings, profile = fieldLayoutProfile, options = {}) {
  const builtRegions = buildRegions(records, previousManifest, projectEmbeddings, profile, options);
  const previousRecordSlots = options.regionReseed ? { slotFor: () => null } : previousRecordSlotMaps(previousManifest, profile);
  const overlapRepair = options.regionReseed
    ? { regions: builtRegions, events: [] }
    : repairFootprintOverlaps(builtRegions, records.map((record) => ({
      regionId: regionIdForTag(primaryTagFor(record)),
      slot: previousRecordSlots.slotFor(record),
    })), profile);
  const regions = overlapRepair.regions;
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const knownRecordIds = options.regionReseed ? new Set() : previousRecordIds(previousManifest);
  const occupied = new Set();
  const occupantBySlot = new Map();
  const placedRecords = [];
  const pendingRecords = [];
  const layoutEvents = [...overlapRepair.events];

  const expandForPressure = (region, trigger) => {
    const growth = emergencyExpandRegion(region, regions, profile);
    if (!growth) return false;
    layoutEvents.push({
      eventType: 'region.footprint_emergency_expanded',
      recordId: null,
      regionId: region.id,
      fromSlot: null,
      toSlot: null,
      anchorId: null,
      anchorKind: null,
      metadata: { ...growth, trigger },
    });
    return true;
  };

  for (const record of records) {
    const tag = primaryTagFor(record);
    const regionId = regionIdForTag(tag);
    const region = regionById.get(regionId);
    const previousSlot = previousRecordSlots.slotFor(record);

    if (Number.isInteger(previousSlot)) {
      let slot = isSlotInFootprint(previousSlot, region.footprint, profile) && !occupied.has(previousSlot)
        ? previousSlot
        : nearestOpenSlotInFootprint(previousSlot, occupied, region.footprint, profile);
      if (slot === -1 && expandForPressure(region, 'existing_record')) {
        slot = nearestOpenSlotInFootprint(previousSlot, occupied, region.footprint, profile);
      }
      if (slot === -1) throw new Error(`Region ${region.id} has no open slot for existing record ${record.id}`);
      occupied.add(slot);
      const placed = { ...record, regionId, position: slotToPosition(slot, profile), layoutSlot: slot };
      occupantBySlot.set(slot, placed);
      placedRecords.push(placed);
      layoutEvents.push({
        eventType: slot === previousSlot ? 'layout.slot_preserved' : 'layout.moved_within_region',
        recordId: record.id,
        regionId,
        fromSlot: previousSlot,
        toSlot: slot,
        anchorId: null,
        anchorKind: null,
        metadata: {
          previousSlot,
          footprintKind: region.footprint?.kind ?? null,
        },
      });
    } else {
      pendingRecords.push({ ...record, regionId });
    }
  }

  const regionRecordGroups = new Map();
  for (const record of records) {
    const regionId = regionIdForTag(primaryTagFor(record));
    if (!regionRecordGroups.has(regionId)) regionRecordGroups.set(regionId, []);
    regionRecordGroups.get(regionId).push(record);
  }
  const centroidByRegion = new Map([...regionRecordGroups].map(([regionId, group]) => [regionId, centroidEmbedding(group)]));

  // most central newcomers claim their cells first so a single build with
  // several insertions settles into the same ordering a one-by-one arrival would
  const rankedPending = [...pendingRecords]
    .map((record) => ({ record, centrality: centralityFor(record, centroidByRegion.get(record.regionId)) }))
    .sort((a, b) => b.centrality - a.centrality || String(a.record.id).localeCompare(String(b.record.id)))
    .map((entry) => entry.record);

  for (const record of rankedPending) {
    const region = regionById.get(record.regionId);
    const centroid = centroidByRegion.get(record.regionId);
    const anchors = nearestEmbeddingAnchors(record, placedRecords.filter((candidate) => candidate.regionId === record.regionId));
    const anchor = anchors[0] ?? null;

    let target = insertionTarget(record, region, centroid, occupied, occupantBySlot, profile);
    if (target.slot === -1 && expandForPressure(region, 'insertion')) {
      target = insertionTarget(record, region, centroid, occupied, occupantBySlot, profile);
    }
    if (target.slot === -1) throw new Error(`Region ${region.id} has no open slot for new record ${record.id}`);

    if (target.displaced) {
      let victimSlot = outwardOpenSlot(target.slot, region.seedSlot, occupied, region.footprint, profile);
      if (victimSlot === -1 && expandForPressure(region, 'displacement')) {
        victimSlot = outwardOpenSlot(target.slot, region.seedSlot, occupied, region.footprint, profile);
      }
      if (victimSlot === -1) {
        // occupant cannot be relocated; the newcomer settles for the nearest open cell instead
        const fallback = nearestOpenSlotInFootprint(region.seedSlot, occupied, region.footprint, profile);
        if (fallback === -1) throw new Error(`Region ${region.id} has no open slot for new record ${record.id}`);
        target = { slot: fallback, displaced: null, newcomerCentrality: target.newcomerCentrality };
      } else {
        const victim = target.displaced.record;
        const fromSlot = victim.layoutSlot;
        victim.layoutSlot = victimSlot;
        victim.position = slotToPosition(victimSlot, profile);
        occupied.add(victimSlot);
        occupantBySlot.delete(fromSlot);
        occupantBySlot.set(victimSlot, victim);
        layoutEvents.push({
          eventType: 'layout.displaced',
          recordId: victim.id,
          regionId: region.id,
          fromSlot,
          toSlot: victimSlot,
          anchorId: record.id,
          anchorKind: 'inserted_record',
          metadata: {
            newcomerCentrality: Number(target.newcomerCentrality.toFixed(6)),
            occupantCentrality: Number(target.displaced.centrality.toFixed(6)),
            seedDistanceFrom: slotDistance(fromSlot, region.seedSlot, profile),
            seedDistanceTo: slotDistance(victimSlot, region.seedSlot, profile),
          },
        });
      }
    }

    const slot = target.slot;
    occupied.add(slot);
    const placed = { ...record, position: slotToPosition(slot, profile), layoutSlot: slot };
    occupantBySlot.set(slot, placed);
    placedRecords.push(placed);
    if (!knownRecordIds.has(record.id)) {
      layoutEvents.push({
        eventType: 'record.first_seen',
        recordId: record.id,
        regionId: record.regionId,
        fromSlot: null,
        toSlot: null,
        anchorId: null,
        anchorKind: null,
        metadata: {},
      });
    }
    layoutEvents.push({
      eventType: 'layout.placed',
      recordId: record.id,
      regionId: record.regionId,
      fromSlot: null,
      toSlot: slot,
      anchorId: null,
      anchorKind: null,
      metadata: {
        seedSlot: region.seedSlot,
        seedDistance: slotDistance(slot, region.seedSlot, profile),
        newcomerCentrality: Number(target.newcomerCentrality.toFixed(6)),
        displacedRecordId: target.displaced?.record?.id ?? null,
        footprintKind: region.footprint?.kind ?? null,
      },
    });
    layoutEvents.push({
      eventType: anchor ? 'layout.anchor_record' : 'layout.anchor_region',
      recordId: record.id,
      regionId: record.regionId,
      fromSlot: null,
      toSlot: slot,
      anchorId: anchor?.candidate?.id ?? null,
      anchorKind: anchor ? 'record' : 'region_seed',
      metadata: {
        anchorSlot: anchor?.candidate?.layoutSlot ?? region.seedSlot,
        anchorDistance: slotDistance(slot, anchor?.candidate?.layoutSlot ?? region.seedSlot, profile),
        anchorWeight: anchor ? Number(anchor.similarity.toFixed(6)) : null,
        similarity: anchor ? Number(anchor.similarity.toFixed(6)) : null,
      },
    });
  }

  const byId = new Map(placedRecords.map((record) => [record.id, record]));
  const laidOutRecords = records.map((record) => byId.get(record.id));
  const maintainedRegions = options.sleepRebuild
    ? regions.map((region) => ({
      ...region,
      footprint: maintainRegionFootprint(region, laidOutRecords, profile, regionDensityPolicy, regions),
    }))
    : regions;

  const regionsWithStats = maintainedRegions.map((region) => ({
    ...region,
    stats: calculateRegionStats(region, laidOutRecords, profile),
  }));

  return { records: laidOutRecords, regions: regionsWithStats, layoutEvents };
}
