export const fieldLayoutProfile = {
  cols: 40,
  rows: 25,
};

export function nearestOpenSlot(preferred, occupied, profile = fieldLayoutProfile) {
  if (!occupied.has(preferred)) return preferred;
  const totalSlots = profile.cols * profile.rows;
  const preferredCol = preferred % profile.cols;
  const preferredRow = Math.floor(preferred / profile.cols);
  let best = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < totalSlots; index += 1) {
    if (occupied.has(index)) continue;
    const col = index % profile.cols;
    const row = Math.floor(index / profile.cols);
    const distance = Math.abs(col - preferredCol) + Math.abs(row - preferredRow);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

// Traces mark cells a record vacated — the "written then erased" impressions
// the field carries. They are permanent: covered while a tile sits on the
// cell, visible again once it leaves, so a cell can accumulate the layered
// history of being written, erased, and written over. Moves, displacements,
// and removals all leave one.
const traceKindByEventType = new Map([
  ['layout.moved_within_region', 'moved'],
  ['layout.displaced', 'displaced'],
  ['record.removed', 'removed'],
]);

export function deriveFieldTraces(layoutEvents = [], profile = fieldLayoutProfile) {
  const byCell = new Map();
  for (const event of layoutEvents) {
    const kind = traceKindByEventType.get(event?.eventType);
    if (!kind) continue;
    if (!Number.isInteger(event.fromSlot)) continue;
    if (event.fromSlot === event.toSlot) continue;
    byCell.set(`${event.fromSlot}:${event.recordId}`, {
      slot: event.fromSlot,
      col: event.fromSlot % profile.cols,
      row: Math.floor(event.fromSlot / profile.cols),
      recordId: event.recordId,
      kind,
    });
  }
  return [...byCell.values()];
}

// Accumulate impressions across rebuilds. A record leaving the same cell again
// refreshes its existing impression instead of duplicating it; refreshed and
// new impressions move to the end so the latest one per cell renders on top.
export function mergeFieldTraces(previousTraces = [], newTraces = []) {
  const merged = new Map();
  for (const trace of [...previousTraces, ...newTraces]) {
    if (!trace || !Number.isInteger(trace.slot) || !trace.recordId) continue;
    const key = `${trace.slot}:${trace.recordId}`;
    merged.delete(key);
    merged.set(key, trace);
  }
  return [...merged.values()];
}

export function generateFieldViewModel(records, profile = fieldLayoutProfile, regions = [], traces = []) {
  const occupied = new Set();
  const latestRecordId = [...records]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.id;
  const fieldRecords = records.map((record) => {
    const hasPinnedSlot = Number.isInteger(record.layoutSlot);
    const preferredCol = Math.max(0, Math.min(profile.cols - 1, Math.floor(record.position.x * profile.cols)));
    const preferredRow = Math.max(0, Math.min(profile.rows - 1, Math.floor(record.position.y * profile.rows)));
    const preferredSlot = hasPinnedSlot ? record.layoutSlot : preferredRow * profile.cols + preferredCol;
    const slot = nearestOpenSlot(preferredSlot, occupied, profile);
    occupied.add(slot);

    return {
      id: record.id,
      slot,
      col: slot % profile.cols,
      row: Math.floor(slot / profile.cols),
      regionId: record.regionId,
      isLatest: record.id === latestRecordId,
    };
  });

  return {
    schemaVersion: regions.length > 0 ? 2 : 1,
    cols: profile.cols,
    rows: profile.rows,
    regions: regions.map((region) => ({
      ...region,
      seedCol: region.seedSlot % profile.cols,
      seedRow: Math.floor(region.seedSlot / profile.cols),
    })),
    records: fieldRecords,
    traces,
  };
}
