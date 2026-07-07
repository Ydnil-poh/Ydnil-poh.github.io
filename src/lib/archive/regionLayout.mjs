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

function expandRectFootprint(footprint, profile) {
  if (footprint.kind !== 'rect') return footprint;
  const rect = footprint.rect;
  return {
    ...footprint,
    rect: {
      minCol: clamp(rect.minCol - 1, 0, profile.cols - 1),
      maxCol: clamp(rect.maxCol + 1, 0, profile.cols - 1),
      minRow: clamp(rect.minRow - 1, 0, profile.rows - 1),
      maxRow: clamp(rect.maxRow + 1, 0, profile.rows - 1),
    },
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

export function maintainRegionFootprint(region, records, profile = fieldLayoutProfile, policy = regionDensityPolicy) {
  const stats = calculateRegionStats(region, records, profile, policy);
  if (stats.density > policy.expandAbove) return expandRectFootprint(region.footprint, profile);
  if (stats.density < policy.shrinkBelow) return shrinkRectFootprint(region.footprint, region, records, profile);
  return region.footprint;
}

export function incrementalRegionLayout(records, previousManifest, projectEmbeddings, profile = fieldLayoutProfile, options = {}) {
  const regions = buildRegions(records, previousManifest, projectEmbeddings, profile, options);
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const previousRecordSlots = options.regionReseed ? { slotFor: () => null } : previousRecordSlotMaps(previousManifest, profile);
  const knownRecordIds = options.regionReseed ? new Set() : previousRecordIds(previousManifest);
  const occupied = new Set();
  const placedRecords = [];
  const pendingRecords = [];
  const layoutEvents = [];

  for (const record of records) {
    const tag = primaryTagFor(record);
    const regionId = regionIdForTag(tag);
    const region = regionById.get(regionId);
    const previousSlot = previousRecordSlots.slotFor(record);

    if (Number.isInteger(previousSlot)) {
      const slot = isSlotInFootprint(previousSlot, region.footprint, profile)
        ? previousSlot
        : nearestOpenSlotInFootprint(previousSlot, occupied, region.footprint, profile);
      if (slot === -1) throw new Error(`Region ${region.id} has no open slot for existing record ${record.id}`);
      if (occupied.has(slot)) throw new Error(`layoutSlot collision at ${slot} for record ${record.id}`);
      occupied.add(slot);
      placedRecords.push({ ...record, regionId, position: slotToPosition(slot, profile), layoutSlot: slot });
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

  for (const record of pendingRecords) {
    const region = regionById.get(record.regionId);
    const anchors = nearestEmbeddingAnchors(record, placedRecords.filter((candidate) => candidate.regionId === record.regionId));
    const anchor = anchors[0] ?? null;
    const preferredSlot = anchor?.candidate?.layoutSlot ?? region.seedSlot;
    const slot = nearestOpenSlotInFootprint(preferredSlot, occupied, region.footprint, profile);
    if (slot === -1) throw new Error(`Region ${region.id} has no open slot for new record ${record.id}`);
    occupied.add(slot);
    placedRecords.push({ ...record, position: slotToPosition(slot, profile), layoutSlot: slot });
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
        preferredSlot,
        seedSlot: region.seedSlot,
        seedDistance: slotDistance(slot, region.seedSlot, profile),
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
        preferredSlot,
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
      footprint: maintainRegionFootprint(region, laidOutRecords, profile),
    }))
    : regions;

  const regionsWithStats = maintainedRegions.map((region) => ({
    ...region,
    stats: calculateRegionStats(region, laidOutRecords, profile),
  }));

  return { records: laidOutRecords, regions: regionsWithStats, layoutEvents };
}
