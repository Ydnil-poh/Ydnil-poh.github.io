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

// Traces mark cells a record vacated during the latest rebuild — the "written
// then erased" impressions the field carries. Only layout.moved_within_region
// events count, and only when the origin cell is now empty (a preserved tile
// sitting there would hide the trace anyway). The record still exists at its new
// slot, so its own texture can be rendered faded at the cell it left.
export function deriveFieldTraces(layoutEvents = [], occupiedSlots = new Set(), profile = fieldLayoutProfile) {
  const bySlot = new Map();
  for (const event of layoutEvents) {
    if (event?.eventType !== 'layout.moved_within_region') continue;
    if (!Number.isInteger(event.fromSlot)) continue;
    if (event.fromSlot === event.toSlot) continue;
    if (occupiedSlots.has(event.fromSlot)) continue;
    bySlot.set(event.fromSlot, event.recordId);
  }
  return [...bySlot].map(([slot, recordId]) => ({
    slot,
    col: slot % profile.cols,
    row: Math.floor(slot / profile.cols),
    recordId,
  }));
}

export function generateFieldViewModel(records, profile = fieldLayoutProfile, regions = [], layoutEvents = []) {
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
    traces: deriveFieldTraces(layoutEvents, occupied, profile),
  };
}
